import fs from 'node:fs/promises';
import path from 'node:path';
import { PREVIOUS_DIR, RELEASE_DIR, STAGING_DIR, type BuildStep, type SiteManifest } from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import type { JobContext } from '../jobs/queue.js';

/**
 * Running a site's build steps and proving the result is healthy.
 *
 * A site has exactly one code folder, `release/`, and every path that points
 * at a site — the service's working directory, Caddy's static root, anything
 * the user typed — points at it. The next version is therefore assembled in a
 * staging folder and only swapped in once it has built, so a failure leaves
 * the live folder untouched.
 */

export class DeploymentError extends Error {
  constructor(
    message: string,
    readonly step?: string,
  ) {
    super(message);
    this.name = 'DeploymentError';
  }
}

export interface ToolPaths {
  /** How to launch each executable the build steps may use. */
  resolve: (command: string, nodeVersion?: string) => Promise<{ exe: string; args: string[] }>;
}

/** Timestamped, sortable release identifier. */
export function newReleaseId(now = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Extra arguments a package manager needs to behave the way a deploy expects. */
const ALLOW_BUILDS_FLAG = '--dangerously-allow-all-builds';

/**
 * Lets a dependency's install scripts run.
 *
 * Since pnpm 10 a dependency that wants to run an install script is ignored
 * unless it has been approved by hand, and since pnpm 11 that ends the install
 * with a non-zero exit code. On a server there is nobody to approve anything,
 * and the packages this hits are the ones that must build to work at all —
 * `sharp`, `bcrypt`, `esbuild`. The result was a deploy that could not
 * succeed and an error naming a command (`pnpm approve-builds`) that only
 * works with a person sitting at a terminal.
 *
 * npm, yarn and bun all run these scripts without asking, and the panel is
 * already running this repository's own build scripts as this same account, so
 * this grants nothing that was not already granted.
 *
 * Applied here rather than when a project is first inspected, because the
 * steps of a site set up before this are already stored in the database.
 */
export function withInstallDefaults(command: string, args: readonly string[]): string[] {
  const isInstall = args[0] === 'install' || args[0] === 'i';

  if (command !== 'pnpm' || !isInstall || args.includes(ALLOW_BUILDS_FLAG)) {
    return [...args];
  }

  return [...args, ALLOW_BUILDS_FLAG];
}

/**
 * A sentence about a failure the output alone does not explain.
 *
 * Both of these are silent-cause failures: the log says what happened but
 * nothing about why it happened here, or what to do next.
 */
export function explainToolFailure(command: string, output: string): string | null {
  if (command === 'pnpm') {
    if (output.includes('ERR_PNPM_BAD_OPTION') && output.includes('allow-all-builds')) {
      return (
        'The pnpm on this server is too old to be told that dependencies may run their ' +
        'install scripts. Install pnpm from the Components list on the Settings page, which ' +
        'installs a version that understands it.'
      );
    }

    if (output.includes('ERR_PNPM_IGNORED_BUILDS')) {
      return (
        'Some dependencies wanted to run install scripts and pnpm refused. Nobody can approve ' +
        'them on a server, so the panel normally allows them: this suggests the project pins a ' +
        'pnpm version older than 10.9.'
      );
    }
  }

  const unresolved = findUnresolvedPackage(output);
  if (unresolved) {
    const strict = command === 'pnpm' || command === 'yarn';

    return (
      `The build could not find the package "${unresolved}", even though the install step ` +
      `succeeded. ${command} only puts a project\u2019s own dependencies where the build can ` +
      `see them, so this usually means "${unresolved}" is used directly by this project but ` +
      `is only installed as a dependency of something else. Add it to the project\u2019s ` +
      `dependencies (\`${command} add -D ${unresolved}\`) and commit the change` +
      (strict
        ? ', or switch this website to npm on its Application page, which installs everything ' +
          'in one flat folder.'
        : '.')
    );
  }

  return null;
}

/**
 * A sentence about an app that built but would not start.
 *
 * A build and a running process do not look for packages in the same places,
 * so "it compiled" is no promise that it will run: pnpm and yarn give each
 * package its own folder and link in only what it declares, which leaves
 * anything the built output reaches for indirectly missing at the one moment
 * it matters. npm's single flat folder hides the same mistake.
 */
export function explainRuntimeFailure(message: string, packageManager: string): string | null {
  const missing = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(message)?.[1];
  if (!missing) return null;

  if (missing.startsWith('.') || missing.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(missing)) {
    return (
      `Your website looked for the file "${missing}" and it is not there. The startup file on ` +
      'the Application page has to name the file your build produces \u2014 for a Nuxt site ' +
      'that is .output/server/index.mjs.'
    );
  }

  const name = missing.startsWith('@')
    ? missing.split('/').slice(0, 2).join('/')
    : (missing.split('/')[0] ?? missing);

  const opening =
    `Your website started and immediately asked for the package "${name}", which is not ` +
    'anywhere it can see. The build succeeded because building and running do not resolve ' +
    'packages the same way.';

  if (packageManager === 'pnpm' || packageManager === 'yarn') {
    return (
      `${opening} ${packageManager} only puts a project\u2019s own dependencies where it can ` +
      `reach them, so this usually means "${name}" is only installed as a dependency of ` +
      `something else. Add it to the project\u2019s dependencies (\`${packageManager} add ` +
      `${name}\`) and commit that, or switch this website to npm on its Application page, ` +
      'which installs everything in one flat folder.'
    );
  }

  return `${opening} Add "${name}" to the project\u2019s dependencies and commit that.`;
}

/** The package name from a bundler's "module not found" message, if there is one. */
function findUnresolvedPackage(output: string): string | null {
  const patterns = [
    /Can't resolve '([^'\s]+)'/,
    /Failed to resolve (?:import|entry for package) "([^"\s]+)"/,
    /Cannot find (?:module|package) '([^'\s]+)'/,
  ];

  for (const pattern of patterns) {
    const name = pattern.exec(output)?.[1];
    // A relative or absolute specifier is the project's own missing file, which
    // has nothing to do with how dependencies are linked.
    if (name && !name.startsWith('.') && !path.isAbsolute(name)) return name;
  }

  return null;
}

