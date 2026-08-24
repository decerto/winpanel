import { findExecutable } from '../components/archive.js';
import { runCommand } from '../process/run-command.js';
import { DatabaseError } from './errors.js';
import { assertSafeDbName, sqlStringLiteral } from './names.js';
import { readDatabasePassword, readRootPassword } from './secrets.js';
import type { DatabaseNetworkPolicy } from './network.js';
import type { DatabaseSummary } from './store.js';
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

/**
 * The `user@host` values one database's policy calls for, beyond loopback.
 *
 * MariaDB checks the host a connection came from as part of the account, so
 * the whitelist is enforced by the server and not only by the firewall. That
 * matters here: the port is opened for the whole machine as soon as any one
 * database asks for it, and without this every other database's login would
 * then answer from anywhere too.
 *
 * IPv6 entries are skipped because the listener is IPv4, so an account for one
 * could never be used.
 */
export function mariaDbRemoteHosts(policy: DatabaseNetworkPolicy): string[] {
  if (policy.mode === 'any') return ['%'];
  if (policy.mode !== 'whitelist') return [];

  return policy.remoteCidrs.flatMap((source) => {
    const [address, prefix] = source.split('/');
    if (!address || address.includes(':')) return [];
    if (prefix === undefined || prefix === '32') return [address];

    const bits = Number(prefix);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const dotted = [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.');
    return [`${address}/${dotted}`];
  });
}

/** Rejects anything that could not have come out of an address we validated. */
function hostLiteral(host: string): string {
  if (!/^[0-9a-f.:%/]+$/i.test(host)) throw new DatabaseError(`Unusable database host: ${host}`);
  return `'${host}'`;
}

/**
 * The statements that bring one account's remote hosts in line with its policy.
 *
 * `existingHosts` is what the server currently has, so hosts that are no longer
 * allowed are dropped rather than left behind quietly still working.
 */
export function mariaDbAccountPlan(
  record: Pick<DatabaseSummary, 'name' | 'username' | 'network'>,
  password: string,
  existingHosts: readonly string[],
): string[] {
  const name = assertSafeDbName(record.name);
  const username = assertSafeDbName(record.username);
  const literal = sqlStringLiteral(password);
  const wanted = mariaDbRemoteHosts(record.network);

  const statements = existingHosts
    .filter((host) => host !== '127.0.0.1' && host !== 'localhost' && !wanted.includes(host))
    .map((host) => `DROP USER IF EXISTS '${username}'@${hostLiteral(host)}`);

  for (const host of wanted) {
    statements.push(
      `CREATE USER IF NOT EXISTS '${username}'@${hostLiteral(host)} IDENTIFIED BY ${literal}`,
      `ALTER USER '${username}'@${hostLiteral(host)} IDENTIFIED BY ${literal}`,
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${username}'@${hostLiteral(host)}`,
    );
  }

  return statements;
}

/** Brings every account's reachable hosts in line with its own database's policy. */
export async function syncMariaDbRemoteAccounts(
  ctx: EngineContext,
  records: readonly DatabaseSummary[],
): Promise<void> {
  if (records.length === 0) return;

  const statements: string[] = [];

  for (const record of records) {
    const password = readDatabasePassword(ctx.db, ctx.vault, record.engine, record.name, record.siteId);
    if (!password) continue;

    const hosts = (
      await runSql(ctx, `SELECT Host FROM mysql.user WHERE User = ${sqlStringLiteral(record.username)};`)
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    statements.push(...mariaDbAccountPlan(record, password, hosts));
  }

  if (statements.length > 0) await runSql(ctx, `${statements.join('; ')}; FLUSH PRIVILEGES;`);
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

    const statements = [
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE USER IF NOT EXISTS '${username}'@'127.0.0.1' IDENTIFIED BY ${literal}`,
      `ALTER USER '${username}'@'127.0.0.1' IDENTIFIED BY ${literal}`,
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${username}'@'127.0.0.1'`,
    ];

    await runSql(ctx, `${statements.join('; ')}; FLUSH PRIVILEGES;`);
  },

  async drop(ctx, account) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);

    // Every host the account may have been reachable at, not just loopback:
    // one left behind would keep working and block the name being reused.
    const hosts = (
      await runSql(ctx, `SELECT Host FROM mysql.user WHERE User = ${sqlStringLiteral(username)};`)
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const drops = [...new Set([...hosts, '127.0.0.1', '%'])]
      .map((host) => `DROP USER IF EXISTS '${username}'@${hostLiteral(host)}`)
      .join('; ');

    await runSql(ctx, `DROP DATABASE IF EXISTS \`${name}\`; ${drops}; FLUSH PRIVILEGES;`);
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
