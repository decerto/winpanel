import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { SiteManifest } from '@winpanel/shared';
import type { ComponentDefinition } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { sites } from '../db/schema.js';
import type { SecretVault } from '../security/vault.js';
import type { JobContext } from '../jobs/queue.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { runCommand, spawnManaged } from '../process/run-command.js';
import { writeSecret } from '../security/secret-store.js';
import { sqlStringLiteral } from '../databases/names.js';
import { ENGINE_ROOT_SECRET, engineDataDir } from '../databases/types.js';
import {
  createMongoAdmin,
  hardenPostgres,
  setUpMongo,
  setUpPostgres,
} from '../databases/setup.js';
import { buildStalwartBootstrap } from '../mail/stalwart-config.js';
import {
  ensureMailAdminCredentials,
  mailServiceEnv,
  prepareStalwartForWebServer,
} from '../mail/service.js';
import { storeMailDomains } from '../mail/domains.js';
import { caddyServiceEnv, cloudflareTokenEnvironment } from '../caddy/service.js';
import { downloadVerified } from './download.js';
import { extractZip, findExecutable, listExecutables, sniffPayload } from './archive.js';
import { findComponent } from './catalogue.js';
import { findNodeVersion } from './node-catalogue.js';
import { forgetDatabase, listAllDatabases } from '../databases/store.js';
import {
  databaseFirewallRuleName,
  databaseServerArgs,
} from '../databases/network.js';
import { engineNetworkPolicy, type DatabaseNetworkService } from '../databases/network-service.js';
import type { FirewallManager } from '../bootstrap/windows-setup.js';
import { appRootFor, SiteService } from '../sites/site-service.js';
import { serviceIdFor } from '../sites/deploy-handler.js';
import {
  discoverNodeVersions,
  forgetNodeVersions,
  isPanelManagedNode,
  matchVersion,
} from '../sites/node-versions.js';

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
  firewall?: FirewallManager;
  databaseNetwork?: DatabaseNetworkService;
  binDir: string;
  sitesRoot: string;
  dataDir: string;
  logDir: string;
  caddyDir: string;
  /** The agent's own compiled folder, where the PHP pool script is found. */
  agentDistDir: string;
  /** The name this mail server calls itself. Usually `mail.<first domain>`. */
  mailHostname: () => string;
}

export interface InstallComponentPayload {
  componentId: string;
  deleteData?: boolean;
  nodeVersion?: string;
}

const POSTGRES_SERVICE_ACCOUNT = 'NT AUTHORITY\\NetworkService';

function componentDataPath(deps: InstallerDependencies, componentId: string): string | null {
  if (componentId === 'stalwart') return path.join(deps.dataDir, 'mail');
  if (componentId === 'mariadb' || componentId === 'postgres' || componentId === 'mongodb') {
    return engineDataDir(deps.dataDir, componentId);
  }
  return null;
}

function componentInstallDir(deps: InstallerDependencies, component: ComponentDefinition): string {
  return component.id === 'node'
    ? path.join(deps.binDir, 'node', component.version)
    : path.join(deps.binDir, component.id);
}

/** Vault key the MariaDB root password is stored under. */
const MARIADB_ROOT_KEY = ENGINE_ROOT_SECRET.mariadb;

/** Reads a secret that may not exist yet, returning null instead of throwing. */
async function readSecretOrNull(
  db: DatabaseHandle,
  vault: SecretVault,
  key: string,
): Promise<string | null> {
  const { readSecret } = await import('../security/secret-store.js');
  return readSecret(db, vault, key);
}

/**
 * True when a component's program is already on disk. Used to skip a
 * dependency that is already present, so installing PHP on a machine that
 * already has the VC++ runtime does not reinstall it.
 */
