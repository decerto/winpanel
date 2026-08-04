import fs from 'node:fs/promises';
import path from 'node:path';
import type { ComponentDefinition } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { JobContext } from '../jobs/queue.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { runCommand } from '../process/run-command.js';
import { buildStalwartBootstrap } from '../mail/stalwart-config.js';
import { ensureMailAdminCredentials, mailServiceEnv } from '../mail/service.js';
import { caddyServiceEnv, cloudflareTokenEnvironment } from '../caddy/service.js';
import { downloadVerified } from './download.js';
import { extractZip, findExecutable, listExecutables, sniffPayload } from './archive.js';
import { findComponent } from './catalogue.js';

/**
 * Installing the pieces the panel drives.
 *
 * Runs as a job so the download, unpack and service registration stream their
 * progress to whoever pressed the button — several minutes of silence is
 * indistinguishable from a hang.
 *
 * The order matters: nothing is unpacked before its fingerprint is checked,
 * and no service is registered before the binary has been run once and asked
 * what it is. A component that fails either check leaves nothing behind.
 */

export interface InstallerDependencies {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
  binDir: string;
  dataDir: string;
  logDir: string;
  caddyDir: string;
  /** The name this mail server calls itself. Usually `mail.<first domain>`. */
  mailHostname: () => string;
}

export interface InstallComponentPayload {
  componentId: string;
}

/**
 * Names the program may go by inside its download.
 *
 * More than one because projects rename their binaries between releases, and
 * discovering that during an install is much better than discovering it on a
 * server that will not start.
 */
function executableNames(component: ComponentDefinition): string[] {
  const alternates: Record<string, string[]> = {
    stalwart: ['stalwart.exe', 'stalwart-mail.exe'],
  };

  return alternates[component.id] ?? [`${component.id}.exe`];
}

async function verifyBinary(
  component: ComponentDefinition,
  executable: string,
  ctx: JobContext,
  prefixArgs: readonly string[] = [],
): Promise<void> {
  const result = await runCommand({
    exe: executable,
    args: [...prefixArgs, ...component.verifyArgs],
    timeoutMs: 60_000,
  });

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const expected = component.verifyExpect?.toLowerCase();

  if (expected && !output.includes(expected)) {
    throw new Error(
      `The downloaded ${component.name.toLowerCase()} did not identify itself as expected, ` +
        'so it was not installed. Nothing was registered or started.',
    );
  }

  ctx.log(`Verified: ${output.trim().split(/\r?\n/)[0] ?? 'ok'}`);
}

/**
 * Everything the mail server needs before it will start.
 *
 * Which is very little: it is handed a store location and sets itself up from
 * there, binding the standard mail ports and generating its own certificates.
 * Accounts and the administrator password live inside that store, so the panel
 * cannot mint credentials here — they are entered on the Settings page once
 * the server is running.
 */
async function prepareMailServer(
  deps: InstallerDependencies,
  ctx: JobContext,
): Promise<void> {
  const mailData = path.join(deps.dataDir, 'mail');
  const configPath = path.join(mailData, 'config.json');

  await fs.mkdir(mailData, { recursive: true });

  // An existing configuration is left exactly as it is: an administrator who
  // has tuned it by hand must not lose that because they reinstalled.
  if (await fs.access(configPath).then(() => true, () => false)) {
    ctx.log('Keeping the existing mail server configuration.');
    return;
  }

  await fs.writeFile(
    configPath,
    buildStalwartBootstrap({ storePath: path.join(mailData, 'store') }),
    { mode: 0o600 },
  );

  ctx.log(`Wrote ${configPath}`);
}

