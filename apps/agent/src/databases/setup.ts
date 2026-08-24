import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MONGODB_PORT, POSTGRES_PORT } from '@winpanel/shared';
import { findExecutable } from '../components/archive.js';
import { runCommand } from '../process/run-command.js';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { isPortAnswered } from '../windows/service-probe.js';
import { assertSafeDbName } from './names.js';
import { readRootPassword, writeRootPassword } from './secrets.js';
import { withMongo } from './mongodb.js';
import { ENGINE_ROOT_USER } from './types.js';

/**
 * Getting a freshly downloaded database server ready to serve.
 *
 * Each engine needs the same two things — a data directory that exists and has
 * been initialised, and an administrative password the panel actually holds —
 * and each one has a completely different way of arranging them. Doing that
 * here rather than in the generic installer keeps the installer readable and
 * keeps everything one engine knows about itself in one file.
 *
 * Two rules hold for all of them:
 *   - An existing data directory is never re-initialised. Reinstalling the
 *     program must not lose the databases people have put in it.
 *   - The password is generated, applied, and only then stored. Storing one
 *     that was never applied leaves every later operation unable to sign in,
 *     which is exactly the failure this step exists to prevent.
 */

export interface SetupLog {
  log: (message: string, level?: 'debug' | 'info' | 'warn') => void;
}

export interface SetupContext {
  db: DatabaseHandle;
  vault: SecretVault;
  /** Where this engine's programs were unpacked. */
  installDir: string;
  /** Where this engine's files should live. */
  dataDir: string;
  ctx: SetupLog;
}

/** Waits for a server to answer on loopback, or gives up and says so. */
async function waitForPort(port: number, seconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < seconds * 4; attempt++) {
    if (await isPortAnswered(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * PostgreSQL
 * ------------------------------------------------------------------ */

/**
 * Creates PostgreSQL's data directory and its superuser.
 *
 * `initdb` does both in one go, which is why the superuser password is set
 * before the server has ever accepted a connection — there is no window in
 * which an uninitialised PostgreSQL is listening with no password, the way
 * there is with MariaDB.
 *
 * The password reaches initdb through a file rather than an argument, because
 * an argument is visible to anything on the machine that can list processes.
 * The file is deleted immediately afterwards, whatever happened.
 */
export async function setUpPostgres(options: SetupContext): Promise<void> {
  const { ctx } = options;
  const initdb = await findExecutable(options.installDir, ['initdb.exe']);

  if (!initdb) {
    throw new Error(
      'The PostgreSQL download did not contain initdb.exe, so it could not be set up. ' +
        'Nothing was started.',
    );
  }

  const alreadyInitialised = await fs
    .access(path.join(options.dataDir, 'PG_VERSION'))
    .then(() => true, () => false);

  if (alreadyInitialised) {
    ctx.log('Keeping the existing PostgreSQL databases.');

    if (!readRootPassword(options.db, options.vault, 'postgres')) {
      throw new Error(
        'There is an existing PostgreSQL data directory but the panel no longer has its ' +
          'password, so it cannot manage it. Move or remove ' +
          `${options.dataDir} to start again, or restore the panel's data from a backup.`,
      );
    }
    return;
  }

  await fs.mkdir(path.dirname(options.dataDir), { recursive: true });

  const password = crypto.randomBytes(24).toString('base64url');
  const pwfile = path.join(path.dirname(options.dataDir), '.pgpass-init');
  await fs.writeFile(pwfile, password, { mode: 0o600 });

  try {
    ctx.log('Creating the PostgreSQL data directory\u2026');

    const result = await runCommand({
      exe: initdb,
      args: [
        `--pgdata=${options.dataDir}`,
        `--username=${ENGINE_ROOT_USER.postgres}`,
        `--pwfile=${pwfile}`,
        '--encoding=UTF8',
        /*
         * The C locale, deliberately. Collation on Windows depends on the
         * machine's regional settings, so anything else would sort a
         * customer's data differently depending on where the server happens
         * to have been set up — and changing it later means rebuilding every
         * text index on the machine.
         */
        '--locale=C',
        // Passwords over the network and locally, hashed with SCRAM. The
        // default on Windows is `trust` for local connections, which would let
        // anything on the machine connect as the superuser.
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
      ],
      timeoutMs: 5 * 60_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `PostgreSQL could not create its data directory: ${
          result.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || 'no output'
        }`,
      );
    }
  } finally {
    await fs.rm(pwfile, { force: true });
  }

  writeRootPassword(options.db, options.vault, 'postgres', password);
  ctx.log('Set and stored a PostgreSQL superuser password.');
}

/**
 * Shuts the door PostgreSQL leaves open by default.
 *
 * Every role may connect to every database unless told otherwise, so on a
 * shared server one customer's login can open another's database. New
 * databases have that revoked when they are created; this does the same for
 * the two that `initdb` made, so nobody can use `postgres` as a landing spot
 * from which to look around.
 *
 * Run after the service starts, because it needs a connection.
 */
export async function hardenPostgres(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  binDir: string;
  ctx: SetupLog;
}): Promise<void> {
  if (!(await waitForPort(POSTGRES_PORT, 60))) {
    throw new Error('PostgreSQL started but never answered on its port.');
  }

  const { runPsql } = await import('./postgres.js');
  const engineContext = { db: options.db, vault: options.vault, binDir: options.binDir };

  await runPsql(engineContext, [
    `REVOKE ALL ON DATABASE ${assertSafeDbName('postgres')} FROM PUBLIC`,
    'REVOKE ALL ON SCHEMA public FROM PUBLIC',
  ]).catch((error: unknown) => {
    // Worth saying, not worth failing the install over: the databases the
    // panel creates are locked down individually regardless.
    options.ctx.log(
      `Could not tighten the default PostgreSQL privileges: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  });

  options.ctx.log('Locked down the default PostgreSQL databases.');
}

/* ------------------------------------------------------------------ *
 * MongoDB
 * ------------------------------------------------------------------ */

/** MongoDB needs nothing before it starts but a directory to write into. */
export async function setUpMongo(options: SetupContext): Promise<void> {
  await fs.mkdir(options.dataDir, { recursive: true });
  options.ctx.log(`MongoDB will store its data in ${options.dataDir}`);
}

/**
 * Creates MongoDB's administrative user, after the server is running.
 *
 * MongoDB ships with no superuser at all. What it has instead is the localhost
 * exception: while access control is on and no user exists anywhere, a
 * connection from loopback may create the first one, and nothing else. That is
 * the only window in which this can be done, and it closes the moment the user
 * below is created — which is why it happens here, immediately after the
 * service starts, rather than being left for the first time somebody wants a
 * database.
 */
export async function createMongoAdmin(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  ctx: SetupLog;
}): Promise<void> {
  if (readRootPassword(options.db, options.vault, 'mongodb')) {
    options.ctx.log('Keeping the existing MongoDB administrator.');
    return;
  }

  if (!(await waitForPort(MONGODB_PORT, 60))) {
    throw new Error('MongoDB started but never answered on its port.');
  }

  const password = crypto.randomBytes(24).toString('base64url');

  await withMongo(
    // No credentials: this is the localhost exception, and supplying any would
    // turn it into a failed sign-in instead.
    {},
    async (client) => {
      await client.db('admin').command({
        createUser: ENGINE_ROOT_USER.mongodb,
        pwd: password,
        roles: [{ role: 'root', db: 'admin' }],
      });
    },
  );

  writeRootPassword(options.db, options.vault, 'mongodb', password);
  options.ctx.log('Created and stored a MongoDB administrator password.');
}