/**
 * Explains a failure to start a program at all.
 *
 * Windows reports these as a bare error code with no context — `spawn EINVAL`
 * in the middle of a deployment log names neither the program nor anything the
 * user could do about it.
 */
export function explainSpawnFailure(error: unknown, tool: string, step: string): DeploymentError {

  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ENOENT') {
    return new DeploymentError(
      `"${step}" could not run because ${tool} is not installed on this server. ` +
        'Install it from the Components list on the Settings page, then deploy again.',
      step,
    );
  }

  if (code === 'EINVAL') {
    return new DeploymentError(
      `"${step}" could not run because the copy of ${tool} on this server is a Windows ` +
        'shortcut rather than a program. Install ' +
        `${tool} from the Components list on the Settings page, then deploy again.`,
      step,
    );
  }

  return new DeploymentError(
    `"${step}" could not be started: ${error instanceof Error ? error.message : String(error)}`,
    step,
  );
}

export interface RunBuildOptions {
  manifest: SiteManifest;
  /** Absolute path to the release folder. */
  releaseDir: string;
  tools: ToolPaths;
  ctx: JobContext;
  /** Extra environment for every step. */
  env?: Record<string, string>;
}

/**
 * Executes the manifest's build steps in order.
 *
 * Each step may run in a different folder, which is what makes the common
 * "frontend builds into backend" layout work: install and build in
 * `frontend/`, then install production dependencies in `backend/`.
 */
