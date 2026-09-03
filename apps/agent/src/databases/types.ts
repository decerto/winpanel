import path from 'node:path';
import type { DatabaseEngine } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';

/**
 * What every database engine has to be able to do, and what it is given to do
 * it with.
 *
 * The panel treats the three engines as one feature, which only works if each
 * one can answer the same small set of questions. Anything engine-specific —
 * how a role is created, whether a database exists before something is written
 * to it — stays behind this interface.
 */

export interface EngineContext {
  db: DatabaseHandle;
  vault: SecretVault;
  /** Where components were installed, which is where the programs are. */
  binDir: string;
  signal?: AbortSignal;
}

export interface DatabaseAccount {
  /** The full database name, prefix and all. */
  name: string;
  /** The login that can reach it. Always the same as the name. */
  username: string;
  /** Used only for reading legacy credentials during a restore. */
  siteId?: string | null;
}

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;

  /** True when this engine's server has been installed. */
  installed(binDir: string): Promise<boolean>;

  /**
   * True when the panel holds the credentials it needs to make changes. False
   * means the server is installed but was never set up — a half-finished
   * install, which is worth saying out loud rather than failing later.
   */
  configured(ctx: EngineContext): boolean;

  /**
   * Creates the database and a login that can reach only it, or resets the
   * password of one that already exists. Both are the same operation on every
   * engine here, which is what makes "change this password" a one-liner.
   */
  provision(ctx: EngineContext, account: DatabaseAccount, password: string): Promise<void>;

  /** Removes the database and the login that could reach it. */
  drop(ctx: EngineContext, account: DatabaseAccount): Promise<void>;

  /** Replaces the existing database contents with a previously exported dump. */
  importDump(ctx: EngineContext, account: DatabaseAccount, source: string): Promise<void>;

  /**
   * Every database name the server itself holds. Used to reconcile the panel's
   * records with reality, so a database created before the panel kept records
   * — or removed behind its back — is not invented or forgotten.
   */
  list(ctx: EngineContext): Promise<string[]>;

  /** Bytes on disk, or null when the engine will not say cheaply. */
  sizeOf(ctx: EngineContext, name: string): Promise<number | null>;
}

/** The component folder each engine's programs live in. */
export const ENGINE_COMPONENT: Record<DatabaseEngine, 'mariadb' | 'postgres' | 'mongodb'> = {
  mariadb: 'mariadb',
  postgres: 'postgres',
  mongodb: 'mongodb',
};

/** The Windows service each engine's server runs as. */
export const ENGINE_SERVICE: Record<DatabaseEngine, string> = {
  mariadb: 'winpanel-mariadb',
  postgres: 'winpanel-postgres',
  mongodb: 'winpanel-mongodb',
};

/**
 * Where each engine keeps its files, under the panel's own data folder.
 *
 * MariaDB's is `database` rather than `mariadb` because that is where it has
 * always been, and moving it would strand every existing installation's data.
 */
export const ENGINE_DATA_DIR: Record<DatabaseEngine, string> = {
  mariadb: 'database',
  postgres: 'postgres',
  mongodb: 'mongodb',
};

/** The vault key each engine's administrative password is stored under. */
export const ENGINE_ROOT_SECRET: Record<DatabaseEngine, string> = {
  mariadb: 'mariadb.rootPassword',
  postgres: 'postgres.rootPassword',
  mongodb: 'mongodb.rootPassword',
};

/** The administrative account the panel makes its changes as. */
export const ENGINE_ROOT_USER: Record<DatabaseEngine, string> = {
  mariadb: 'root',
  // The name initdb gives the bootstrap superuser, and the one every
  // PostgreSQL tool assumes when none is given.
  postgres: 'postgres',
  // MongoDB has no default superuser at all; this one is created on first
  // start through the localhost exception.
  mongodb: 'winpanel_root',
};

/** The server program inside each engine's download. */
export const ENGINE_SERVER_EXE: Record<DatabaseEngine, string[]> = {
  mariadb: ['mariadbd.exe', 'mysqld.exe'],
  postgres: ['postgres.exe'],
  mongodb: ['mongod.exe'],
};

export function engineBinDir(binDir: string, engine: DatabaseEngine): string {
  return path.join(binDir, ENGINE_COMPONENT[engine]);
}

export function engineDataDir(dataDir: string, engine: DatabaseEngine): string {
  return path.join(dataDir, ENGINE_DATA_DIR[engine]);
}