async function isInstalled(
  deps: InstallerDependencies,
  component: ComponentDefinition,
): Promise<boolean> {
  const installDir = componentInstallDir(deps, component);

  if (component.kind === 'node-script' || component.kind === 'php-script') {
    // Adminer is a web page renamed to adminer.php; the other php-scripts keep
    // their .phar name. The two kinds name their file differently.
    const filename =
      component.kind === 'php-script'
        ? component.id === 'adminer'
          ? 'adminer.php'
          : `${component.id}.phar`
        : `${component.id}.js`;
    const target = path.join(installDir, filename);
    return await fs.access(target).then(() => true, () => false);
  }

  return (await findExecutable(installDir, executableNames(component))) !== null;
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
    php: ['php-cgi.exe', 'php.exe'],
    mariadb: ['mariadbd.exe', 'mysqld.exe'],
    // The server, not `pg_ctl`: WinSW supervises a process directly, and
    // pg_ctl is a launcher that exits as soon as it has started one.
    postgres: ['postgres.exe'],
    mongodb: ['mongod.exe'],
    composer: ['composer.phar'],
    adminer: ['adminer.php'],
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
    cwd: path.dirname(executable),
    timeoutMs: 60_000,
  });

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const expected = component.verifyExpect?.toLowerCase();

  if (result.exitCode !== 0) {
    throw new Error(
      `The downloaded ${component.name.toLowerCase()} did not pass its verification command. ` +
        'Nothing was registered or started.',
    );
  }

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

/**
 * Everything MariaDB needs before it will serve: a data directory with the
 * system tables created, and a root password the panel can provision
 * databases with.
 *
 * The data directory is created by MariaDB's own `mysql_install_db.exe`, never
 * assumed to exist, and an existing one is left exactly as it is — reinstalling
 * the program must not wipe the databases people have stored in it.
 *
 * The root password is generated here, kept in the vault, and set through the
 * `mysql` client over a socket that only ever listens on loopback. It never
 * appears in a log.
 */
async function prepareDatabaseServer(
  deps: InstallerDependencies,
  installDir: string,
  ctx: JobContext,
): Promise<void> {
  const dbData = path.join(deps.dataDir, 'database');
  const mariadbExe = await findExecutable(installDir, ['mysql_install_db.exe']);
  const clientExe = await findExecutable(installDir, ['mariadb.exe', 'mysql.exe']);

  if (!mariadbExe || !clientExe) {
    throw new Error(
      'The MariaDB download did not contain the programs needed to set it up ' +
        '(mysql_install_db.exe and the client). Nothing was started.',
    );
  }

  await fs.mkdir(dbData, { recursive: true });

  // The system tables are only created once; an existing data directory means
  // this is a reinstall and the databases must be left alone.
  const alreadyInitialised = await fs
    .access(path.join(dbData, 'mysql'))
    .then(() => true, () => false);

  if (!alreadyInitialised) {
    ctx.log('Creating the database data directory…');
    await runCommand({
      exe: mariadbExe,
      args: [`--datadir=${dbData}`, '--password='],
      timeoutMs: 120_000,
    });
  } else {
    ctx.log('Keeping the existing databases.');
  }

  /*
   * The root password the panel uses for every later change. It is generated
   * once, stored in the vault, and — crucially — actually set on the server.
   * Generating it without applying it would leave every subsequent database
   * operation unable to sign in, which is exactly the failure this step exists
   * to prevent. The password is applied by starting a throwaway server with
   * grant tables off (so no password is needed yet), setting it, and stopping
   * again — all before the real service ever starts.
   */
  let rootPassword = await readSecretOrNull(deps.db, deps.vault, MARIADB_ROOT_KEY);
  if (!rootPassword) {
    rootPassword = crypto.randomBytes(24).toString('base64url');
    await setDatabaseRootPassword(installDir, dbData, rootPassword, ctx);
    writeSecret(deps.db, deps.vault, MARIADB_ROOT_KEY, rootPassword);
    ctx.log('Set and stored a database root password.');
  }
}

/**
 * Sets the MariaDB root password before the server ever serves traffic.
 *
 * A fresh data directory has an empty root password, so a one-off server is
 * started against it with grant tables skipped, the password is set for every
 * root account shape MariaDB creates, and the server is stopped again. The
 * password travels in the SQL text, which is fine here — it is generated by
 * us, used once, and the temporary server is gone a moment later.
 */