export async function runBuildSteps(options: RunBuildOptions): Promise<void> {
  const { manifest, releaseDir, tools, ctx } = options;

  if (manifest.buildLocation === 'prebuilt') {
    ctx.log('Skipping the build because this project is uploaded already built.');
    return;
  }

  const steps = manifest.steps;
  if (steps.length === 0) {
    ctx.log('No build steps are configured for this project.');
    return;
  }

  for (const [index, step] of steps.entries()) {
    ctx.throwIfCancelled();

    const cwd = path.join(releaseDir, step.cwd);

    // The manifest comes from the user's repository, so confirm the folder is
    // real before handing it to a process rather than trusting the string.
    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new DeploymentError(
        `The folder "${step.cwd || '.'}" does not exist in this project, so "${step.name}" ` +
          'could not run.',
        step.name,
      );
    }

    const tool = await tools.resolve(step.command, manifest.nodeVersion ?? undefined);

    ctx.log(`${step.name}\u2026`, 'info', step.name);
    ctx.progress(Math.round((index / steps.length) * 70));

    const result = await runCommand({
      exe: tool.exe,
      args: [...tool.args, ...withInstallDefaults(step.command, step.args)],
      cwd,
      env: { ...options.env, ...step.env, CI: '1', NODE_ENV: 'production' },
      timeoutMs: 20 * 60 * 1000,
      onOutput: (line) => {
        if (line.trim().length > 0) ctx.log(line, 'debug', step.name);
      },
    }).catch((error: unknown) => {
      throw explainSpawnFailure(error, step.command, step.name);
    });

    if (result.exitCode !== 0) {
      if (step.optional) {
        ctx.log(`${step.name} did not succeed, but it is optional. Continuing.`, 'warn', step.name);
        continue;
      }

      const output = result.stderr || result.stdout;
      const tail = output.trim().split('\n').slice(-8).join('\n');
      const hint = explainToolFailure(step.command, output);

      throw new DeploymentError(
        `"${step.name}" failed.\n${tail}${hint ? `\n\n${hint}` : ''}`,
        step.name,
      );
    }
  }

  ctx.progress(70);
}

