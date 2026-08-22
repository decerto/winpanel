import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ComponentDefinition } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { JobContext } from '../jobs/queue.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { runCommand, spawnManaged } from '../process/run-command.js';
import { writeSecret } from '../security/secret-store.js';
import { sqlStringLiteral } from '../sites/databases.js';
import { buildStalwartBootstrap } from '../mail/stalwart-config.js';
import { ensureMailAdminCredentials, mailServiceEnv } from '../mail/service.js';
import { storeMailDomains } from '../mail/domains.js';
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
  /** The agent's own compiled folder, where the PHP pool script is found. */
  agentDistDir: string;
  /** The name this mail server calls itself. Usually `mail.<first domain>`. */
  mailHostname: () => string;
}

export interface InstallComponentPayload {
  componentId: string;
}

/** Vault key the MariaDB root password is stored under. */
const MARIADB_ROOT_KEY = 'mariadb.rootPassword';

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
  const installDir = path.join(deps.binDir, component.id);

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

      await fs.rm(path.join(deps.binDir, component.id), {
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
          ? // Loopback only: the databases are reached by sites on this machine,
            // never from the network, so there is no reason to listen on it.
            [`--datadir=${path.join(deps.dataDir, 'database')}`, '--bind-address=127.0.0.1', '--port=3306']
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

  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const { componentId } = payload as InstallComponentPayload;
    const component = findComponent(componentId);

    if (!component) throw new Error(`There is no component called "${componentId}".`);
    if (component.id === 'node') {
      throw new Error(
        'Node.js is provided by the server itself and is not installed by the panel.',
      );
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

    // The web server builds its `mail.<domain>` routes and certificate list
    // from this copy of what the mail server last reported. Left behind, it
    // would keep asking a certificate authority for names nothing answers on.
    if (component.id === 'stalwart') storeMailDomains(deps.db, []);

    // Mail and website data are deliberately left alone. Removing a program
    // is not the same as agreeing to lose what it was holding.
    ctx.log(`${component.name} has been removed. Its data was left in place.`);
    ctx.progress(100);
  };
}
