import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { PUBLIC_DIR, SiteManifest, type SiteSource } from '@winpanel/shared';
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
  pruneFailedReleases,
  pruneOldReleases,
  runBuildSteps,
  waitForHealthy,
  type ToolPaths,
} from './deploy-pipeline.js';
import type { CaddyClient } from '../caddy/client.js';
import type { CaddyReconciler } from '../caddy/reconciler.js';
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
  /** Rebuilds Caddy's whole configuration from the database. */
  routing: CaddyReconciler;
  services: ServiceManager;
  tools: ToolPaths;
  gitPath: string;
  sitesRoot: string;
  /** Resolves a site's secrets from the vault. */
  loadEnv: (siteId: string) => Promise<Record<string, string>>;
  /** Git token for private repositories, if configured. */
  loadGitToken: (siteId: string) => Promise<string | undefined>;
  /** Deploy key for private repositories reached over SSH, if configured. */
  loadGitSshKey: (siteId: string) => Promise<string | undefined>;
  /** Where SSH host keys are pinned after the first connection. */
  sshKnownHostsPath?: string;
  /** How many previous releases to keep for rollback. */
  keepReleases?: number;
}

export function serviceIdFor(slug: string, colour: 'blue' | 'green'): string {
  return `winpanel-site-${slug}-${colour}`;
}

/** The release `current` points at, if it points anywhere. */
async function currentReleaseId(siteDir: string): Promise<string | null> {
  try {
    return path.basename(await fs.realpath(path.join(siteDir, 'current')));
  } catch {
    return null;
  }
}

/** The executable that runs a site of a given runtime. */
async function resolveRuntimeExecutable(
  deps: DeployDependencies,
  manifest: SiteManifest,
): Promise<{ exe: string; args: string[] }> {
  const entry = manifest.app.entry ?? (manifest.runtime === 'dotnet' ? undefined : 'index.js');

  if (manifest.runtime === 'dotnet') {
    if (!entry) {
      throw new DeploymentError(
        'This .NET website does not say which .dll to run. Set the entry file in its settings.',
      );
    }
    const dotnet = await deps.tools.resolve('dotnet');
    return { exe: dotnet.exe, args: [...dotnet.args, entry] };
  }

  const node = await deps.tools.resolve('node', manifest.nodeVersion ?? undefined);
  return { exe: node.exe, args: [...node.args, entry ?? 'index.js'] };
}