export interface HealthCheckOptions {
  port: number;
  path: string;
  timeoutSeconds: number;
  ctx: JobContext;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Polls the new release until it answers.
 *
 * Any HTTP response at all counts as healthy, including a 404. The question
 * being asked is "did the process start and bind its port", not "is every
 * route correct" — a site whose home page legitimately returns 404 should
 * still deploy.
 */
export async function waitForHealthy(options: HealthCheckOptions): Promise<void> {
  const { port, ctx } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const url = `http://127.0.0.1:${port}${options.path}`;

  ctx.log(`Waiting for the new version to start on port ${port}\u2026`);

  let lastError = 'it did not respond';
  let attempt = 0;

  while (Date.now() < deadline) {
    ctx.throwIfCancelled();
    attempt++;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await doFetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (response.status >= 500) {
        lastError = `it returned an error (${response.status})`;
      } else {
        ctx.log(`The new version is responding (${response.status}).`);
        return;
      }
    } catch (error) {
      lastError =
        (error as Error).name === 'AbortError'
          ? 'it did not respond in time'
          : 'nothing is listening yet';
    }

    // Ramp the interval so a slow starter is not hammered, while a fast one
    // is still picked up quickly.
    const delay = Math.min(250 * attempt, 2000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new DeploymentError(
    `The new version did not start: ${lastError}. ` +
      'Check the deployment log above for errors from your app.',
  );
}

/** The three folders a deploy moves between, for one site. */
export interface ReleaseFolders {
  /** The live code. Everything that points at the site points here. */
  release: string;
  /** Where the next version is assembled. */
  staging: string;
  /** The outgoing version, kept only until the new one is proven. */
  previous: string;
}

export function releaseFoldersFor(siteDir: string): ReleaseFolders {
  return {
    release: path.join(siteDir, RELEASE_DIR),
    staging: path.join(siteDir, STAGING_DIR),
    previous: path.join(siteDir, PREVIOUS_DIR),
  };
}

/**
 * Clears the staging folder so a deploy starts from nothing.
 *
 * Whatever is in there belongs to the previous attempt. Building on top of it
 * would silently resurrect files the repository has since deleted.
 */
export async function prepareStaging(folders: ReleaseFolders): Promise<void> {
  await removeDirectory(folders.staging);
}

/**
 * Swaps the staged version into place.
 *
 * Two renames on the same volume, so the window in which the site has no code
 * folder is as short as the filesystem can make it. The outgoing version is
 * moved aside rather than deleted, because until the new one has answered a
 * health check it is still the only version known to work.
 */
export async function promoteStaging(folders: ReleaseFolders): Promise<void> {
  /*
   * A `.previous` that is still here belongs to a deploy that failed after
   * this point, which makes it the newest version known to have served
   * traffic — and `release/` a build that never started. Replacing it with
   * that build, which is what deleting it here used to do, threw away the
   * last working copy of the site on the second failure in a row.
   */
  const keepPrevious = await exists(folders.previous);

  if (await exists(folders.release)) {
    if (keepPrevious) {
      await removeDirectory(folders.release);
    } else {
      await renameWithRetry(folders.release, folders.previous);
    }
  }

  try {
    await renameWithRetry(folders.staging, folders.release);
  } catch (error) {
    // Put the old version straight back: a site with no code folder at all is
    // the one outcome worse than a failed deploy.
    await renameWithRetry(folders.previous, folders.release).catch(() => undefined);
    throw new DeploymentError(
      'The new version could not be moved into place. ' +
        'Something on the server is holding the site folder open. ' +
        (error instanceof Error ? error.message : ''),
    );
  }
}

/** Puts the outgoing version back, after the new one failed to run. */
export async function restorePrevious(folders: ReleaseFolders): Promise<boolean> {
  if (!(await exists(folders.previous))) return false;

  await removeDirectory(folders.staging);
  // Keep the failed build: it is the only evidence of what went wrong, and
  // the next deploy clears it anyway.
  await renameWithRetry(folders.release, folders.staging).catch(() => undefined);
  await renameWithRetry(folders.previous, folders.release);
  return true;
}

/** Drops the outgoing version, once the new one is serving traffic. */
export async function discardPrevious(folders: ReleaseFolders): Promise<void> {
  await removeDirectory(folders.previous).catch(() => undefined);
}

/**
 * Clears the timestamped `releases/` tree and `current` junction used before
 * a site had a single release folder.
 *
 * Best effort and safe to run on every deploy: by the time it is called the
 * live code is already in `release/`, so anything left of the old layout is
 * a stale copy taking up disk.
 */
export async function removeLegacyLayout(siteDir: string): Promise<boolean> {
  const current = path.join(siteDir, 'current');
  const releases = path.join(siteDir, 'releases');
  let removed = false;

  for (const target of [current, releases]) {
    if (!(await exists(target))) continue;
    // `current` is a junction: rm removes the link, not what it points at.
    await removeDirectory(target).then(
      () => {
        removed = true;
      },
      () => undefined,
    );
  }

  return removed;
}

async function removeDirectory(target: string): Promise<void> {
  // Windows keeps files open for a moment after the process that had them
  // exits, and a `node_modules` tree gives it plenty to hold.
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}

/** `fs.rename` has no retry option of its own, and needs one on Windows. */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false,
  );
}

/** Removes build-only dependency folders once the output has been produced. */
export async function pruneBuildArtifacts(
  releaseDir: string,
  manifest: SiteManifest,
  ctx: JobContext,
): Promise<void> {
  for (const relative of manifest.pruneAfterBuild) {
    const target = path.join(releaseDir, relative);
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      ctx.log(`Cleaned up ${relative}.`, 'debug');
    } catch {
      // Best effort: failing to reclaim disk space must not fail a deploy that
      // has otherwise succeeded.
    }
  }
}

export function describeSteps(steps: readonly BuildStep[]): string[] {
  return steps.map((step) =>
    step.cwd ? `${step.name} (in ${step.cwd})` : step.name,
  );
}
