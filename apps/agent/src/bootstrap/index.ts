import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { config, paths } from '../config.js';
import { createAppContext } from '../app-context.js';
import { createDatabase } from '../db/index.js';
import { buildServiceXml, ServiceManager, type ServiceRecovery } from '../windows/service-manager.js';
import {
  FirewallManager,
  ensureBuildAccount,
  panelUrlFor,
  requiredFirewallRules,
  secureDataFolder,
} from './windows-setup.js';
import { localAddresses } from '../tls/panel-certificate.js';
import {
  AGENT_SERVICE_ID,
  listPanelServices,
  sortForStartup,
  startPanelService,
  stopPanelService,
} from '../windows/panel-services.js';
import { createServiceRecovery } from '../windows/watched-services.js';

/**
 * Everything the installer needs to do, as a command rather than a script.
 *
 * Written here rather than in PowerShell so it can be tested, reasoned about,
 * and reused by the panel later. The Inno Setup package simply invokes
 * `winpanel-bootstrap install`.
 */

export const BUILD_ACCOUNT = 'winpanel-run';
export { AGENT_SERVICE_ID };

export interface InstallResult {
  panelUrl: string;
  /**
   * Null when this was an upgrade of a panel that already has an account.
   * There is nothing to set up, and a code nothing can redeem is worse than
   * no code: it is a credential-shaped file left on disk for no reason.
   */
  setupToken: string | null;
  buildAccountPassword: string;
  warnings: string[];
}

/**
 * Where `stop-all` leaves the list of what it stopped, for `install` to undo.
 *
 * An upgrade has to stop the web server, the mail server and every website
 * before it can replace files any of them hold open. Nothing else knows they
 * were running: they are all set to start automatically, so on a reboot
 * Windows brings them back, but an in-place update never reboots. Without
 * this the panel comes back alone and every site on the server stays dark
 * until somebody notices and presses Start.
 */
const SUSPENDED_SERVICES_FILE = 'services-stopped-for-update.json';

function suspendedServicesPath(): string {
  return path.join(config.dataDir, SUSPENDED_SERVICES_FILE);
}

/** Generates a password nobody ever needs to type. */
function generateAccountPassword(): string {
  // Mixed classes because Windows may enforce a complexity policy, and a
  // rejected password produces a confusing failure mid-install.
  const random = crypto.randomBytes(24).toString('base64url');
  return `Wp!${random}9aA`;
}

/*
 * The installer runs the bootstrap hidden, so anything written to the console
 * is lost. Warnings go to a file the wizard's final page reads instead —
 * without it, a failed service start is invisible and the first sign of
 * trouble is a browser that cannot connect.
 */
export async function writeInstallWarnings(warnings: readonly string[]): Promise<void> {
  await fs
    .mkdir(config.dataDir, { recursive: true })
    .then(() =>
      fs.writeFile(
        path.join(config.dataDir, 'install-warnings.txt'),
        warnings.join('\n'),
        'utf8',
      ),
    )
    .catch(() => undefined);
}

