import { findExecutable } from '../components/archive.js';
import { POSTGRES_PORT } from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import { DatabaseError } from './errors.js';
import { assertSafeDbName, pgDollarQuoted } from './names.js';
import { readRootPassword } from './secrets.js';
import { engineBinDir, ENGINE_ROOT_USER, type DatabaseAdapter, type EngineContext } from './types.js';

/**
 * PostgreSQL.
 *
 * Driven through `psql` for the same reason MariaDB is driven through its own
 * client: the program ships with the server, so there is no second
 * implementation of the wire protocol to keep up to date, and the password
 * travels in the environment rather than on a command line.
 *
 * The privilege work here is not decoration. PostgreSQL grants CONNECT on
 * every database to PUBLIC by default, which on a shared server means every
 * customer's login can open every other customer's database. Each database
 * created here has that revoked and granted back to its own role alone.
 */

async function psql(binDir: string): Promise<string> {
  const found = await findExecutable(engineBinDir(binDir, 'postgres'), ['psql.exe']);
  if (!found) {
    throw new DatabaseError(
      'PostgreSQL is not installed. Install it from the Programs section of Settings.',
    );
  }
  return found;
}

function rootOrThrow(ctx: EngineContext): string {
  const root = readRootPassword(ctx.db, ctx.vault, 'postgres');
  if (!root) {
    throw new DatabaseError(
      'PostgreSQL has not been set up. Reinstall it from the Programs section of Settings.',
    );
  }
  return root;
}

/** A database or role name, quoted so PostgreSQL does not fold its case. */
function ident(name: string): string {
  return `"${assertSafeDbName(name)}"`;
}

/** The same name as a string literal. Safe because the shape is pinned first. */
function nameLiteral(name: string): string {
  return `'${assertSafeDbName(name)}'`;
}

/**
 * Runs statements as the superuser.
 *
 * Each statement is passed as its own `-c`, which is what lets CREATE DATABASE
 * appear alongside anything else: PostgreSQL refuses it inside a transaction
 * block, and a single `-c` carrying several statements is one transaction.
 */
export async function runPsql(
  ctx: EngineContext,
  statements: readonly string[],
  database = 'postgres',
): Promise<string> {
  const exe = await psql(ctx.binDir);

  const result = await runCommand({
    exe,
    args: [
      '--host=127.0.0.1',
      `--port=${POSTGRES_PORT}`,
      `--username=${ENGINE_ROOT_USER.postgres}`,
      `--dbname=${assertSafeDbName(database)}`,
      // No psqlrc, no alignment, no headers: the output is parsed, not read.
      '--no-psqlrc',
      '--no-align',
      '--tuples-only',
      '--quiet',
      // Without this psql reports success after a statement that failed.
      '--set=ON_ERROR_STOP=1',
      ...statements.flatMap((statement) => ['--command', statement]),
    ],
    env: { PGPASSWORD: rootOrThrow(ctx) },
    timeoutMs: 60_000,
  });

  if (result.exitCode !== 0) {
    throw new DatabaseError(
      `PostgreSQL refused the change: ${result.stderr.trim() || 'unknown error'}`,
    );
  }

  return result.stdout;
}

async function exists(ctx: EngineContext, query: string): Promise<boolean> {
  return (await runPsql(ctx, [query])).trim() !== '';
}

export const postgresAdapter: DatabaseAdapter = {
  engine: 'postgres',

  async installed(binDir) {
    return (await findExecutable(engineBinDir(binDir, 'postgres'), ['psql.exe'])) !== null;
  },

  configured(ctx) {
    return readRootPassword(ctx.db, ctx.vault, 'postgres') !== null;
  },

  async provision(ctx, account, password) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);
    const secret = pgDollarQuoted(password);

    // CREATE ROLE and ALTER ROLE are separate statements rather than a DO
    // block: the block's body is itself a quoted string, and nesting the
    // password's quoting inside it is the kind of cleverness that turns into
    // an injection the day somebody edits it.
    const roleExists = await exists(
      ctx,
      `SELECT 1 FROM pg_roles WHERE rolname = ${nameLiteral(username)}`,
    );

    await runPsql(ctx, [
      roleExists
        ? `ALTER ROLE ${ident(username)} WITH LOGIN PASSWORD ${secret}`
        : `CREATE ROLE ${ident(username)} WITH LOGIN PASSWORD ${secret}`,
    ]);

    const dbExists = await exists(
      ctx,
      `SELECT 1 FROM pg_database WHERE datname = ${nameLiteral(name)}`,
    );

    if (!dbExists) {
      // template0 rather than template1: a superuser may have installed
      // extensions into template1, and every customer database inheriting
      // them is not a decision this panel should make on their behalf.
      await runPsql(ctx, [
        `CREATE DATABASE ${ident(name)} OWNER ${ident(username)} ` +
          `ENCODING 'UTF8' TEMPLATE template0`,
      ]);
    }

    await runPsql(ctx, [
      // The isolation. Without it every role on the server can connect here.
      `REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`,
      `GRANT ALL ON DATABASE ${ident(name)} TO ${ident(username)}`,
      `ALTER DATABASE ${ident(name)} OWNER TO ${ident(username)}`,
    ]);
  },

  async drop(ctx, account) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);

    // FORCE closes whatever is still connected. Without it, a site that has
    // not been stopped keeps the database undroppable and the panel reports a
    // failure the person cannot act on.
    await runPsql(ctx, [`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`]);
    await runPsql(ctx, [`DROP ROLE IF EXISTS ${ident(username)}`]);
  },

  async list(ctx) {
    const stdout = await runPsql(ctx, [
      'SELECT datname FROM pg_database WHERE NOT datistemplate',
    ]);

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  },

  async sizeOf(ctx, name) {
    const stdout = await runPsql(ctx, [
      `SELECT pg_database_size(${nameLiteral(name)})`,
    ]).catch(() => '');

    const bytes = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(bytes) ? bytes : null;
  },
};