async function setDatabaseRootPassword(
  installDir: string,
  dbData: string,
  password: string,
  ctx: JobContext,
): Promise<void> {
  const serverExe = await findExecutable(installDir, ['mariadbd.exe', 'mysqld.exe']);
  const clientExe = await findExecutable(installDir, ['mariadb.exe', 'mysql.exe']);
  if (!serverExe || !clientExe) {
    throw new Error('The MariaDB download did not contain the server and client programs.');
  }

  // The generated password is base64url, so it has no characters that could
  // break the SQL string — but escape it properly anyway, because a literal
  // that cannot be trusted must never be interpolated raw.
  const literal = sqlStringLiteral(password);

  const server = spawnManaged({
    exe: serverExe,
    args: [
      `--datadir=${dbData}`,
      '--skip-grant-tables',
      '--skip-networking=0',
      '--bind-address=127.0.0.1',
      '--port=3307',
      '--console',
    ],
    cwd: path.dirname(serverExe),
    env: {},
  });

  try {
    // Wait for the temporary server to accept a connection before speaking SQL.
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const probe = await runCommand({
        exe: clientExe,
        args: ['--host=127.0.0.1', '--port=3307', '--user=root', '--execute', 'SELECT 1'],
        timeoutMs: 5_000,
      });
      ready = probe.exitCode === 0;
    }
    if (!ready) throw new Error('The database server did not start so its password could be set.');

    /*
     * Under --skip-grant-tables the account-management statements (ALTER USER,
     * CREATE USER, GRANT, even SET PASSWORD) are refused — that is the whole
     * point of the mode. The way to set a password there is to write the
     * privilege table directly and then FLUSH PRIVILEGES, which reloads it.
     * `mysql.global_priv` holds each account as a JSON privileges object; the
     * install creates root at localhost, 127.0.0.1, ::1 and the machine name,
     * all with no password, so a single UPDATE by user covers every shape.
     * Verified against MariaDB 12.3.2 on Windows: set under skip-grant, then a
     * normal-restart login with the password succeeds.
     */
    const result = await runCommand({
      exe: clientExe,
      args: [
        '--host=127.0.0.1',
        '--port=3307',
        '--user=root',
        '--execute',
        // PASSWORD() produces the mysql_native_password hash MariaDB checks
        // against; JSON_SET writes it (and the plugin) into each root row.
        `UPDATE mysql.global_priv SET Priv = JSON_SET(Priv, '$.authentication_string', PASSWORD(${literal}), '$.plugin', 'mysql_native_password') WHERE User = 'root'; ` +
          'FLUSH PRIVILEGES;',
      ],
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`The database root password could not be set: ${result.stderr.trim()}`);
    }
    ctx.log('Secured the database root account.');
  } finally {
    server.kill();
    // Give it a moment to release the data directory before the service starts.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Drops the pool supervisor next to php-cgi.exe.
 *
 * The supervisor is a small Node script that starts and restarts the site's
 * php-cgi workers. It is compiled into the agent (as
 * `dist/sites/php-pool-standalone.js`) and copied into the PHP component on
 * install, so a website's service points at a file that lives with the runtime
 * it drives rather than inside the agent's own folder — reinstalling the agent
 * then never pulls a running site's supervisor out from under it. The script
 * is self-contained on purpose: from the component's folder it cannot resolve
 * any of the agent's modules.
 */
async function installPhpPool(
  deps: InstallerDependencies,
  installDir: string,
  ctx: JobContext,
): Promise<void> {
  const source = path.join(deps.agentDistDir, 'sites', 'php-pool-standalone.js');
  const target = path.join(installDir, 'pool.js');

  try {
    await fs.copyFile(source, target);
    ctx.log('Installed the PHP worker pool.');
  } catch {
    throw new Error(
      'The agent could not find its PHP pool script to install. ' +
        'The panel may need reinstalling.',
    );
  }
}

export function createInstallComponentHandler(deps: InstallerDependencies) {
  /*
   * `skipIfPresent` is true only for dependencies pulled in to satisfy a
   * `requires`. The component the user actually asked for is always
   * (re)installed, because Install and Reinstall are the same button and
   * replacing the files is the whole point of pressing it again.
   */
  const installWithRequires = async (
    component: ComponentDefinition,
    ctx: JobContext,
    installing: ReadonlySet<string>,
    skipIfPresent: boolean,
  ): Promise<void> => {
    for (const requiredId of component.requires) {
      if (installing.has(requiredId)) continue;
      const required = findComponent(requiredId);
      if (!required) continue;
      if (await isInstalled(deps, required)) continue;

      ctx.log(`${component.name} needs ${required.name} — installing that first.`);
      await installWithRequires(required, ctx, new Set([...installing, component.id]), true);
    }

    if (skipIfPresent && (await isInstalled(deps, component))) {
      ctx.log(`${component.name} is already installed.`);
      return;
    }

    await installOne(component, ctx);
  };

  /**
   * Undoes a half-finished install, so a failed download or a service that
   * would not start does not leave a program half-present — showing as
   * installed, but missing the piece that failed.
   *
   * Deliberately conservative: only the downloaded archive and the panel's
   * own install folder are removed, never the program's data. A reinstall of
   * the database server must not delete the databases.
   */
  const cleanupFailedInstall = async (
    component: ComponentDefinition,
    ctx: JobContext,
  ): Promise<void> => {
    try {
      // A service that was registered but never started cleanly comes off, or
      // the next install finds a broken registration in the way.
      if (component.serviceName && (await deps.services.isInstalled(component.serviceName))) {
        await deps.services.uninstall(component.serviceName);
      }

      await fs.rm(componentInstallDir(deps, component), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });

      ctx.log('Cleared away the unfinished install.');
    } catch (error) {
      // A cleanup that itself fails is logged, not thrown — the original
      // error is the one the user needs.
      ctx.log(
        `Could not clear the unfinished install: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  };

  const installOne = async (component: ComponentDefinition, ctx: JobContext): Promise<void> => {
    ctx.log(`Installing ${component.name} ${component.version}`);
    ctx.progress(5);

    try {
      await installOneInner(component, ctx);
    } catch (error) {
      await cleanupFailedInstall(component, ctx);
      throw error;
    }
  };

  const installOneInner = async (component: ComponentDefinition, ctx: JobContext): Promise<void> => {
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
    const extension =
      component.kind === 'php-script' ? '.phar' : component.kind === 'exe' ? '.exe' : '.zip';
    const archivePath = path.join(downloadDir, `${component.id}-${component.version}${extension}`);

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

    const installDir = componentInstallDir(deps, component);
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

    if (component.kind === 'php-script') {
      // A single PHP archive, run through the PHP the panel installed. The
      // Adminer download is the full tool but is not named `adminer.php`, so
      // it is renamed to the name the panel serves it by.
      await fs.mkdir(installDir, { recursive: true });
      const filename = component.id === 'adminer' ? 'adminer.php' : `${component.id}.phar`;
      const target = path.join(installDir, filename);

      ctx.log(`Installing into ${target}…`);
      await fs.copyFile(archivePath, target);
      await fs.rm(archivePath, { force: true });

      ctx.progress(70);
      if (component.id === 'composer') {
        // Composer is verified by asking it what it is, through PHP.
        const phpExe = await findExecutable(path.join(deps.binDir, 'php'), ['php.exe']);
        if (phpExe) await verifyBinary(component, phpExe, ctx, [target]);
      }

      ctx.log(`${component.name} is installed.`);
      ctx.progress(100);
      return;
    }

    if (component.kind === 'exe') {
      /*
       * The download is a self-contained installer, not an archive to unpack.
       * The VC++ runtime is the one case: it is run with silent flags and
       * installs itself system-wide, leaving nothing in the panel's own
       * folders. A zero exit code is the whole success signal — a runtime
       * library has no `--version` to check afterwards.
       */
      ctx.log('Running the installer…');
      const result = await runCommand({
        exe: archivePath,
        args: component.args,
        timeoutMs: 5 * 60_000,
      });
      await fs.rm(archivePath, { force: true });

      /*
       * The Windows Installer exit codes that all mean "it is on the machine":
       *   0    installed
       *   3010 installed, a reboot is pending
       *   1638 a newer or identical version is already installed — which is
       *        success for a dependency, not a failure. The VC++ runtime is
       *        present on most servers already, so treating 1638 as an error
       *        blocked PHP from installing on a machine that was ready for it.
       */
      const ok = [0, 3010, 1638];
      if (!ok.includes(result.exitCode)) {
        throw new Error(
          `The ${component.name.toLowerCase()} installer reported a failure ` +
            `(exit code ${result.exitCode}). Nothing else was installed.`,
        );
      }

      ctx.log(
        result.exitCode === 1638
          ? `${component.name} is already on this server (a newer or matching version).`
          : `${component.name} is installed.`,
      );
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
    // A component with nothing to verify (a runtime library, a web page) is
    // taken on the strength of its checksum and a clean unpack.
    if (component.verifyExpect !== null || component.verifyArgs.length > 0) {
      await verifyBinary(component, executable, ctx);
    }
    ctx.throwIfCancelled();

    if (component.id === 'stalwart') {
      await prepareMailServer(deps, ctx);
    }
    if (component.id === 'mariadb') {
      await prepareDatabaseServer(deps, installDir, ctx);
    }
    if (component.id === 'postgres') {
      await setUpPostgres({
        db: deps.db,
        vault: deps.vault,
        installDir,
        dataDir: engineDataDir(deps.dataDir, 'postgres'),
        ctx,
      });

      const access = await runCommand({
        exe: 'icacls.exe',
        args: [
          engineDataDir(deps.dataDir, 'postgres'),
          '/grant',
          `${POSTGRES_SERVICE_ACCOUNT}:(OI)(CI)M`,
          '/T',
        ],
        timeoutMs: 120_000,
      });
      if (access.exitCode !== 0) {
        throw new Error('PostgreSQL could not grant its service account access to its data.');
      }
    }
    if (component.id === 'mongodb') {
      await setUpMongo({
        db: deps.db,
        vault: deps.vault,
        installDir,
        dataDir: engineDataDir(deps.dataDir, 'mongodb'),
        ctx,
      });
    }
    if (component.id === 'php') {
      await installPhpPool(deps, installDir, ctx);
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
        : component.id === 'mariadb'
          ? databaseServerArgs('mariadb', engineDataDir(deps.dataDir, 'mariadb'), engineNetworkPolicy(deps.db, 'mariadb'))
          : component.id === 'postgres'
            ? databaseServerArgs('postgres', engineDataDir(deps.dataDir, 'postgres'), engineNetworkPolicy(deps.db, 'postgres'))
            : component.id === 'mongodb'
              ? databaseServerArgs('mongodb', engineDataDir(deps.dataDir, 'mongodb'), engineNetworkPolicy(deps.db, 'mongodb'))
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
      ...(component.id === 'postgres'
        ? { account: { username: POSTGRES_SERVICE_ACCOUNT, password: '' } }
        : {}),
    });

    if (component.id === 'caddy') {
      try {
        const repaired = await prepareStalwartForWebServer(
          { db: deps.db, vault: deps.vault, services: deps.services },
          { retryForMs: 15_000 },
        );
        for (const change of repaired?.changes ?? []) ctx.log(change, 'warn');
      } catch (error) {
        ctx.log(
          `Could not repair the mail server before starting the web server: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn',
        );
      }
    }

    ctx.progress(90);
    ctx.log('Starting it\u2026');
    await deps.services.start(component.serviceName);

    if (deps.databaseNetwork && (component.id === 'mariadb' || component.id === 'postgres' || component.id === 'mongodb')) {
      await deps.databaseNetwork.syncEngine(component.id);
    }

    /*
     * The two steps that can only happen once a server is actually answering.
     * MongoDB has no superuser until one is made through its localhost
     * exception, and PostgreSQL's default privileges can only be revoked over
     * a connection.
     */
    if (component.id === 'mongodb') {
      await createMongoAdmin({ db: deps.db, vault: deps.vault, ctx });
    }
    if (component.id === 'postgres') {
      await hardenPostgres({ db: deps.db, vault: deps.vault, binDir: deps.binDir, ctx });
    }

    ctx.log(`${component.name} is installed and running.`);
    ctx.progress(100);
  };

  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { componentId, nodeVersion } = payload as InstallComponentPayload;
    const baseComponent = findComponent(componentId);

    if (!baseComponent) throw new Error(`There is no component called "${componentId}".`);

    const component =
      baseComponent.id === 'node'
        ? (() => {
            const version = nodeVersion?.trim() ?? '';
            const definition = findNodeVersion(version);
            if (!definition) throw new Error(`Node ${version || 'version'} is not in the catalogue.`);
            return { ...baseComponent, ...definition };
          })()
        : baseComponent;

    if (component.id === 'node' && !nodeVersion) {
      throw new Error('Choose a Node.js version before installing it.');
    }

    /*
     * Dependencies first. A component can declare others it needs (PHP needs
     * the VC++ runtime; the database browser needs PHP and MariaDB), and the
     * field was always part of the definition but never enforced — so a user
     * could install PHP onto a machine where it would not start. Any that are
     * missing are installed here, depth-first, before the one that was asked
     * for. The `installing` set guards against the dependency graph ever
     * pointing back at itself.
     */
    await installWithRequires(component, ctx, new Set(), false);
    if (component.id === 'node') forgetNodeVersions();
  };
}

