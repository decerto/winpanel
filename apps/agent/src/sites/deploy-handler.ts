import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { PUBLIC_DIR, SHARED_DIR, SiteManifest, type SiteSource } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { deployments, sites } from '../db/schema.js';
import type { JobContext } from '../jobs/queue.js';
import { detectApp, detectEntryPoint } from '../detect/detector.js';
import { GitClient } from './git-client.js';
import {
  DeploymentError,
  discardPrevious,
  explainRuntimeFailure,
  newReleaseId,
  prepareStaging,
  promoteStaging,
  pruneBuildArtifacts,
  releaseFoldersFor,
  removeLegacyLayout,
  restorePrevious,
  runBuildSteps,
  waitForHealthy,
  type ReleaseFolders,
  type ToolPaths,
} from './deploy-pipeline.js';
import type { CaddyClient } from '../caddy/client.js';
import type { CaddyReconciler } from '../caddy/reconciler.js';
import { previewProxyIdFor, proxyIdFor } from '../caddy/config-builder.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { siteServiceId } from '../windows/panel-services.js';
import { clearStrayListeners, describeHolder } from '../windows/stray-processes.js';
import { findExecutable } from '../components/archive.js';
import { writePhpIni, waitForPhpPool } from './php.js';
import { PHP_POOL_SIZE } from '@winpanel/shared';

/**
 * The deployment, start to finish.
 *
 * A site has one code folder, `release/`, and it never moves. The new version
 * is cloned and built in a staging folder first, so a build that fails cannot
 * touch what is currently serving; only once it has built is the running app
 * stopped, the folders swapped, and the app started again. If it then fails to
 * answer, the outgoing version — moved aside, not deleted — goes straight back.
 */

export interface DeployPayload {
  siteId: string;
  /** Overrides the site's configured branch for this deploy only. */
  ref?: string;
  /** Set when deploying from an uploaded archive already extracted here. */
  uploadedReleaseDir?: string;
  /**
   * Who pressed the button, and therefore whose access token is used.
   * A deploy with nobody behind it can only reach a public repository or one
   * the website's own deploy key opens.
   */
  actorUserId?: string;
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
  /** The panel's own program folder, where installed components live. */
  binDir: string;
  /** Resolves a site's secrets from the vault. */
  loadEnv: (siteId: string) => Promise<Record<string, string>>;
  /** Git token for private repositories, belonging to whoever is deploying. */
  loadGitToken: (siteId: string, userId: string | undefined) => Promise<string | undefined>;
  /** Deploy key for private repositories reached over SSH, if configured. */
  loadGitSshKey: (siteId: string) => Promise<string | undefined>;
  /** Where SSH host keys are pinned after the first connection. */
  sshKnownHostsPath?: string;
}

export function serviceIdFor(slug: string, colour: 'blue' | 'green'): string {
  return siteServiceId(slug, colour);
}

/** The startup file the user set, treating a cleared field as nothing at all. */
function configuredEntry(manifest: SiteManifest): string | undefined {
  return manifest.app.entry?.trim() ? manifest.app.entry : undefined;
}

async function isFile(candidate: string): Promise<boolean> {
  return fs
    .stat(candidate)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

/**
 * Forgives a startup file that repeats the application root.
 *
 * The field is measured from the application root, so `server/app.js` with an
 * application root of `server` means `server/server/app.js`. Writing it that
 * way is the most natural mistake there is - it is how the file browser and
 * the Files tab both spell it - and the file it was meant to name is right
 * there, so it is taken as read rather than refused.
 *
 * Only ever strips when the shorter path exists and the literal one does not,
 * so a project that genuinely nests `server/server/app.js` is untouched.
 */
export async function normaliseEntry(
  entry: string,
  appDir: string,
  appRoot: string,
): Promise<string> {
  const clean = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = appRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!root || !clean.startsWith(`${root}/`)) return clean;

  const stripped = clean.slice(root.length + 1);
  if (!stripped) return clean;

  if (await isFile(path.join(appDir, clean))) return clean;
  return (await isFile(path.join(appDir, stripped))) ? stripped : clean;
}