export function createDeployHandler(deps: DeployDependencies) {
  return async function handleDeploy(rawPayload: unknown, ctx: JobContext): Promise<void> {
    const payload = rawPayload as DeployPayload;

    const site = deps.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
    if (!site) throw new DeploymentError('That website no longer exists.');

    const source = site.source as SiteSource;

    /*
     * Sites the user manages themselves have no build and no releases: their
     * files sit in `public` and are already the live copy. "Deploying" one
     * means making the web server aware of it, and restarting its process if
     * it has one.
     */
    if (source.kind !== 'git' && !payload.uploadedReleaseDir) {
      await publishManagedSite(deps, site, ctx);
      return;
    }

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

      /*
       * Attempts that failed before this one kept their folders so their logs
       * could be read against them. One is worth keeping; a row of abandoned
       * `node_modules` trees is not, and the site most likely to accumulate
       * them is the one already having a bad day.
       */
      const failedBefore = deps.db.db
        .select({ releaseId: deployments.releaseId })
        .from(deployments)
        .where(and(eq(deployments.siteId, site.id), eq(deployments.status, 'failed')))
        .all()
        .map((row) => row.releaseId);

      const discarded = await pruneFailedReleases(releasesDir, failedBefore, {
        protect: [await currentReleaseId(siteDir)].filter((id): id is string => id !== null),
      });

      if (discarded.length > 0) {
        ctx.log(`Cleared ${discarded.length} folder(s) left by earlier failed attempts.`, 'debug');
      }

      // 1. Get the code.
      let commit: string | null = null;

      if (payload.uploadedReleaseDir) {
        ctx.log('Using the files you uploaded.');
        await fs.rename(payload.uploadedReleaseDir, releaseDir);
      } else {
        if (source.kind !== 'git') {
          throw new DeploymentError('This website has no repository configured.');
        }

        const ref = payload.ref ?? source.branch;
        ctx.log(`Downloading ${ref} from your repository\u2026`, 'info', 'download');

        const git = new GitClient({
          gitPath: deps.gitPath,
          token: await deps.loadGitToken(site.id),
          sshPrivateKey: await deps.loadGitSshKey(site.id),
          ...(deps.sshKnownHostsPath ? { knownHostsPath: deps.sshKnownHostsPath } : {}),
          onOutput: (line) => {
            // Belt and braces: a token should never reach the log, but git
            // occasionally echoes a URL back on error.
            if (line.trim()) ctx.log(redactSecrets(line), 'debug', 'download');
          },
        });

        commit = await git.cloneRelease(source.url, ref, releaseDir);

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

      /*
       * A static site has no process to start and nothing to health-check.
       * Publishing it is one atomic operation: repoint `current`, then tell
       * the web server where to look. Running it through the blue/green
       * machinery would mean starting a Node service that serves nothing.
       */
      if (manifest.runtime === 'static') {
        setStatus('switching');
        await pointCurrentAt(siteDir, releaseDir);

        ctx.log('Publishing your files\u2026', 'info', 'switch');
        await deps.routing.apply();

        deps.db.db
          .update(sites)
          .set({ updatedAt: new Date() })
          .where(eq(sites.id, site.id))
          .run();

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
        ctx.log('Done. Your website is live.');
        return;
      }

      // 4. Start the new version on the idle port.
      const appDir = path.join(releaseDir, manifest.app.cwd);
      const serviceId = serviceIdFor(site.slug, targetColour);

      ctx.log(`Starting the new version on port ${targetPort}\u2026`, 'info', 'start');

      const runtimeExe = await resolveRuntimeExecutable(deps, manifest);

      if (await deps.services.isInstalled(serviceId)) {
        await deps.services.uninstall(serviceId);
      }

      await deps.services.install({
        id: serviceId,
        displayName: `${site.displayName} (${targetColour})`,
        description: `Website: ${site.displayName}`,
        executable: runtimeExe.exe,
        args: runtimeExe.args,
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

      /*
       * The fast path patches a single upstream by `@id`. It fails if that id
       * is not in the running config — which is the normal state on a site's
       * very first deploy, and after Caddy has been restarted or reinstalled.
       *
       * Falling back to a full config load handles all of those. Only if that
       * fails too is the deploy genuinely unable to take traffic, and then the
       * new process is stopped so it is not left holding a port for nothing.
       */
      deps.db.db
        .update(sites)
        .set({ activeColour: targetColour, updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      try {
        await deps.caddy.switchUpstream(proxyIdFor(site.slug), targetPort);
      } catch {
        ctx.log('Rebuilding the web server configuration\u2026', 'debug', 'switch');

        try {
          await deps.routing.apply();
        } catch (error) {
          // Put the record back: traffic never moved.
          deps.db.db
            .update(sites)
            .set({ activeColour: site.activeColour })
            .where(eq(sites.id, site.id))
            .run();

          // The old version is still serving, so stop the new one rather than
          // leaving an orphan process holding a port.
          await deps.services.stop(serviceId).catch(() => undefined);
          throw new DeploymentError(
            'The new version started, but traffic could not be switched to it. ' +
              'Your site is still running the previous version. ' +
              (error instanceof Error ? error.message : ''),
          );
        }
      }

      await pointCurrentAt(siteDir, releaseDir);

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

type SiteRow = typeof sites.$inferSelect;

/**
 * Publishes a site whose files the user manages directly.
 *
 * There is no build, no clone and no release folder: `public` *is* the live
 * copy, and the panel must never move or overwrite it. All that is left is to
 * make sure the web server knows about the site, and — if the site runs a
 * process — that the process is running the current files.
 *
 * A static site is therefore published instantly and with no downtime at all.
 * A Node or .NET one is restarted in place rather than deployed blue/green:
 * both colours would be running out of the same folder, so there is no second
 * copy to switch to, and pretending otherwise would only add a second process
 * competing for the same files.
 */
async function publishManagedSite(
  deps: DeployDependencies,
  site: SiteRow,
  ctx: JobContext,
): Promise<void> {
  const manifest = SiteManifest.parse(site.manifest);
  const siteDir = path.join(deps.sitesRoot, site.slug);
  const publicDir = path.join(siteDir, PUBLIC_DIR);

  const deploymentId = crypto.randomUUID();
  deps.db.db
    .insert(deployments)
    .values({
      id: deploymentId,
      siteId: site.id,
      releaseId: PUBLIC_DIR,
      status: 'switching',
      targetColour: site.activeColour,
      jobId: ctx.jobId,
    })
    .run();

  const fail = (message: string): never => {
    deps.db.db
      .update(deployments)
      .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId))
      .run();
    throw new DeploymentError(message);
  };

  try {
    await fs.mkdir(publicDir, { recursive: true });

    if (manifest.runtime === 'node' || manifest.runtime === 'dotnet') {
      const port = site.activeColour === 'blue' ? site.portBlue : site.portGreen;
      if (port === null) {
        fail('This website has no port assigned yet. Remove and re-create it to fix this.');
        return;
      }

      const env = await deps.loadEnv(site.id);
      await fs.mkdir(path.join(siteDir, 'shared'), { recursive: true });
      await writeEnvFile(path.join(siteDir, 'shared'), env);

      const serviceId = serviceIdFor(site.slug, site.activeColour);
      const runtimeExe = await resolveRuntimeExecutable(deps, manifest);

      ctx.log(`Restarting your app on port ${port}\u2026`, 'info', 'start');

      if (await deps.services.isInstalled(serviceId)) {
        await deps.services.uninstall(serviceId);
      }

      await deps.services.install({
        id: serviceId,
        displayName: site.displayName,
        description: `Website: ${site.displayName}`,
        executable: runtimeExe.exe,
        args: runtimeExe.args,
        workingDirectory: path.join(publicDir, manifest.app.cwd),
        env: {
          ...env,
          [manifest.app.portEnvVar]: String(port),
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
        },
        logPath: path.join(siteDir, 'logs'),
      });

      await deps.services.start(serviceId);
      ctx.progress(60);

      await waitForHealthy({
        port,
        path: manifest.app.healthCheckPath,
        timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
        ctx,
      });
    }

    ctx.progress(85);
    ctx.log('Telling the web server about your site\u2026', 'info', 'switch');
    await deps.routing.apply();

    deps.db.db.update(sites).set({ updatedAt: new Date() }).where(eq(sites.id, site.id)).run();
    deps.db.db
      .update(deployments)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId))
      .run();

    ctx.progress(100);
    ctx.log('Done. Your website is live.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publishing failed.';
    deps.db.db
      .update(deployments)
      .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId))
      .run();
    throw error;
  }
}

/** Strips anything that looks like a credential out of log output. */
export function redactSecrets(line: string): string {
  return line
    .replace(/https:\/\/[^@\s]+@/gi, 'https://***@')
    .replace(/(gh[pousr]_[A-Za-z0-9]{16,})/g, '***')
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s]+/gi, '$1***');
}