async function prepareNodeSitesForRemoval(
  deps: InstallerDependencies,
  removed: Awaited<ReturnType<typeof discoverNodeVersions>>[number],
  remaining: Awaited<ReturnType<typeof discoverNodeVersions>>,
  ctx: JobContext,
): Promise<number> {
  const siteService = new SiteService(deps.db, deps.vault, deps.sitesRoot);
  const affected = siteService.list().filter((site) => {
    const manifest = SiteManifest.safeParse(site.manifest);
    return (
      manifest.success &&
      manifest.data.runtime === 'node' &&
      manifest.data.nodeVersion !== undefined &&
      matchVersion([removed], manifest.data.nodeVersion) !== null
    );
  });

  const fallback = remaining[0];
  if (affected.length > 0 && !fallback) {
    throw new Error(
      `Node ${removed.version} cannot be removed because ${affected.length} website${affected.length === 1 ? '' : 's'} ` +
        'use it and there is no other Node version to switch to. Install another version first.',
    );
  }

  for (const site of affected) {
    const manifest = SiteManifest.parse(site.manifest);
    const port = site.activeColour === 'blue' ? site.portBlue : site.portGreen;
    const serviceId = serviceIdFor(site.slug, site.activeColour);

    if (fallback && port !== null && (await deps.services.isInstalled(serviceId))) {
      const env = await siteService.getEnv(site.id);
      await deps.services.reconfigure({
        id: serviceId,
        displayName: site.displayName,
        description: `Website: ${site.displayName}`,
        executable: path.join(fallback.directory, 'node.exe'),
        args: [manifest.app.entry ?? 'index.js'],
        workingDirectory: appRootFor(deps.sitesRoot, site),
        env: {
          ...env,
          [manifest.app.portEnvVar]: String(port),
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
        },
        logPath: path.join(deps.sitesRoot, site.slug, 'logs'),
      });
    }

    const nextManifest = { ...(site.manifest as Record<string, unknown>) };
    nextManifest['nodeVersion'] = fallback!.version;
    deps.db.db
      .update(sites)
      .set({ manifest: nextManifest, updatedAt: new Date() })
      .where(eq(sites.id, site.id))
      .run();
    ctx.log(`${site.displayName} will use Node ${fallback!.version} from now on.`);
  }

  return affected.length;
}