export function createInstallComponentHandler(deps: InstallerDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { componentId } = payload as InstallComponentPayload;
    const component = findComponent(componentId);

    if (!component) throw new Error(`There is no component called "${componentId}".`);
    if (component.id === 'node') {
      throw new Error(
        'Node.js is provided by the server itself and is not installed by the panel.',
      );
    }

    ctx.log(`Installing ${component.name} ${component.version}`);
    ctx.progress(5);

    /*
     * A running service holds its own executable open, so unpacking over it
     * fails with a permission error that reads like a broken download. The
     * old registration goes first, and only then is anything written.
     */
    if (component.serviceName && (await deps.services.isInstalled(component.serviceName))) {
      ctx.log('Stopping the running service before replacing it\u2026');
      await deps.services.uninstall(component.serviceName);
    }

    const downloadDir = path.join(deps.binDir, '.downloads');
    const archivePath = path.join(downloadDir, `${component.id}-${component.version}.zip`);

    ctx.log(`Downloading from ${new URL(component.url).host}\u2026`);

    let lastReported = 0;
    await downloadVerified({
      url: component.url,
      destination: archivePath,
      sha256: component.sha256,
      onProgress: (received, total) => {
        if (!total) return;
        /*
         * Clamped because the length is the *compressed* size when the server
         * gzips the response, and fetch hands over the decompressed bytes.
         * Caddy's download is 17 MB on the wire and 49 MB on disk, which was
         * cheerfully reported as 280%.
         */
        const percent = Math.min(100, Math.floor((received / total) * 100));
        // Only on each ten per cent, or the log is thousands of lines.
        if (percent >= lastReported + 10) {
          lastReported = percent;
          ctx.log(`Downloaded ${percent}%`, 'debug');
          ctx.progress(5 + Math.floor(percent * 0.45));
        }
      },
    });

    ctx.throwIfCancelled();
    ctx.progress(55);

    const installDir = path.join(deps.binDir, component.id);
    const wanted = executableNames(component);

    if (component.kind === 'node-script') {
      await fs.mkdir(installDir, { recursive: true });
      const target = path.join(installDir, `${component.id}.js`);

      ctx.log(`Installing into ${target}\u2026`);
      await fs.copyFile(archivePath, target);
      await fs.rm(archivePath, { force: true });

      ctx.progress(70);
      // The agent is a Node process, so its own runtime is always available.
      await verifyBinary(component, process.execPath, ctx, [target]);

      ctx.log(`${component.name} is installed.`);
      ctx.progress(100);
      return;
    }

    const downloaded = await sniffPayload(archivePath);

    if (downloaded === 'unknown') {
      throw new Error(
        `What was downloaded for ${component.name.toLowerCase()} is neither a program nor an ` +
          'archive. The download may have been intercepted, or the release may have moved.',
      );
    }

    await fs.mkdir(installDir, { recursive: true });

    if (downloaded === 'binary') {
      // The download *is* the program; there is nothing to unpack.
      const target = path.join(installDir, wanted[0]!);
      ctx.log(`Installing into ${target}\u2026`);
      await fs.copyFile(archivePath, target);
    } else {
      ctx.log(`Unpacking into ${installDir}\u2026`);
      await extractZip(archivePath, installDir);
    }

    await fs.rm(archivePath, { force: true });

    const executable = await findExecutable(installDir, wanted);
    if (!executable) {
      const found = await listExecutables(installDir);

      throw new Error(
        `The ${component.name.toLowerCase()} download did not contain ${wanted.join(' or ')}. ` +
          (found.length > 0
            ? `It contained: ${found.slice(0, 5).join(', ')}.`
            : 'It contained no programs at all.') +
          ' Nothing was registered or started.',
      );
    }

    ctx.progress(70);
    await verifyBinary(component, executable, ctx);
    ctx.throwIfCancelled();

    if (component.id === 'stalwart') {
      await prepareMailServer(deps, ctx);
    }

    if (!component.serviceName) {
      ctx.log(`${component.name} is installed.`);
      ctx.progress(100);
      return;
    }

    ctx.progress(80);

    const args =
      component.id === 'stalwart'
        ? ['--config', path.join(deps.dataDir, 'mail', 'config.json')]
        : [...component.args];

    // Caddy needs its data directory and, once Cloudflare is connected, the
    // token it answers the certificate challenge with. Reading it here means a
    // reinstall keeps working rather than quietly losing the ability to renew.
    // The mail server gets the credential the panel manages mailboxes with,
    // which is the only way it can have one: its accounts live inside its own
    // datastore, which does not exist until it first starts.
    const env =
      component.id === 'caddy'
        ? caddyServiceEnv(deps.caddyDir, cloudflareTokenEnvironment(deps.db, deps.vault))
        : component.id === 'stalwart'
          ? mailServiceEnv(ensureMailAdminCredentials(deps.db, deps.vault))
          : undefined;

    ctx.log('Registering the Windows service\u2026');
    await deps.services.install({
      id: component.serviceName,
      displayName: `WinPanel ${component.name}`,
      description: component.description,
      executable,
      args,
      ...(env ? { env } : {}),
      workingDirectory: path.dirname(executable),
      logPath: path.join(deps.logDir, component.id),
    });

    ctx.progress(90);
    ctx.log('Starting it\u2026');
    await deps.services.start(component.serviceName);

    ctx.log(`${component.name} is installed and running.`);
    ctx.progress(100);
  };
}

export function createUninstallComponentHandler(deps: InstallerDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { componentId } = payload as InstallComponentPayload;
    const component = findComponent(componentId);
    if (!component) throw new Error(`There is no component called "${componentId}".`);

    if (component.serviceName) {
      ctx.log('Stopping and removing the Windows service\u2026');
      await deps.services.uninstall(component.serviceName);
    }

    ctx.log('Removing the program files\u2026');
    // The service stopped a moment ago, and Windows keeps an executable open
    // for a little while after the process using it has gone.
    await fs.rm(path.join(deps.binDir, component.id), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });

    // Mail and website data are deliberately left alone. Removing a program
    // is not the same as agreeing to lose what it was holding.
    ctx.log(`${component.name} has been removed. Its data was left in place.`);
    ctx.progress(100);
  };
}
