import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { SiteManifest, StepCommand } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { sites } from '../db/schema.js';
import type { JobContext } from '../jobs/queue.js';
import { runCommand } from '../process/run-command.js';
import { appRootFor } from './site-service.js';
import {
  explainSpawnFailure,
  explainToolFailure,
  withInstallDefaults,
  type ToolPaths,
} from './deploy-pipeline.js';

/**
 * Running a command against a website, by hand.
 *
 * The panel cannot be the only way to operate a site and also refuse to run
 * `npm install`. Real hosting means occasionally needing a migration script,
 * a dependency reinstall, or a one-off `node` invocation — and without this
 * the answer is "remote desktop into the server", which is exactly what a
 * control panel exists to avoid.
 *
 * The safety story is the same as the build pipeline's: the executable is
 * chosen from a fixed allowlist and resolved to an absolute path by the agent,
 * arguments are passed as an array and never through a shell, and the working
 * directory is always the site's own app folder. The user picks *what* to run
 * from a known set, never *which binary* runs.
 */

export interface RunCommandPayload {
  siteId: string;
  command: StepCommand;
  args: string[];
  /** Shown in the log so the output has a heading. */
  label: string;
}

export interface CommandRunnerDependencies {
  db: DatabaseHandle;
  tools: ToolPaths;
  sitesRoot: string;
  loadEnv: (siteId: string) => Promise<Record<string, string>>;
  /** Ceiling on a single command, so a hung script cannot block the queue. */
  timeoutMs?: number;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export function createRunCommandHandler(deps: CommandRunnerDependencies) {
  return async function handleRunCommand(rawPayload: unknown, ctx: JobContext): Promise<void> {
    const payload = rawPayload as RunCommandPayload;

    const site = deps.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
    if (!site) throw new CommandError('That website no longer exists.');

    // Parsed rather than cast: the row is the source of truth for the runtime
    // version, and a malformed manifest should fail here, not inside a spawn.
    const manifest = SiteManifest.parse(site.manifest);
    const cwd = appRootFor(deps.sitesRoot, site);

    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new CommandError(
        'This website has no application folder yet. Deploy it once, then try again.',
      );
    }

    const tool = await deps.tools.resolve(payload.command, manifest.nodeVersion ?? undefined);
    const env = await deps.loadEnv(site.id);

    ctx.log(`${payload.label} in ${site.slug}\u2026`, 'info', payload.label);
    ctx.log(`> ${payload.command} ${payload.args.join(' ')}`, 'debug', payload.label);
    ctx.progress(10);

    const result = await runCommand({
      exe: tool.exe,
      args: [...tool.args, ...withInstallDefaults(payload.command, payload.args)],
      cwd,
      env: { ...env, CI: '1', NODE_ENV: env['NODE_ENV'] ?? 'production' },
      timeoutMs: deps.timeoutMs ?? 15 * 60 * 1000,
      onOutput: (line) => {
        if (line.trim().length > 0) ctx.log(line, 'debug', payload.label);
      },
    }).catch((error: unknown) => {
      throw new CommandError(explainSpawnFailure(error, payload.command, payload.label).message);
    });

    ctx.progress(100);

    if (result.timedOut) {
      throw new CommandError(
        `${payload.label} was still running after ${Math.round(
          (deps.timeoutMs ?? 15 * 60 * 1000) / 60000,
        )} minutes and was stopped.`,
      );
    }

    if (result.exitCode !== 0) {
      const output = result.stderr || result.stdout;
      const tail = output.trim().split('\n').slice(-8).join('\n');
      const hint = explainToolFailure(payload.command, output);

      throw new CommandError(
        `${payload.label} failed (exit code ${result.exitCode}).\n${tail}` +
          (hint ? `\n\n${hint}` : ''),
      );
    }

    ctx.log(`${payload.label} finished.`);
  };
}
