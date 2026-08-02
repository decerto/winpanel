import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { SiteManifest, type SiteSource } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { deployments, sites } from '../db/schema.js';
import type { JobContext } from '../jobs/queue.js';
import { detectApp } from '../detect/detector.js';
import { GitClient } from './git-client.js';
import {
  DeploymentError,
  newReleaseId,
  pointCurrentAt,
  pruneBuildArtifacts,
  pruneOldReleases,
  runBuildSteps,
  waitForHealthy,
  type ToolPaths,
} from './deploy-pipeline.js';
import type { CaddyClient } from '../caddy/client.js';
import { proxyIdFor } from '../caddy/config-builder.js';
import type { ServiceManager } from '../windows/service-manager.js';

/**
 * The deployment, start to finish.
 *
 * The ordering is what makes this safe: the new version is built into a fresh
 * folder, started on the *idle* port, and proved healthy there before any
 * traffic moves. Until the upstream switch, the live site has not been touched
 * — so a failed deploy is a failed deploy, not an outage.
 */

export interface DeployPayload {
  siteId: string;
  /** Overrides the site's configured branch for this deploy only. */
  ref?: string;
  /** Set when deploying from an uploaded archive already extracted here. */
  uploadedReleaseDir?: string;
}

export interface DeployDependencies {
  db: DatabaseHandle;
  caddy: CaddyClient;
  services: ServiceManager;
  tools: ToolPaths;
  gitPath: string;
  sitesRoot: string;
  /** Resolves a site's secrets from the vault. */
  loadEnv: (siteId: string) => Promise<Record<string, string>>;
  /** Git token for private repositories, if configured. */
  loadGitToken: (siteId: string) => Promise<string | undefined>;
  /** How many previous releases to keep for rollback. */
  keepReleases?: number;
}

export function serviceIdFor(slug: string, colour: 'blue' | 'green'): string {
  return `winpanel-site-${slug}-${colour}`;
}

