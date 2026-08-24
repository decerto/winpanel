import { findExecutable } from '../components/archive.js';
import { runCommand } from '../process/run-command.js';
import { DatabaseError } from './errors.js';
import { assertSafeDbName, sqlStringLiteral } from './names.js';
import { readRootPassword } from './secrets.js';
import { engineBinDir, type DatabaseAccount, type DatabaseAdapter, type EngineContext } from './types.js';

/**
 * MariaDB, the MySQL-compatible engine WordPress and most PHP applications
 * expect.
 *
 * Every operation shells the `mariadb` client with the root password from the
 * vault, which keeps the whole feature on the same `runCommand` path as
 * everything else — no dependency speaking the wire protocol — and the
 * password is passed in the environment rather than as an argument, where it
 * would be visible to anything that can list this machine's processes.
 */

const CLIENT_NAMES = ['mariadb.exe', 'mysql.exe'];

async function client(binDir: string): Promise<string> {
  const found = await findExecutable(engineBinDir(binDir, 'mariadb'), CLIENT_NAMES);
  if (!found) {
    throw new DatabaseError(
      'MariaDB is not installed. Install it from the Programs section of Settings.',
    );
  }
  return found;
}

function rootOrThrow(ctx: EngineContext): string {
  const root = readRootPassword(ctx.db, ctx.vault, 'mariadb');
  if (!root) {
    throw new DatabaseError(
      'MariaDB has not been set up. Reinstall it from the Programs section of Settings.',
    );
  }
  return root;
}

/**
 * Runs SQL as root. The SQL is passed as a single argument so it is never
 * re-parsed by a shell — which is what makes a database name safe to
 * interpolate, but only after it has been through `assertSafeDbName`.
 */
async function runSql(ctx: EngineContext, sql: string): Promise<string> {
  const exe = await client(ctx.binDir);

  const result = await runCommand({
    exe,
    args: [
      '--user=root',
      '--host=127.0.0.1',
      '--port=3306',
      '--batch',
      '--skip-column-names',
      '--execute',
      sql,
    ],
    // MYSQL_PWD is how the client reads a password without it touching the
    // command line.
    env: { MYSQL_PWD: rootOrThrow(ctx) },
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new DatabaseError(
      `MariaDB refused the change: ${result.stderr.trim() || 'unknown error'}`,
    );
  }

  return result.stdout;
}

export const mariadbAdapter: DatabaseAdapter = {
  engine: 'mariadb',

  async installed(binDir) {
    return (await findExecutable(engineBinDir(binDir, 'mariadb'), CLIENT_NAMES)) !== null;
  },

  configured(ctx) {
    return readRootPassword(ctx.db, ctx.vault, 'mariadb') !== null;
  },

  async provision(ctx, account: DatabaseAccount, password) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);
    // The names are pinned to a safe shape above; the password is free text
    // and must be escaped before it is interpolated, or a crafted one could
    // end the statement early.
    const literal = sqlStringLiteral(password);

    await runSql(
      ctx,
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; ` +
        `CREATE USER IF NOT EXISTS '${username}'@'127.0.0.1' IDENTIFIED BY ${literal}; ` +
        // Re-stating the password is what makes this also a password reset.
        `ALTER USER '${username}'@'127.0.0.1' IDENTIFIED BY ${literal}; ` +
        `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${username}'@'127.0.0.1'; FLUSH PRIVILEGES;`,
    );
  },

  async drop(ctx, account) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);

    await runSql(
      ctx,
      `DROP DATABASE IF EXISTS \`${name}\`; ` +
        `DROP USER IF EXISTS '${username}'@'127.0.0.1'; FLUSH PRIVILEGES;`,
    );
  },

  async list(ctx) {
    const stdout = await runSql(ctx, 'SHOW DATABASES;');
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  },

  async sizeOf(ctx, name) {
    assertSafeDbName(name);
    const stdout = await runSql(
      ctx,
      'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables ' +
        `WHERE table_schema = ${sqlStringLiteral(name)};`,
    ).catch(() => '');

    const bytes = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(bytes) ? bytes : null;
  },
};