/** The executable that runs a site of a given runtime. */
async function resolveRuntimeExecutable(
  deps: DeployDependencies,
  manifest: SiteManifest,
): Promise<{ exe: string; args: string[] }> {
  const entry = configuredEntry(manifest) ?? (manifest.runtime === 'dotnet' ? undefined : 'index.js');

  if (manifest.runtime === 'dotnet') {
    if (!entry) {
      throw new DeploymentError(
        'This .NET website does not say which .dll to run. Set the entry file in its settings.',
      );
    }
    const dotnet = await deps.tools.resolve('dotnet');
    return { exe: dotnet.exe, args: [...dotnet.args, entry] };
  }

  if (manifest.runtime === 'php') {
    /*
     * PHP sites are run by the pool supervisor, a small Node script, rather
     * than by php-cgi directly: one php-cgi serves one request at a time, so
     * the supervisor keeps a pool of them alive and the web server shares
     * requests across them. The script ships inside the PHP component, so
     * this fails with a clear message until PHP is installed.
     */
    const poolScript = path.join(deps.binDir, 'php', 'pool.js');
    if (!(await isFile(poolScript))) {
      throw new DeploymentError(
        'PHP is not installed on this server yet. Ask an administrator to install it, then deploy again.',
      );
    }
    const node = await deps.tools.resolve('node');
    return { exe: node.exe, args: [...node.args, poolScript] };
  }

  const node = await deps.tools.resolve('node', manifest.nodeVersion ?? undefined);
  return { exe: node.exe, args: [...node.args, entry ?? 'index.js'] };
}

/**
 * The environment a site's service runs with.
 *
 * Node and .NET get the production defaults a hosted app expects. PHP does
 * not: `NODE_ENV` means nothing to it, and its pool is configured through its
 * own variables instead — where php-cgi is, which port to start from, and the
 * web root. The site's own variables reach both kinds.
 */
export async function phpServiceEnv(
  deps: Pick<DeployDependencies, 'binDir' | 'sitesRoot'>,
  site: { slug: string },
  basePort: number,
  documentRoot: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const phpDir = path.join(deps.binDir, 'php');
  const cgiExe = await findExecutable(phpDir, ['php-cgi.exe']);
  if (!cgiExe) {
    throw new DeploymentError(
      'PHP is not installed on this server yet. Ask an administrator to install it, then deploy again.',
    );
  }

  // A php.ini written per site, pointing at the extensions beside the
  // php-cgi.exe that will actually run — derived from the exe's own location,
  // so the zip's folder layout (which puts everything under `bin`) cannot
  // leave it pointing at the wrong place.
  const iniPath = path.join(deps.sitesRoot, site.slug, 'logs', 'php.ini');
  await writePhpIni(iniPath, path.dirname(cgiExe));

  return {
    ...env,
    PHP_CGI_EXE: cgiExe,
    PHP_BASE_PORT: String(basePort),
    PHP_DOC_ROOT: documentRoot,
    PHP_INI: iniPath,
    PHP_POOL_SIZE: String(PHP_POOL_SIZE),
  };
}

/**
 * Says what is wrong with the startup file, or nothing if it is fine.
 *
 * Checked in staging, before anything is swapped: without this the mistake
 * only surfaces once the live version has been stopped and the new one has
 * failed to start, naming `index.js` - the fallback used when nothing was
 * configured, not anything the user ever typed.
 */