export function createUninstallComponentHandler(deps: InstallerDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { componentId, deleteData = false, nodeVersion } = payload as InstallComponentPayload;
    const component = findComponent(componentId);
    if (!component) throw new Error(`There is no component called "${componentId}".`);

    if (component.id === 'node') {
      const requested = nodeVersion?.trim() ?? '';
      const installed = await discoverNodeVersions(deps.binDir);
      const target = installed.find((entry) => entry.version === requested);

      if (!target || !isPanelManagedNode(target, deps.binDir)) {
        throw new Error('Only Node versions installed by this panel can be removed.');
      }

      const remaining = installed.filter((entry) => entry.version !== target.version);
      const affected = await prepareNodeSitesForRemoval(deps, target, remaining, ctx);
      ctx.log(
        affected > 0
          ? `Switched ${affected} website${affected === 1 ? '' : 's'} to Node ${remaining[0]!.version}.`
          : 'No website was using this Node version.',
      );
      await fs.rm(path.join(deps.binDir, 'node', target.version), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
      forgetNodeVersions();
      ctx.log(`Node ${target.version} has been removed.`);
      ctx.progress(100);
      return;
    }

    if (component.serviceName) {
      ctx.log('Stopping and removing the Windows service\u2026');
      await deps.services.uninstall(component.serviceName);
    }

    if (
      deps.firewall &&
      (component.id === 'mariadb' || component.id === 'postgres' || component.id === 'mongodb')
    ) {
      await deps.firewall.remove(databaseFirewallRuleName(component.id));
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

    // The web server builds its `mail.<domain>` routes and certificate list
    // from this copy of what the mail server last reported. Left behind, it
    // would keep asking a certificate authority for names nothing answers on.
    if (component.id === 'stalwart') storeMailDomains(deps.db, []);

    if (deleteData) {
      const dataPath = componentDataPath(deps, component.id);
      if (dataPath) {
        ctx.log('Removing the associated data...');
        await fs.rm(dataPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 250,
        });
      }

      if (component.id === 'mariadb' || component.id === 'postgres' || component.id === 'mongodb') {
        for (const database of listAllDatabases(deps.db).filter(
          (entry) => entry.engine === component.id,
        )) {
          forgetDatabase(deps.db, database.id);
        }
      }
      ctx.log(`${component.name} has been removed, including its associated data.`);
    } else {
      ctx.log(`${component.name} has been removed. Its data was left in place.`);
    }
    ctx.progress(100);
  };
}

