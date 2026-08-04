import fs from 'node:fs/promises';
import path from 'node:path';
import type { BuildStep, SiteManifest } from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import type { JobContext } from '../jobs/queue.js';

/**
 * Running a site's build steps and proving the result is healthy.
 *
 * The pipeline is deliberately blue/green: a release is built into a fresh
 * folder, started on the *idle* port, and only receives traffic once it has
 * answered a health check. If anything fails, the currently live version has
 * not been touched at all — which is the difference between a failed deploy
 * and an outage.
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
  if (command !== 'pnpm') return null;

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

/**
 * Keeps a bounded number of previous releases.
 *
 * Enough to roll back through a couple of bad deploys, few enough that
 * `node_modules` copies do not quietly consume the disk.
 */
export async function pruneOldReleases(
  releasesDir: string,
  keep: number,
  currentReleaseId: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(releasesDir);
  } catch {
    return [];
  }

  const sorted = entries.filter((entry) => entry !== currentReleaseId).sort().reverse();
  const removed: string[] = [];

  for (const entry of sorted.slice(Math.max(keep - 1, 0))) {
    await fs.rm(path.join(releasesDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }

  return removed;
}

/**
 * Removes what earlier failed attempts left behind.
 *
 * A failed deploy keeps its folder on purpose — it is the only evidence of
 * what went wrong — but only the most recent one is evidence of anything. The
 * rest are `node_modules` trees for versions that never ran, and a site that
 * fails to deploy repeatedly is exactly the site that can least afford to fill
 * the disk while doing it.
 *
 * `protect` is a belt-and-braces list of release ids that must survive
 * whatever the database says about them.
 */
export async function pruneFailedReleases(
  releasesDir: string,
  failedReleaseIds: readonly string[],
  options: { keep?: number; protect?: readonly string[] } = {},
): Promise<string[]> {
  const keep = options.keep ?? 1;
  const protectedIds = new Set(options.protect ?? []);

  // Newest first, so the ones kept are the most recent failures.
  const candidates = [...new Set(failedReleaseIds)]
    .filter((id) => !protectedIds.has(id))
    .sort()
    .reverse()
    .slice(keep);

  const removed: string[] = [];

  for (const id of candidates) {
    const target = path.join(releasesDir, id);
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(id);
    } catch {
      // A folder held open by something is not a reason to stop deploying.
    }
  }

  return removed;
}

/**
 * Points `current` at a release.
 *
 * A junction is used rather than a copy so the switch is effectively
 * instantaneous, and rolling back is just re-pointing it.
 */
export async function pointCurrentAt(
  siteDir: string,
  releaseDir: string,
): Promise<void> {
  const currentPath = path.join(siteDir, 'current');

  await fs.rm(currentPath, { recursive: true, force: true }).catch(() => undefined);

  if (process.platform === 'win32') {
    const result = await runCommand({
      exe: 'cmd.exe',
      args: ['/c', 'mklink', '/J', currentPath, releaseDir],
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'Could not switch to the new version on disk. ' +
          (result.stderr || result.stdout).trim(),
      );
    }
  } else {
    await fs.symlink(releaseDir, currentPath, 'dir');
  }
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
      await fs.rm(target, { recursive: true, force: true });
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