export async function entryFileProblem(
  manifest: SiteManifest,
  stagingDir: string,
): Promise<string | null> {
  const appDir = path.join(stagingDir, manifest.app.cwd);
  const configured = configuredEntry(manifest);
  // .NET reports a missing entry elsewhere; PHP has no startup file at all —
  // its front controller is always index.php, so there is nothing to validate.
  const entry = configured ?? (manifest.runtime === 'node' ? 'index.js' : null);
  if (!entry) return null;

  try {
    await fs.access(path.join(appDir, entry));
    return null;
  } catch {
    // Reported below, with the context this catch does not have.
  }

  const where = manifest.app.cwd ? `the ${manifest.app.cwd} folder` : 'the project root';
  const suggestion = await detectEntryPoint(appDir);
  const hint = suggestion ? ` It looks like it should be "${suggestion}".` : '';

  return configured
    ? `The startup file "${entry}" is not in ${where}, so there is nothing to run. Set the ` +
        'startup file on the Application page, written relative to the application root.' +
        hint
    : `This website does not say which file starts it, and there is no index.js in ${where}. ` +
        'Set the startup file on the Application page, written relative to the application ' +
        'root.' + hint;
}

/** Whether a previous version is serving right now, and would be lost. */
async function isServing(
  deps: DeployDependencies,
  serviceId: string,
  folders: ReleaseFolders,
): Promise<boolean> {
  if (!(await deps.services.isInstalled(serviceId))) return false;

  try {
    return (await fs.readdir(folders.release)).length > 0;
  } catch {
    return false;
  }
}

/** The last few lines of a file, without reading a log that has grown huge. */
async function tailLines(file: string, count: number): Promise<string[]> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return [];

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 16 * 1024);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);

    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-count);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Copies what the app itself printed into the deployment log.
 *
 * Until this existed, "check the deployment log above for errors from your
 * app" named a log that could not possibly contain them. Everything the
 * process writes goes to its service log under the site's `logs` folder,
 * which nothing in the panel surfaces — so a deploy whose health check timed
 * out told the user only that nothing was listening, while the reason it was
 * not listening sat in a file they had no way to open. A start that fails is
 * precisely when those lines are the whole answer.
 */
export async function reportAppOutput(
  siteDir: string,
  serviceId: string,
  ctx: JobContext,
): Promise<void> {
  const logDir = path.join(siteDir, 'logs');
  let reported = false;

  for (const [suffix, label] of [
    ['err', 'errors'],
    ['out', 'output'],
  ] as const) {
    const file = path.join(logDir, `${serviceId}.${suffix}.log`);
    const lines = await tailLines(file, 20);
    if (lines.length === 0) continue;

    reported = true;
    ctx.log(`The last ${label} your app wrote:`, 'warn', 'start');
    for (const line of lines) ctx.log(redactSecrets(line), 'error', 'start');
  }

  if (!reported) {
    ctx.log(
      'Your app wrote nothing to its own log, so it never got as far as running its ' +
        'startup file.',
      'warn',
      'start',
    );
  }
}

/**
 * Makes the port genuinely free before anything is started on it.
 *
 * Without this the health check is not a check at all. It asks whether
 * *something* answers on the port, so a previous copy of the site that the
 * service manager lost track of answers on the new version's behalf: the
 * deploy is declared healthy, the web server goes on proxying to the old
 * process, and every deploy after that repeats the trick. The site looks
 * perfectly well from outside while the panel reports it stopped and the code
 * that is actually serving is however many releases old.
 *
 * A process of ours on our own port is ended. Anything else is refused rather
 * than killed — the panel allocated the port, but it does not own the machine,
 * and quietly proxying a customer's website to a stranger's program is a worse
 * outcome than a deploy that stops and explains itself.
 */
async function claimPort(port: number, executable: string, ctx: JobContext): Promise<void> {
  const { killed, foreign } = await clearStrayListeners([port], [path.basename(executable)]);

  if (killed.length > 0) {
    ctx.log(
      `Port ${port} was still held by an earlier copy of this website ` +
        `(${killed.map(describeHolder).join(', ')}). It has been ended.`,
      'warn',
    );
  }

  if (foreign.length > 0) {
    throw new DeploymentError(
      `Port ${port} is in use by ${foreign.map(describeHolder).join(', ')}, which is not part ` +
        'of this website. The panel will not end another program to take its port. Close that ' +
        'program, then deploy again.',
    );
  }
}

