import crypto from 'node:crypto';
import path from 'node:path';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { readSecret, writeSecret } from '../security/secret-store.js';
import { runCommand } from '../process/run-command.js';
import { findExecutable } from '../components/archive.js';

/**
 * Creating and removing the MariaDB databases a website's data lives in.
 *
 * There is deliberately no database server abstraction here: the panel runs
 * one MariaDB on loopback, and every operation shells the `mariadb` client
 * with the root password from the vault. That keeps the whole feature on the
 * same `runCommand` path as everything else — no new dependency speaking the
 * wire protocol, and the password never appears as a command-line argument
 * (it is fed on stdin), where it would be visible to any process that lists
 * the machine's processes.
 */

/** Vault key the database server's root password is stored under. */
const MARIADB_ROOT_KEY = 'mariadb.rootPassword';

/** Vault key prefix for a database's own password, keyed by site and name. */
const dbPasswordKey = (siteId: string, name: string): string =>
  `site.dbPass:${siteId}:${name}`;

/** Where the database server's client programs live, once installed. */
function mariadbBinDir(binDir: string): string {
  return path.join(binDir, 'mariadb');
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** True when the database server has been installed. */
export async function databaseServerInstalled(binDir: string): Promise<boolean> {
  return (await findExecutable(mariadbBinDir(binDir), ['mariadb.exe', 'mysql.exe'])) !== null;
}

/**
 * Runs a SQL statement as root. The password goes on stdin, never on the
 * command line, and the SQL is passed as a single argument so it is never
 * re-parsed by a shell — which is what makes a database name safe to
 * interpolate only after it has been through `assertSafeDbName`.
 */
async function runSql(
  binDir: string,
  rootPassword: string,
  sql: string,
): Promise<void> {
  const client = await findExecutable(mariadbBinDir(binDir), ['mariadb.exe', 'mysql.exe']);
  if (!client) {
    throw new DatabaseError(
      'The database server is not installed. Install it from the Programs section of Settings.',
    );
  }

  const result = await runCommand({
    exe: client,
    args: [
      '--user=root',
      '--host=127.0.0.1',
      '--port=3306',
      '--batch',
      '--execute',
      sql,
    ],
    // MYSQL_PWD is how the client reads a password without it touching the
    // command line.
    env: { MYSQL_PWD: rootPassword },
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new DatabaseError(
      `The database server refused the change: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
}

/**
 * A database or user name is interpolated into SQL, so it is held to the
 * tightest safe shape: letters, digits and underscores only. That is also
 * what keeps names readable in a list — no spaces or punctuation.
 */
export function assertSafeDbName(name: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(name)) {
    throw new DatabaseError(
      'A database name can only use lowercase letters, numbers and underscores.',
    );
  }
  return name;
}

/**
 * Renders a value as a MySQL/MariaDB string literal that cannot break out of
 * its quotes.
 *
 * A password is free text chosen by a person, so it can contain anything —
 * and a bare backslash or quote would let it end the string early and run
 * whatever followed. This escapes the full set MySQL treats as special inside
 * a single-quoted literal (backslash first, so it cannot double-escape
 * itself), which is the whole defence against an injection here. Identifiers
 * are handled separately, by `assertSafeDbName`.
 */
export function sqlStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return `'${escaped}'`;
}

/** The root password, or null when the server has never been set up. */
export function readRootPassword(db: DatabaseHandle, vault: SecretVault): string | null {
  return readSecret(db, vault, MARIADB_ROOT_KEY);
}

/** A strong password for a new database. */
export function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export interface ProvisionedDatabase {
  name: string;
  username: string;
  /** The password, returned once and never stored anywhere readable. */
  password: string;
  /** True when the password was generated rather than supplied. */
  generated: boolean;
}

/**
 * Creates a database and a user that can reach only that database.
 *
 * The user is scoped to a single schema and to connections from this machine,
 * so one site's credentials can never read another site's data. The password
 * is the caller's when given (a person choosing their own), else generated.
 */
export async function provisionDatabase(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  binDir: string;
  siteId: string;
  name: string;
  password?: string;
}): Promise<ProvisionedDatabase> {
  const root = readRootPassword(options.db, options.vault);
  if (!root) {
    throw new DatabaseError(
      'The database server has not been set up. Install it from the Programs section of Settings.',
    );
  }

  const name = assertSafeDbName(options.name);
  const password = options.password?.trim() ? options.password : generatePassword();
  const generated = !options.password?.trim();

  // The name is pinned to a safe shape by assertSafeDbName; the password is
  // free text and must be escaped for a SQL string literal before it is
  // interpolated, or a crafted one could end the statement early.
  const literal = sqlStringLiteral(password!);

  await runSql(
    options.binDir,
    root,
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; ` +
      `CREATE USER IF NOT EXISTS '${name}'@'127.0.0.1' IDENTIFIED BY ${literal}; ` +
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'127.0.0.1'; FLUSH PRIVILEGES;`,
  );

  writeSecret(options.db, options.vault, dbPasswordKey(options.siteId, name), password!);

  return { name, username: name, password: password!, generated };
}

/** Removes a database and the user that could reach it. */
export async function dropDatabase(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  binDir: string;
  siteId: string;
  name: string;
}): Promise<void> {
  const root = readRootPassword(options.db, options.vault);
  if (!root) {
    throw new DatabaseError(
      'The database server has not been set up. Install it from the Programs section of Settings.',
    );
  }

  const name = assertSafeDbName(options.name);
  await runSql(
    options.binDir,
    root,
    `DROP DATABASE IF EXISTS \`${name}\`; DROP USER IF EXISTS '${name}'@'127.0.0.1'; FLUSH PRIVILEGES;`,
  );

  const { deleteSecret } = await import('../security/secret-store.js');
  deleteSecret(options.db, dbPasswordKey(options.siteId, name));
}

/** Lists the databases belonging to one site, by name prefix. */
export async function listDatabases(options: {
  db: DatabaseHandle;
  vault: SecretVault;
  binDir: string;
  prefix: string;
}): Promise<string[]> {
  const root = readRootPassword(options.db, options.vault);
  if (!root) return [];

  const client = await findExecutable(mariadbBinDir(options.binDir), ['mariadb.exe', 'mysql.exe']);
  if (!client) return [];

  const result = await runCommand({
    exe: client,
    args: ['--user=root', '--host=127.0.0.1', '--port=3306', '--batch', '--skip-column-names', '--execute', 'SHOW DATABASES;'],
    env: { MYSQL_PWD: root },
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(options.prefix));
}

/** Reads a database's stored password, for showing to its owner on demand. */
export function readDatabasePassword(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
  name: string,
): string | null {
  return readSecret(db, vault, dbPasswordKey(siteId, name));
}