export function createDeployHandler(deps: DeployDependencies) {
  return async function handleDeploy(rawPayload: unknown, ctx: JobContext): Promise<void> {
    const payload = rawPayload as DeployPayload;

    const site = deps.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
    if (!site) throw new DeploymentError('That website no longer exists.');

    if (site.portBlue === null || site.portGreen === null) {
      throw new DeploymentError(
        'This website has no ports assigned yet. Remove and re-create it to fix this.',
      );
    }

    // Deploy onto whichever colour is not currently serving traffic.
    const targetColour = site.activeColour === 'blue' ? 'green' : 'blue';
    const targetPort = targetColour === 'blue' ? site.portBlue : site.portGreen;

    const siteDir = path.join(deps.sitesRoot, site.slug);
    const releasesDir = path.join(siteDir, 'releases');
    const releaseId = newReleaseId();
    const releaseDir = path.join(releasesDir, releaseId);
    const sharedDir = path.join(siteDir, 'shared');

    const deploymentId = crypto.randomUUID();
    deps.db.db
      .insert(deployments)
      .values({
        id: deploymentId,
        siteId: site.id,
        releaseId,
        status: 'preparing',
        targetColour,
        jobId: ctx.jobId,
      })
      .run();

    const setStatus = (status: string, errorMessage?: string): void => {
      deps.db.db
        .update(deployments)
        .set({
          status,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          ...(status === 'succeeded' || status === 'failed'
            ? { finishedAt: new Date() }
            : {}),
        })
        .where(eq(deployments.id, deploymentId))
        .run();
    };

    try {
      await fs.mkdir(releasesDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });

      // 1. Get the code.
      let commit: string | null = null;

      if (payload.uploadedReleaseDir) {
        ctx.log('Using the files you uploaded.');
        await fs.rename(payload.uploadedReleaseDir, releaseDir);
      } else {
        const source = site.source as SiteSource;
        if (source.kind !== 'git') {
          throw new DeploymentError('This website has no repository configured.');
        }

        const ref = payload.ref ?? source.branch;
        ctx.log(`Downloading ${ref} from your repository\u2026`, 'info', 'download');

        const git = new GitClient({
          gitPath: deps.gitPath,
          token: await deps.loadGitToken(site.id),
          onOutput: (line) => {
            // Belt and braces: a token should never reach the log, but git
            // occasionally echoes a URL back on error.
            if (line.trim()) ctx.log(redactSecrets(line), 'debug', 'download');
          },
        });

        await git.cloneRelease(source.url, ref, releaseDir);
        commit = await git.headCommit(releaseDir);

        if (source.subdirectory) {
          const inner = path.join(releaseDir, source.subdirectory);
          try {
            await fs.access(inner);
          } catch {
            throw new DeploymentError(
              `The folder "${source.subdirectory}" does not exist in this repository.`,
            );
          }
        }
      }

      ctx.throwIfCancelled();
      ctx.progress(20);

      // 2. Work out how to build it, unless we already know.
      let manifest = SiteManifest.parse(site.manifest);

      const detection = await detectApp(releaseDir);
      if (detection.fromManifestFile) {
        ctx.log('Using the settings committed in your project.');
        manifest = detection.manifest;
      }

      // 3. Make the site's secrets available to the build and the app.
      const env = await deps.loadEnv(site.id);
      await writeEnvFile(sharedDir, env);

      setStatus('building');
      await runBuildSteps({ manifest, releaseDir, tools: deps.tools, ctx, env });

      await pruneBuildArtifacts(releaseDir, manifest, ctx);
      ctx.throwIfCancelled();

      // 4. Start the new version on the idle port.
      const appDir = path.join(releaseDir, manifest.app.cwd);
      const serviceId = serviceIdFor(site.slug, targetColour);

      ctx.log(`Starting the new version on port ${targetPort}\u2026`, 'info', 'start');

      const nodeExe = await deps.tools.resolve('node', manifest.nodeVersion ?? undefined);
      const entry = manifest.app.entry ?? 'index.js';

      if (await deps.services.isInstalled(serviceId)) {
        await deps.services.uninstall(serviceId);
      }

      await deps.services.install({
        id: serviceId,
        displayName: `${site.displayName} (${targetColour})`,
        description: `Website: ${site.displayName}`,
        executable: nodeExe,
        args: [entry],
        // For the frontend-builds-into-backend layout this is the backend
        // folder, not the repository root.
        workingDirectory: appDir,
        env: {
          ...env,
          [manifest.app.portEnvVar]: String(targetPort),
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
        },
        logPath: path.join(siteDir, 'logs'),
      });

      await deps.services.start(serviceId);

      setStatus('healthchecking');
      ctx.progress(80);

      // 5. Prove it works before sending it any traffic.
      await waitForHealthy({
        port: targetPort,
        path: manifest.app.healthCheckPath,
        timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
        ctx,
      });

      // 6. Switch traffic across. One call, no reload, no dropped requests.
      setStatus('switching');
      ctx.log('Switching visitors to the new version\u2026', 'info', 'switch');

      try {
        await deps.caddy.switchUpstream(proxyIdFor(site.slug), targetPort);
      } catch (error) {
        // The old version is still serving, so stop the new one rather than
        // leaving an orphan process holding a port.
        await deps.services.stop(serviceId).catch(() => undefined);
        throw new DeploymentError(
          'The new version started, but traffic could not be switched to it. ' +
            'Your site is still running the previous version.',
        );
      }

      await pointCurrentAt(siteDir, releaseDir);

      deps.db.db
        .update(sites)
        .set({ activeColour: targetColour, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      // 7. Stop the old version, now that nothing is using it.
      const oldServiceId = serviceIdFor(site.slug, site.activeColour);
      if (await deps.services.isInstalled(oldServiceId)) {
        ctx.log('Stopping the previous version.', 'debug');
        await deps.services.stop(oldServiceId).catch(() => undefined);
      }

      const removed = await pruneOldReleases(releasesDir, deps.keepReleases ?? 5, releaseId);
      if (removed.length > 0) {
        ctx.log(`Cleaned up ${removed.length} old release(s).`, 'debug');
      }

      deps.db.db
        .update(deployments)
        .set({ commit, status: 'succeeded', finishedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
        .run();

      ctx.progress(100);
      ctx.log('Done. Your website is live on the new version.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The deployment failed.';
      setStatus('failed', message);

      // Leave the release folder in place: it is the only evidence of what
      // went wrong, and disk is cheaper than a lost diagnosis.
      ctx.log('The previous version is still running and was not affected.', 'info');
      throw error;
    }
  };
}

/** Writes the site's environment file into the shared folder. */
async function writeEnvFile(sharedDir: string, env: Record<string, string>): Promise<void> {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(path.join(sharedDir, '.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** Strips anything that looks like a credential out of log output. */
export function redactSecrets(line: string): string {
  return line
    .replace(/https:\/\/[^@\s]+@/gi, 'https://***@')
    .replace(/(gh[pousr]_[A-Za-z0-9]{16,})/g, '***')
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s]+/gi, '$1***');
}