export function createDeployHandler(deps: DeployDependencies) {
  return async function handleDeploy(rawPayload: unknown, ctx: JobContext): Promise<void> {
    const payload = rawPayload as DeployPayload;

    const site = deps.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
    if (!site) throw new DeploymentError('That website no longer exists.');

    const source = site.source as SiteSource;

    /*
     * Sites the user manages themselves have no build: their files sit in
     * `public` and are already the live copy. "Deploying" one means making the
     * web server aware of it, and restarting its process if it has one.
     */
    if (source.kind !== 'git' && !payload.uploadedReleaseDir) {
      await publishManagedSite(deps, site, ctx);
      return;
    }

    const colour = site.activeColour;
    const targetPort = colour === 'blue' ? site.portBlue : site.portGreen;

    const siteDir = path.join(deps.sitesRoot, site.slug);
    const folders = releaseFoldersFor(siteDir);
    const sharedDir = path.join(siteDir, SHARED_DIR);
    const serviceId = serviceIdFor(site.slug, colour);
    // Not a folder name any more, just a label for the deployment history.
    const releaseId = newReleaseId();

    const deploymentId = crypto.randomUUID();
    deps.db.db
      .insert(deployments)
      .values({
        id: deploymentId,
        siteId: site.id,
        releaseId,
        status: 'preparing',
        targetColour: colour,
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

    /*
     * Whether the folder the site serves from still holds the version that was
     * there before this deploy started. It stops being true the moment staging
     * is promoted, and becomes true again only if a rollback succeeds — which
     * is the difference between "nothing changed" and "your site is down".
     */
    let liveIsPrevious = true;

    try {
      await fs.mkdir(sharedDir, { recursive: true });

      /*
       * Whatever is in staging belongs to the last attempt. Building on top of
       * it would resurrect files the repository has since deleted, and the
       * only reason it survived at all was so its output could be inspected.
       */
      await prepareStaging(folders);

      // 1. Get the code.
      let commit: string | null = null;

      if (payload.uploadedReleaseDir) {
        ctx.log('Using the files you uploaded.');
        await fs.rename(payload.uploadedReleaseDir, folders.staging);
      } else {
        if (source.kind !== 'git') {
          throw new DeploymentError('This website has no repository configured.');
        }

        const ref = payload.ref ?? source.branch;
        ctx.log(`Downloading ${ref} from your repository\u2026`, 'info', 'download');

        const git = new GitClient({
          gitPath: deps.gitPath,
          token: await deps.loadGitToken(site.id, payload.actorUserId),
          sshPrivateKey: await deps.loadGitSshKey(site.id),
          ...(deps.sshKnownHostsPath ? { knownHostsPath: deps.sshKnownHostsPath } : {}),
          onOutput: (line) => {
            if (!line.trim() || isProgressNoise(line)) return;
            // Belt and braces: a token should never reach the log, but git
            // occasionally echoes a URL back on error.
            ctx.log(redactSecrets(line), 'debug', 'download');
          },
        });

        commit = await git.cloneRelease(source.url, ref, folders.staging);

        if (source.subdirectory) {
          const inner = path.join(folders.staging, source.subdirectory);
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

      const detection = await detectApp(folders.staging);
      if (detection.fromManifestFile) {
        ctx.log('Using the settings committed in your project.');
        manifest = detection.manifest;
      }

      const entry = configuredEntry(manifest);
      if (entry) {
        const corrected = await normaliseEntry(
          entry,
          path.join(folders.staging, manifest.app.cwd),
          manifest.app.cwd,
        );

        if (corrected !== entry) {
          manifest = { ...manifest, app: { ...manifest.app, entry: corrected } };
          ctx.log(
            `The startup file is measured from the application root, so "${entry}" was read ` +
              `as "${corrected}".`,
          );

          // Kept, so the Application page stops showing the longer spelling.
          if (!detection.fromManifestFile) {
            deps.db.db
              .update(sites)
              .set({ manifest, updatedAt: new Date() })
              .where(eq(sites.id, site.id))
              .run();
          }
        }
      }

      // 3. Make the site's secrets available to the build and the app.
      const env = await deps.loadEnv(site.id);
      await writeEnvFile(siteDir, env);

      setStatus('building');
      await runBuildSteps({ manifest, releaseDir: folders.staging, tools: deps.tools, ctx, env });

      await pruneBuildArtifacts(folders.staging, manifest, ctx);
      ctx.throwIfCancelled();

      /*
       * A static site has no process to start and nothing to health-check, so
       * nothing is holding `release/` open: the swap is the whole deploy.
       */
      if (manifest.runtime === 'static') {
        setStatus('switching');
        ctx.log('Publishing your files\u2026', 'info', 'switch');

        // A site that used to run a process still has one holding `release/`
        // open, and Windows will not rename a folder out from under it.
        if (await deps.services.isInstalled(serviceId)) {
          await deps.services.uninstall(serviceId).catch(() => undefined);
        }

        await promoteStaging(folders);
        await deps.routing.apply();
        await discardPrevious(folders);
        await cleanUpLegacyLayout(siteDir, ctx);

        deps.db.db
          .update(sites)
          .set({ updatedAt: new Date() })
          .where(eq(sites.id, site.id))
          .run();

        /*
         * The folder to serve often only exists once the build has run, so it
         * cannot honestly be confirmed until now. The files are published
         * either way: the user can open the file manager, see where the build
         * actually put them, and correct the document root.
         */
        const documentRoot = path.join(folders.release, manifest.staticRoot ?? '');
        const documentRootExists = await fs
          .stat(documentRoot)
          .then((stat) => stat.isDirectory())
          .catch(() => false);

        if (!documentRootExists) {
          const where = manifest.staticRoot || 'the project root';
          const problem =
            `Your files were published, but there is no "${where}" folder to serve. Open the ` +
            'Files tab to see where the build put them, then set the document root on the ' +
            'Application page.';

          deps.db.db
            .update(deployments)
            .set({ commit, status: 'needs-setup', errorMessage: problem, finishedAt: new Date() })
            .where(eq(deployments.id, deploymentId))
            .run();

          ctx.progress(100);
          ctx.log(problem, 'info');
          return;
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

      if (targetPort === null) {
        throw new DeploymentError(
          'This website has no port assigned yet. Remove and re-create it to fix this.',
        );
      }

      // Still in staging: the running version has not been touched yet.
      const entryProblem = await entryFileProblem(manifest, folders.staging);
      if (entryProblem) {
        /*
         * Nobody can name a startup file for a project they have not seen. On
         * a first deploy there is nothing serving to protect, so the files are
         * published anyway: the user opens the file manager, sees what is
         * actually there, sets the startup file, and deploys again. Failing
         * here instead would leave them with nothing to look at.
         */
        if (!(await isServing(deps, serviceId, folders))) {
          setStatus('switching');
          ctx.log('Publishing your files so you can look at them\u2026', 'info', 'switch');

          await promoteStaging(folders);
          liveIsPrevious = false;
          await discardPrevious(folders);
          await cleanUpLegacyLayout(siteDir, ctx);

          deps.db.db
            .update(sites)
            .set({ updatedAt: new Date() })
            .where(eq(sites.id, site.id))
            .run();

          deps.db.db
            .update(deployments)
            .set({
              commit,
              status: 'needs-setup',
              errorMessage: entryProblem,
              finishedAt: new Date(),
            })
            .where(eq(deployments.id, deploymentId))
            .run();

          ctx.progress(100);
          ctx.log('Your files are here, but the site is not running yet.', 'info');
          ctx.log(entryProblem, 'info');
          ctx.log(
            'Open the Files tab to see what was downloaded, set the startup file on the ' +
              'Application page, then deploy again.',
            'info',
          );
          return;
        }

        throw new DeploymentError(entryProblem);
      }

      /*
       * 4. Swap the new version into place.
       *
       * The running app has files in `release/` open, and Windows will not
       * rename a folder out from under it, so it has to stop first. This is
       * the only moment of the deploy where the site is down, and it lasts as
       * long as two renames plus a service start.
       */
      setStatus('switching');

      const wasInstalled = await deps.services.isInstalled(serviceId);
      if (wasInstalled) {
        ctx.log('Stopping the running version\u2026', 'info', 'switch');
        await deps.services.stop(serviceId).catch(() => undefined);
      }

      await promoteStaging(folders);
      liveIsPrevious = false;

      // 5. Start it.
      // For the frontend-builds-into-backend layout this is the backend
      // folder, not the repository root.
      const appDir = path.join(folders.release, manifest.app.cwd);
      ctx.log(`Starting the new version on port ${targetPort}\u2026`, 'info', 'start');

      const runtimeExe = await resolveRuntimeExecutable(deps, manifest);

      /*
       * 6. Register it, start it, and prove it works.
       *
       * All three roll back together. Starting used to sit outside this, so a
       * build that compiled but could not run left the new code in `release/`,
       * the service stopped, and the deploy log claiming the site was still on
       * the version it had before — while it was in fact down.
       */
      try {
        if (wasInstalled) await deps.services.uninstall(serviceId);

        await claimPort(targetPort, runtimeExe.exe, ctx);

        const serviceEnv =
          manifest.runtime === 'php'
            ? await phpServiceEnv(deps, site, targetPort, appDir, env)
            : {
                ...env,
                [manifest.app.portEnvVar]: String(targetPort),
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
              };

        await deps.services.install({
          id: serviceId,
          displayName: site.displayName,
          description: `Website: ${site.displayName}`,
          executable: runtimeExe.exe,
          args: runtimeExe.args,
          workingDirectory: appDir,
          env: serviceEnv,
          logPath: path.join(siteDir, 'logs'),
        });

        await deps.services.start(serviceId);

        setStatus('healthchecking');
        ctx.progress(80);

        // PHP workers speak FastCGI, not HTTP, so the HTTP health check can
        // never pass against them; a TCP connect per worker is the proof the
        // pool came up.
        if (manifest.runtime === 'php') {
          await waitForPhpPool({
            basePort: targetPort,
            timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
            log: (message) => ctx.log(message),
          });
        } else {
          await waitForHealthy({
            port: targetPort,
            path: manifest.app.healthCheckPath,
            timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
            ctx,
          });
        }
      } catch (error) {
        /*
         * One retry before rolling anything back. The likeliest reason a
         * service starts and then fails its health check is that its own last
         * process never let the port go, so the new one died on EADDRINUSE a
         * second after Windows reported it started. Restarting goes through
         * stop+start, which clears that orphan and proves the result — and is
         * far cheaper than tearing down a deploy that was otherwise fine.
         */
        ctx.log(
          'The new version did not answer. Restarting it once in case its own previous ' +
            'process was still holding the port…',
          'warn',
          'start',
        );

        const retried = await deps.services
          .restart(serviceId)
          .then(async () => {
            if (manifest.runtime === 'php') {
              await waitForPhpPool({
                basePort: targetPort,
                timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
                log: (message) => ctx.log(message),
              });
            } else {
              await waitForHealthy({
                port: targetPort,
                path: manifest.app.healthCheckPath,
                timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
                ctx,
              });
            }
            return true;
          })
          .catch((retryError: unknown) => {
            /*
             * Said out loud rather than swallowed. This is where the service
             * manager reports a port it could not free or the line the app
             * died on, and discarding it left the deploy blaming the health
             * check for a failure it had already diagnosed.
             */
            ctx.log(
              'It did not come up the second time either: ' +
                redactSecrets(
                  retryError instanceof Error ? retryError.message : String(retryError),
                ),
              'warn',
              'start',
            );
            return false;
          });

        if (!retried) {
          await reportAppOutput(siteDir, serviceId, ctx);
          if (await rollBack(deps, { folders, serviceId, ctx })) liveIsPrevious = true;

          const message = error instanceof Error ? error.message : String(error);
          const hint = explainRuntimeFailure(message, manifest.packageManager);
          throw hint ? new DeploymentError(`${message}\n\n${hint}`) : error;
        }
      }

      /*
       * 7. Make sure the web server knows where to send traffic.
       *
       * The port has not changed, so on any deploy but the first this is
       * already correct. The fast path patches the single upstream by `@id`
       * and fails if that id is not in the running config — which is exactly
       * the first-deploy case, and the case after Caddy has been reinstalled.
       */
      setStatus('switching');

      try {
        await deps.caddy.switchUpstream(proxyIdFor(site.slug), targetPort);
        await deps.caddy
          .switchUpstream(previewProxyIdFor(site.slug), targetPort)
          .catch(() => undefined);
      } catch (error) {
        ctx.log(
          `Could not switch the upstream directly: ${error instanceof Error ? error.message : String(error)}`,
          'debug',
          'switch',
        );
        ctx.log('Rebuilding the web server configuration\u2026', 'debug', 'switch');

        try {
          await deps.routing.apply();
        } catch (error) {
          if (await rollBack(deps, { folders, serviceId, ctx })) liveIsPrevious = true;
          throw new DeploymentError(
            'The new version started, but the web server could not be pointed at it. ' +
              'The previous version has been put back. ' +
              (error instanceof Error ? error.message : ''),
          );
        }
      }

      deps.db.db
        .update(sites)
        .set({ updatedAt: new Date() })
        .where(eq(sites.id, site.id))
        .run();

      await discardPrevious(folders);
      await cleanUpLegacyLayout(siteDir, ctx);

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

      // The staged build is left where it is: it is the only evidence of what
      // went wrong, it is hidden from the file manager, and the next deploy
      // clears it before it starts.
      ctx.log(
        liveIsPrevious
          ? 'Your site was left running the version it had before.'
          : 'Your site is NOT running: the new version is in place but would not start, and ' +
            'there was no previous version to go back to. Fix the problem and deploy again.',
        liveIsPrevious ? 'info' : 'error',
      );
      throw error;
    }
  };
}

/**
 * Puts the previous version back after the new one failed to run.
 *
 * The new process has to stop before its folder can be moved, and the service
 * definition is unchanged — same id, same port, same working directory — so
 * starting it again is all it takes to have the old version serving.
 *
 * Returns whether the live folder now holds the previous version, which is
 * what decides whether the deploy can honestly say the site is still up.
 */
async function rollBack(
  deps: DeployDependencies,
  options: { folders: ReleaseFolders; serviceId: string; ctx: JobContext },
): Promise<boolean> {
  const { folders, serviceId, ctx } = options;

  await deps.services.stop(serviceId).catch(() => undefined);

  let restored = false;
  try {
    restored = await restorePrevious(folders);
  } catch (error) {
    ctx.log(
      `The previous version could not be put back: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }

  if (!restored) {
    /*
     * The stop above was the deploy's doing, not the user's. Left on the
     * record as a deliberate stop it would tell the watchdog, the health page
     * and the outage emails that this site is down on purpose — so a site
     * that is genuinely down would be supervised by nothing at all.
     */
    deps.services.markIntentionallyStarted(serviceId);
    return false;
  }

  ctx.log('Put the previous version back.', 'info');
  await deps.services.start(serviceId).catch(() => undefined);
  return true;
}

/** Clears the timestamped folders sites created before this layout existed. */
async function cleanUpLegacyLayout(siteDir: string, ctx: JobContext): Promise<void> {
  if (await removeLegacyLayout(siteDir)) {
    ctx.log('Removed the old timestamped release folders.', 'debug');
  }
}

/**
 * Writes the site's environment file at the site root.
 *
 * Deliberately NOT in `shared/`, where it used to live: that folder is now
 * published at `/shared`, and this file holds every secret the site has.
 * Caddy refuses any dot-segment under that prefix, but a secret that is not
 * in a web root at all cannot be leaked by a mistake in a matcher. Any copy
 * left in the old location by an earlier version is deleted.
 */
async function writeEnvFile(siteDir: string, env: Record<string, string>): Promise<void> {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(path.join(siteDir, '.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.rm(path.join(siteDir, SHARED_DIR, '.env'), { force: true });
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
 * A Node or .NET one is restarted in place, because `public` is the only copy
 * of the files and there is nothing to swap.
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

    if (
      manifest.runtime === 'node' ||
      manifest.runtime === 'dotnet' ||
      manifest.runtime === 'php'
    ) {
      const port = site.activeColour === 'blue' ? site.portBlue : site.portGreen;
      if (port === null) {
        fail('This website has no port assigned yet. Remove and re-create it to fix this.');
        return;
      }

      const env = await deps.loadEnv(site.id);
      await fs.mkdir(path.join(siteDir, SHARED_DIR), { recursive: true });
      await writeEnvFile(siteDir, env);

      const serviceId = serviceIdFor(site.slug, site.activeColour);
      const runtimeExe = await resolveRuntimeExecutable(deps, manifest);

      ctx.log(`Restarting your app on port ${port}\u2026`, 'info', 'start');

      if (await deps.services.isInstalled(serviceId)) {
        await deps.services.uninstall(serviceId);
      }

      await claimPort(port, runtimeExe.exe, ctx);

      const documentRoot = path.join(publicDir, manifest.app.cwd);
      const serviceEnv =
        manifest.runtime === 'php'
          ? await phpServiceEnv(deps, site, port, documentRoot, env)
          : {
              ...env,
              [manifest.app.portEnvVar]: String(port),
              NODE_ENV: 'production',
              HOST: '127.0.0.1',
            };

      await deps.services.install({
        id: serviceId,
        displayName: site.displayName,
        description: `Website: ${site.displayName}`,
        executable: runtimeExe.exe,
        args: runtimeExe.args,
        workingDirectory: documentRoot,
        env: serviceEnv,
        logPath: path.join(siteDir, 'logs'),
      });

      await deps.services.start(serviceId);
      ctx.progress(60);

      try {
        // PHP speaks FastCGI, not HTTP — a TCP connect per worker, not a page fetch.
        if (manifest.runtime === 'php') {
          await waitForPhpPool({
            basePort: port,
            timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
            log: (message) => ctx.log(message),
          });
        } else {
          await waitForHealthy({
            port,
            path: manifest.app.healthCheckPath,
            timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
            ctx,
          });
        }
      } catch (error) {
        await reportAppOutput(siteDir, serviceId, ctx);
        throw error;
      }
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

/**
 * Whether a line is one frame of a git progress bar.
 *
 * Git redraws these with a carriage return for a terminal that overwrites the
 * line in place; a log that only appends turns a single clone into a hundred
 * near-identical lines, burying the one message that matters. The final frame
 * says "done", and that one is kept.
 */
export function isProgressNoise(line: string): boolean {
  return /^(remote: )?(Counting|Compressing|Enumerating|Receiving|Resolving|Updating|Filtering|Unpacking|Checking out)[^:]*:\s+\d+%/.test(
    line.trim(),
  ) && !line.includes('done');
}
