import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobContext } from '../jobs/queue.js';
import { runCommand, runDetached } from '../process/run-command.js';
import { downloadVerified } from './download.js';
import { sniffPayload } from './archive.js';

/**
 * Updating WinPanel itself, without uninstalling it first.
 *
 * The installer already knows how to upgrade in place: it stops every service
 * WinPanel runs, replaces the program files, and re-registers the panel. What
 * was missing was a way to reach it from inside the panel, which meant every
 * fix required a remote desktop session, an uninstall, and losing the setup in
 * between.
 *
 * The order here is the whole point. The installer is fetched and proved to be
 * a Windows program *before* anything is stopped, so a bad download leaves a
 * running panel rather than a dead one.
 */

export interface PanelUpdatePayload {
  /** Where to fetch the installer from. Only https is accepted. */
  url?: string;
  /** A file already on the server, for an air-gapped machine. */
  filePath?: string;
  /** Lowercase hex SHA-256 of the installer, when it is known. */
  sha256?: string | null;
}

export interface PanelUpdateDependencies {
  binDir: string;
  logDir: string;
}

/** The scheduled task that runs the installer. Reused, never accumulated. */
export const UPDATE_TASK_NAME = 'WinPanelUpdate';

/**
 * Where an installer sent up from the browser lands.
 *
 * Fixed rather than derived from anything the browser said, so an upload can
 * only ever replace the last one.
 */
export function uploadedInstallerPath(binDir: string): string {
  return path.join(binDir, '.downloads', 'winpanel-upload.exe');
}

/**
 * The silent-install flags Inno Setup understands.
 *
 * `/NORESTART` matters: the installer must never decide on its own to reboot a
 * server that is hosting other people's websites.
 */
export function installerArguments(logPath: string): string[] {
  return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', `/LOG=${logPath}`];
}

/**
 * The command line the scheduled task runs.
 *
 * Both paths are the panel's own, fixed locations rather than anything the
 * user typed — an uploaded installer is copied to the first of them — because
 * this string is parsed again by the task scheduler and is the one place in
 * this file where that would matter.
 */
export function updateTaskCommand(installer: string, logPath: string): string {
  return `"${installer}" ${installerArguments(logPath).join(' ')}`;
}

/**
 * Hands the installer to the Windows task scheduler instead of starting it
 * here.
 *
 * The installer's first act is to stop every WinPanel service, this one
 * included, and the service wrapper stops a service by killing its process
 * *and everything below it*. An installer started from this process is
 * therefore killed halfway through replacing the program files, which is the
 * one outcome worse than not updating at all. A scheduled task belongs to
 * Windows, so nothing that happens to this process can touch it.
 */
export function scheduleInstallerArguments(command: string): string[] {
  return [
    '/Create',
    '/TN', UPDATE_TASK_NAME,
    '/TR', command,
    /*
     * Dated far enough ahead that the trigger can never fire by itself. The
     * task exists only to be run on demand, and a start time in the past
     * would leave Windows free to decide it is overdue.
     */
    '/SC', 'ONCE',
    '/SD', '01/01/2099',
    '/ST', '00:00',
    '/RU', 'SYSTEM',
    '/RL', 'HIGHEST',
    '/F',
  ];
}

/**
 * Removes the task and the installer once the update has been applied.
 *
 * Called on start-up, which for an update that worked is the moment after the
 * installer finished. A registered task that runs a file out of a download
 * folder as SYSTEM should not outlive the minute it was needed for.
 */
export async function cleanUpAfterUpdate(binDir: string): Promise<void> {
  await runCommand({
    exe: 'schtasks.exe',
    args: ['/Delete', '/TN', UPDATE_TASK_NAME, '/F'],
    timeoutMs: 30_000,
  }).catch(() => undefined);

  await fs
    .rm(path.join(binDir, '.downloads', 'winpanel-update.exe'), { force: true })
    .catch(() => undefined);

  await fs.rm(uploadedInstallerPath(binDir), { force: true }).catch(() => undefined);
}

/**
 * Rejects anything that is not a plain https address.
 *
 * What is downloaded here runs with full privilege on the server, so the
 * transport has to be one that cannot be rewritten in transit, and `file:` or
 * a UNC path would turn this into a way to run whatever is on a share.
 */
