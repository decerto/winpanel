import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { createAppContext } from '../app-context.js';
import { buildServiceXml, ServiceManager } from '../windows/service-manager.js';
import {
  FirewallManager,
  ensureBuildAccount,
  panelUrlFor,
  requiredFirewallRules,
  secureDataFolder,
} from './windows-setup.js';
import { localAddresses } from '../tls/panel-certificate.js';

/**
 * Everything the installer needs to do, as a command rather than a script.
 *
 * Written here rather than in PowerShell so it can be tested, reasoned about,
 * and reused by the panel later. The Inno Setup package simply invokes
 * `winpanel-bootstrap install`.
 */

export const BUILD_ACCOUNT = 'winpanel-run';
export const AGENT_SERVICE_ID = 'winpanel-agent';

export interface InstallResult {
  panelUrl: string;
  setupToken: string;
  buildAccountPassword: string;
  warnings: string[];
}

/** Generates a password nobody ever needs to type. */
function generateAccountPassword(): string {
  // Mixed classes because Windows may enforce a complexity policy, and a
  // rejected password produces a confusing failure mid-install.
  const random = crypto.randomBytes(24).toString('base64url');
  return `Wp!${random}9aA`;
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
  const setupToken = await app.auth.ensureSetupToken();

  if (buildAccountPassword) {
    app.vault.encrypt(buildAccountPassword, 'build-account');
  }

  await app.shutdown();

  if (!options.skipService) {
    const services = new ServiceManager(
      path.join(config.binDir, 'WinSW.exe'),
      path.join(config.dataDir, 'services'),
    );

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
    } catch (error) {
      warnings.push(`Could not start the panel service: ${(error as Error).message}`);
    }
  }

  const address = localAddresses().find((ip) => !ip.includes(':')) ?? 'your-server-ip';

  /*
   * The installer runs this command hidden, so anything written to the console
   * is lost. Warnings go to a file the wizard's final page reads instead —
   * without it, a failed service start is invisible and the first sign of
   * trouble is a browser that cannot connect.
   */
  await fs.writeFile(
    path.join(config.dataDir, 'install-warnings.txt'),
    warnings.join('\n'),
    'utf8',
  );

  return {
    panelUrl: panelUrlFor(address, config.httpsEnabled),
    setupToken,
    buildAccountPassword,
    warnings,
  };
}

export async function uninstall(options: { keepSites: boolean }): Promise<string[]> {
  const messages: string[] = [];

  const services = new ServiceManager(
    path.join(config.binDir, 'WinSW.exe'),
    path.join(config.dataDir, 'services'),
  );

  try {
    if (await services.isInstalled(AGENT_SERVICE_ID)) {
      await services.uninstall(AGENT_SERVICE_ID);
      messages.push('Removed the panel service.');
    }
  } catch (error) {
    messages.push(`Could not remove the panel service: ${(error as Error).message}`);
  }

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

/** Entry point when run as `node bootstrap.js <command>`. */
export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'install';

  if (command === 'install') {
    const result = await install();

    // The installer captures this and shows it on its final page.
    process.stdout.write(
      [
        '',
        '  WinPanel is installed.',
        '',
        `  Open:       ${result.panelUrl}`,
        `  Setup code: ${result.setupToken}`,
        '',
        ...result.warnings.map((warning) => `  Note: ${warning}`),
        '',
      ].join('\n'),
    );
    return result.warnings.length > 0 ? 0 : 0;
  }

  if (command === 'uninstall') {
    const keepSites = !argv.includes('--remove-sites');
    for (const message of await uninstall({ keepSites })) {
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