export interface UpdatePackageManagerPayload {
  packageManager: 'npm';
}

export function createUpdatePackageManagerHandler(deps: InstallerDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { packageManager } = payload as UpdatePackageManagerPayload;
    if (packageManager !== 'npm') {
      throw new Error(`The ${packageManager} update is handled by its component installer.`);
    }

    const installations = (await discoverNodeVersions(deps.binDir)).filter((entry) =>
      isPanelManagedNode(entry, deps.binDir),
    );
    if (installations.length === 0) {
      throw new Error('npm is bundled with Node.js. Install a panel-managed Node version first.');
    }

    for (const [index, installation] of installations.entries()) {
      const node = path.join(installation.directory, 'node.exe');
      const npmScript = path.join(installation.directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!(await fs.access(npmScript).then(() => true, () => false))) {
        throw new Error(`Node ${installation.version} does not contain its npm CLI.`);
      }

      ctx.log(`Updating npm bundled with Node ${installation.version}…`);
      const result = await runCommand({
        exe: node,
        args: [npmScript, 'install', '--global', 'npm@latest', '--prefix', installation.directory, '--no-audit', '--no-fund'],
        cwd: installation.directory,
        timeoutMs: 15 * 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `npm could not be updated for Node ${installation.version}: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      ctx.progress(Math.floor(((index + 1) / installations.length) * 100));
    }

    ctx.log('npm is up to date for every panel-managed Node version.');
  };
}