/** Resolves once the panel accepts a connection, or false after `timeoutMs`. */
async function waitForPanel(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

export async function install(options: { skipService?: boolean } = {}): Promise<InstallResult> {
  const warnings: string[] = [];

  for (const dir of [
    config.root,
    config.binDir,
    config.dataDir,
    config.caddyDir,
    config.logDir,
    config.sitesRoot,
    path.join(config.dataDir, 'services'),
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // The vault key and database live in the data folder, so lock it down
  // before anything is written there.
  try {
    await secureDataFolder(config.dataDir);
  } catch (error) {
    warnings.push(
      `Could not restrict access to the data folder: ${(error as Error).message}`,
    );
  }

  const buildAccountPassword = generateAccountPassword();
  try {
    await ensureBuildAccount(BUILD_ACCOUNT, buildAccountPassword, config.sitesRoot);
  } catch (error) {
    // Not fatal: sites can still be built as the service account, just with
    // less isolation. The Health page reports this.
    warnings.push(
      `Could not create the restricted build account: ${(error as Error).message} ` +
        'Website builds will run with the panel\u2019s own permissions until this is fixed.',
    );
  }

  const firewall = new FirewallManager();
  try {
    await firewall.applyAll(requiredFirewallRules());
  } catch (error) {
    warnings.push(
      `Could not create firewall rules: ${(error as Error).message} ` +
        'You may need to open the panel port manually.',
    );
  }

  // Build the app context once so the database, vault and setup token all
  // exist before the service starts and races them.
  const app = await createAppContext({ registerJobHandlers: false });
  const setupToken = app.auth.needsSetup() ? await app.auth.ensureSetupToken() : null;

  if (buildAccountPassword) {
    app.vault.encrypt(buildAccountPassword, 'build-account');
  }

  await app.shutdown();

  if (!options.skipService) {
    // The panel's own orphan holds the panel's port and its program files, so
    // an update that could not stop the old one cleanly has to be able to end
    // it here rather than fail to start the new one.
    const recovery = await openServiceRecovery();
    const services = new ServiceManager(
      path.join(config.binDir, 'WinSW.exe'),
      path.join(config.dataDir, 'services'),
      recovery,
    );

    // Before the panel, so that by the time the agent boots and pushes the
    // site configuration, the web server is there to receive it.
    warnings.push(...(await resumeSuspendedServices()));

    try {
      if (await services.isInstalled(AGENT_SERVICE_ID)) {
        await services.uninstall(AGENT_SERVICE_ID);
      }

      await services.install({
        id: AGENT_SERVICE_ID,
        displayName: 'WinPanel',
        description: 'Website and email control panel.',
        executable: path.join(config.binDir, 'node', 'node.exe'),
        args: [path.join(config.root, 'agent', 'dist', 'index.js')],
        workingDirectory: config.root,
        logPath: config.logDir,
      });
      await services.start(AGENT_SERVICE_ID);

      /*
       * A running service only means the wrapper survived. The agent itself
       * can still die on its first database call or fail to bind the port,
       * and the installer would go on to hand the user an address that
       * refuses connections. Nothing short of connecting to it proves the
       * panel is actually there.
       */
      if (!(await waitForPanel(config.port, 30_000))) {
        warnings.push(
          `The panel service started but is not answering on port ${config.port}. ` +
            `Look in ${path.join(config.logDir, `${AGENT_SERVICE_ID}.err.log`)} for the reason.`,
        );
      }
    } catch (error) {
      warnings.push(`Could not start the panel service: ${(error as Error).message}`);
    } finally {
      recovery.close();
    }
  }

  const address = localAddresses().find((ip) => !ip.includes(':')) ?? 'your-server-ip';

  await writeInstallWarnings(warnings);

  return {
    panelUrl: panelUrlFor(address, config.httpsEnabled),
    setupToken,
    buildAccountPassword,
    warnings,
  };
}

export async function uninstall(options: { keepSites: boolean }): Promise<string[]> {
  const messages: string[] = [];

  // A service whose process was orphaned cannot be removed while it is still
  // running, and it is holding the very folder being uninstalled.
  const recovery = await openServiceRecovery();
  const services = new ServiceManager(
    path.join(config.binDir, 'WinSW.exe'),
    path.join(config.dataDir, 'services'),
    recovery,
  );

  /*
   * Everything, not just the panel. The web server, the mail server and a
   * service per website per colour all hold files inside the program folder
   * open, so removing only the panel leaves the uninstaller unable to delete
   * the very folder it is uninstalling — reported to the user as a folder
   * being "in use" by nothing they can see.
   *
   * The list comes from Windows rather than from the database: a service left
   * behind by an abandoned deployment is not in the database, and is exactly
   * the thing that blocks removal.
   */
  for (const service of await listPanelServices()) {
    if (service.id.toLowerCase() === AGENT_SERVICE_ID) continue;

    try {
      await services.uninstall(service.id);
      messages.push(`Removed ${service.label}.`);
    } catch (error) {
      messages.push(`Could not remove ${service.label}: ${(error as Error).message}`);
    }
  }

  try {
    if (await services.isInstalled(AGENT_SERVICE_ID)) {
      await services.uninstall(AGENT_SERVICE_ID);
      messages.push('Removed the panel service.');
    }
  } catch (error) {
    messages.push(`Could not remove the panel service: ${(error as Error).message}`);
  }

  // Before anything is deleted: an open database is itself a file in use, and
  // the uninstaller has the data folder still to remove.
  recovery.close();

  try {
    await new FirewallManager().removeAll();
    messages.push('Removed firewall rules.');
  } catch {
    messages.push('Some firewall rules could not be removed.');
  }

  if (!options.keepSites) {
    await fs.rm(config.sitesRoot, { recursive: true, force: true });
    messages.push('Removed website files.');
  } else {
    messages.push(`Website files were kept in ${config.sitesRoot}.`);
  }

  return messages;
}

/**
 * Port recovery backed by the panel's own database, for the installer.
 *
 * Which ports a website owns is only recorded in the database, and the
 * installer runs as its own process with no panel to ask. Opening it directly
 * is safe here — nothing is written and no migration is run — and a database
 * that cannot be opened at all, which is every fresh install, degrades to
 * doing nothing rather than failing the install.
 */
async function openServiceRecovery(): Promise<ServiceRecovery & { close: () => void }> {
  try {
    const db = createDatabase(paths.database());
    return { ...createServiceRecovery(db), close: () => db.close() };
  } catch {
    return {
      unblock: async () => false,
      describeBlockers: async () => null,
      close: () => undefined,
    };
  }
}

/**
 * Stops everything WinPanel runs, without removing anything.
 *
 * The installer calls this before overwriting files. Upgrading with the web
 * server or a website still running fails on files the user has no way to
 * connect to a program, because none of these have a window.
 *
 * Services already reporting stopped are visited too. That state is exactly
 * what an orphaned process hides behind — the service manager has forgotten
 * it, but it still holds its port and its files — and it is the reason an
 * update fails on a file nothing appears to be using.
 */
export async function stopAll(): Promise<string[]> {
  const messages: string[] = [];
  const suspended: string[] = [];
  const recovery = await openServiceRecovery();

  try {
    for (const service of await listPanelServices()) {
      if (service.state === 'stopped') {
        if (await recovery.unblock(service.id)) {
          messages.push(`Ended a leftover process from ${service.label}.`);
        }
        continue;
      }

      const ok = await stopPanelService(service.id, { unblock: recovery.unblock }).catch(
        () => false,
      );
      messages.push(ok ? `Stopped ${service.label}.` : `Could not stop ${service.label}.`);

      // The panel is excluded because `install` starts it itself, and a service
      // that would not stop is excluded because it never stopped running.
      if (ok && service.id.toLowerCase() !== AGENT_SERVICE_ID) suspended.push(service.id);
    }
  } finally {
    recovery.close();
  }

  await fs
    .mkdir(config.dataDir, { recursive: true })
    .then(() => fs.writeFile(suspendedServicesPath(), JSON.stringify(suspended), 'utf8'))
    .catch(() => undefined);

  return messages;
}

/**
 * Starts everything `stopAll` stopped, and forgets the list.
 *
 * Only what was actually running is started: a mail server the administrator
 * had deliberately stopped must not come back because they installed an
 * update. The list is deleted whether or not each service came up, so a
 * component that is broken for its own reasons is not retried on every
 * subsequent install.
 *
 * @returns a warning per service that did not come back, for the wizard's
 * final page — which otherwise claims everything is running again.
 */
export async function resumeSuspendedServices(): Promise<string[]> {
  const listed = await fs
    .readFile(suspendedServicesPath(), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);

  await fs.rm(suspendedServicesPath(), { force: true }).catch(() => undefined);

  if (!Array.isArray(listed) || listed.length === 0) return [];

  const wanted = new Set(listed.filter((id): id is string => typeof id === 'string'));
  const warnings: string[] = [];
  const recovery = await openServiceRecovery();

  try {
    // Windows' own view, in dependency order: the web server has to be up
    // before the websites that are proxied through it.
    for (const service of sortForStartup(await listPanelServices())) {
      if (!wanted.has(service.id) || service.state === 'running') continue;

      const ok = await startPanelService(service.id, { unblock: recovery.unblock }).catch(
        () => false,
      );
      if (!ok) {
        const blockers = await recovery.describeBlockers(service.id).catch(() => null);

        warnings.push(
          `${service.label} did not start again after the update. ` +
            (blockers
              ? `${blockers} is using a port it needs. Close that program, then start ` +
                `${service.label} again from the panel.`
              : `Its log in ${config.logDir} says why.`),
        );
      }
    }
  } finally {
    recovery.close();
  }

  return warnings;
}

/** Entry point when run as `node bootstrap.js <command>`. */
export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'install';

  if (command === 'install') {
    let result: InstallResult;
    try {
      result = await install();
    } catch (error) {
      // The wizard reads this file. Without it a bootstrap that died before
      // reaching the service step leaves the installer reporting success and
      // the user staring at a browser that cannot connect.
      const message = error instanceof Error ? error.message : String(error);
      await writeInstallWarnings([`Setup could not finish: ${message}`]);
      throw error;
    }

    // The installer captures this and shows it on its final page.
    process.stdout.write(
      [
        '',
        result.setupToken ? '  WinPanel is installed.' : '  WinPanel has been updated.',
        '',
        `  Open:       ${result.panelUrl}`,
        ...(result.setupToken
          ? [`  Setup code: ${result.setupToken}`]
          : ['  Sign in with the account you already have.']),
        '',
        ...result.warnings.map((warning) => `  Note: ${warning}`),
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (command === 'uninstall') {
    const keepSites = !argv.includes('--remove-sites');
    for (const message of await uninstall({ keepSites })) {
      process.stdout.write(`  ${message}\n`);
    }
    return 0;
  }

  if (command === 'stop-all') {
    for (const message of await stopAll()) {
      process.stdout.write(`  ${message}\n`);
    }
    return 0;
  }

  if (command === 'print-token') {
    const token = await fs.readFile(paths.setupToken(), 'utf8').catch(() => null);
    process.stdout.write(token ? token.trim() : 'No setup code: setup is already complete.');
    return token ? 0 : 1;
  }

  process.stderr.write(`Unknown command "${command}".\n`);
  return 2;
}

export { buildServiceXml };