export function validateUpdateUrl(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'The address must start with https:// so the download cannot be tampered with.',
    };
  }

  return { ok: true };
}

export function createPanelUpdateHandler(deps: PanelUpdateDependencies) {
  return async function handlePanelUpdate(rawPayload: unknown, ctx: JobContext): Promise<void> {
    const payload = rawPayload as PanelUpdatePayload;
    const installer = path.join(deps.binDir, '.downloads', 'winpanel-update.exe');

    if (payload.url) {
      const check = validateUpdateUrl(payload.url);
      if (!check.ok) throw new Error(check.reason);

      ctx.log(`Downloading the update from ${new URL(payload.url).host}\u2026`);

      let lastReported = 0;
      await downloadVerified({
        url: payload.url,
        destination: installer,
        sha256: payload.sha256?.trim() ? payload.sha256.trim().toLowerCase() : null,
        onProgress: (received, total) => {
          if (!total) return;
          const percent = Math.min(100, Math.floor((received / total) * 100));
          if (percent >= lastReported + 10) {
            lastReported = percent;
            ctx.log(`Downloaded ${percent}%`, 'debug');
            ctx.progress(Math.floor(percent * 0.7));
          }
        },
      });
    } else if (payload.filePath) {
      const source = path.resolve(payload.filePath);
      ctx.log(`Using the installer at ${source}`);

      const stats = await fs.stat(source).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(
          `There is no file at ${source} on this server. Copy the installer onto the ` +
            'server first, then give its full path.',
        );
      }

      // Copied rather than run where it lies: what runs must be somewhere the
      // panel owns, and at a path this code chose rather than one it was told.
      await fs.mkdir(path.dirname(installer), { recursive: true });
      await fs.copyFile(source, installer);

      // An upload is the panel's own temporary file, so the copy leaves two of
      // it on the disk. Anything the user put on the server themselves is
      // theirs and is left alone.
      if (path.resolve(uploadedInstallerPath(deps.binDir)) === source) {
        await fs.rm(source, { force: true }).catch(() => undefined);
      }
    } else {
      throw new Error('Give either a download address or the path to an installer on this server.');
    }

    ctx.progress(75);

    if ((await sniffPayload(installer)) !== 'binary') {
      await fs.rm(installer, { force: true });
      throw new Error(
        'That file is not a Windows program, so it was not run. Check the address points at ' +
          'the WinPanel setup file itself and not at a web page listing it.',
      );
    }

    ctx.throwIfCancelled();

    const logPath = path.join(deps.logDir, 'winpanel-update.log');
    await fs.mkdir(deps.logDir, { recursive: true });

    const created = await runCommand({
      exe: 'schtasks.exe',
      args: scheduleInstallerArguments(updateTaskCommand(installer, logPath)),
      timeoutMs: 60_000,
    }).catch(() => null);

    ctx.log('Starting the installer. It stops every WinPanel service, including this panel,');
    ctx.log('replaces the program files, and starts everything again.');
    ctx.log(`A record of what it did is written to ${logPath}.`);
    ctx.log('This page will lose its connection for a minute or two. Reload it then.');
    ctx.progress(90);

    if (created?.exitCode === 0) {
      /*
       * Fire and forget: this returns as soon as Windows has started the task,
       * and moments later the task stops this service. Nothing after this line
       * is guaranteed to run, which is why every message above it is already
       * written.
       */
      runDetached({ exe: 'schtasks.exe', args: ['/Run', '/TN', UPDATE_TASK_NAME] });
      return;
    }

    /*
     * No task scheduler, or it refused. Starting the installer directly is
     * worse — the service wrapper may take it down with this process — but a
     * server that cannot schedule a task can still usually finish an install,
     * and the alternative is an update that cannot be applied at all.
     */
    ctx.log(
      'Windows would not schedule the installer, so it is being started directly. If the ' +
        'panel does not come back, run the installer on the server by hand.',
      'warn',
    );
    runDetached({ exe: installer, args: installerArguments(logPath) });
  };
}
