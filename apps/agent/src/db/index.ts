import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDatabase>['db'];

export interface DatabaseHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Opens the panel database.
 *
 * WAL is enabled because the agent reads (health checks, the panel UI polling)
 * concurrently with writes (job logs streaming in during a deploy), and the
 * default rollback journal would make readers block writers.
 */
export function createDatabase(filePath: string): DatabaseHandle {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const sqlite = new Database(filePath);

  sqlite.pragma('journal_mode = WAL');
  // Durable enough given WAL, without an fsync on every single job log line.
  sqlite.pragma('synchronous = NORMAL');
  // Off by default in SQLite; without it the `references` clauses are decorative.
  sqlite.pragma('foreign_keys = ON');
  // Fail fast rather than hanging a request when another writer holds the lock.
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

/** Applies any pending migrations. Safe to call on every start. */
export function migrateDatabase(handle: DatabaseHandle, migrationsFolder: string): void {
  migrate(handle.db, { migrationsFolder });
}

export { schema };
