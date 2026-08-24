import type { Document, MongoClient } from 'mongodb';
import { MONGODB_PORT } from '@winpanel/shared';
import { findExecutable } from '../components/archive.js';
import { DatabaseError } from './errors.js';
import { assertSafeDbName } from './names.js';
import { readRootPassword } from './secrets.js';
import type { DatabaseNetworkPolicy } from './network.js';
import type { DatabaseSummary } from './store.js';
import { engineBinDir, ENGINE_ROOT_USER, type DatabaseAdapter, type EngineContext } from './types.js';

/**
 * MongoDB.
 *
 * The odd one out, and deliberately so. MongoDB has shipped no command-line
 * shell since 6.0 — `mongosh` is a separate fifty-megabyte download — so
 * driving it the way the two SQL engines are driven would mean installing a
 * second large program purely to type three commands at it. The official
 * driver is plain JavaScript, is already a dependency, and speaks the same
 * protocol the panel's own document browser needs anyway.
 *
 * The driver is imported on demand rather than at start-up: a server with no
 * MongoDB on it should not pay for loading it.
 */

const URI = `mongodb://127.0.0.1:${MONGODB_PORT}/?directConnection=true`;

/**
 * A connected client, closed however the work turns out.
 *
 * Connections are not pooled across calls on purpose. Database administration
 * happens a handful of times a day; holding a socket open between those is
 * more to go wrong than it saves.
 */
export async function withMongo<T>(
  options: { username?: string; password?: string; authSource?: string },
  work: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const { MongoClient: Client } = await import('mongodb');

  const client = new Client(URI, {
    // Omitted entirely when there are no credentials: that is the localhost
    // exception, and offering empty ones turns it into a failed sign-in.
    ...(options.username
      ? { auth: { username: options.username, password: options.password ?? '' } }
      : {}),
    authSource: options.authSource ?? 'admin',
    // Loopback. If it does not answer in five seconds it is not running.
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });

  try {
    return await work(client);
  } catch (error) {
    throw new DatabaseError(
      `MongoDB refused the request: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

function rootOrThrow(ctx: EngineContext): string {
  const root = readRootPassword(ctx.db, ctx.vault, 'mongodb');
  if (!root) {
    throw new DatabaseError(
      'MongoDB has not been set up. Reinstall it from the Programs section of Settings.',
    );
  }
  return root;
}

async function asRoot<T>(ctx: EngineContext, work: (client: MongoClient) => Promise<T>): Promise<T> {
  return await withMongo(
    { username: ENGINE_ROOT_USER.mongodb, password: rootOrThrow(ctx), authSource: 'admin' },
    work,
  );
}

/** True when a command failed because the user is already there. */
function isDuplicateUser(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  return code === 51003 || /already exists/i.test(String((error as Error)?.message ?? ''));
}

/**
 * Where one login is allowed to connect from.
 *
 * MongoDB has no per-host accounts the way MariaDB does, so the equivalent is
 * an authentication restriction on the user itself. Without it, the moment any
 * one database opened the port every other login on the server would answer to
 * the whole internet as well.
 *
 * An empty list means unrestricted, which is only ever used when the owner
 * asked for exactly that, or when the port is shut anyway.
 */
export function mongoAuthRestrictions(
  policy: DatabaseNetworkPolicy,
  engineRemote: boolean,
): Array<{ clientSource: string[] }> {
  if (!engineRemote || policy.mode === 'any') return [];

  return [{ clientSource: ['127.0.0.1', '::1', ...policy.remoteCidrs] }];
}

/** Brings every login's allowed sources in line with its own database's policy. */
export async function syncMongoAccessRestrictions(
  ctx: EngineContext,
  records: readonly DatabaseSummary[],
  engineRemote: boolean,
): Promise<void> {
  if (records.length === 0) return;

  await asRoot(ctx, async (client) => {
    for (const record of records) {
      await client.db(assertSafeDbName(record.name)).command({
        updateUser: assertSafeDbName(record.username),
        authenticationRestrictions: mongoAuthRestrictions(record.network, engineRemote),
      });
    }
  });
}

export const mongodbAdapter: DatabaseAdapter = {
  engine: 'mongodb',

  async installed(binDir) {
    return (await findExecutable(engineBinDir(binDir, 'mongodb'), ['mongod.exe'])) !== null;
  },

  configured(ctx) {
    return readRootPassword(ctx.db, ctx.vault, 'mongodb') !== null;
  },

  async provision(ctx, account, password) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);

    await asRoot(ctx, async (client) => {
      const database = client.db(name);

      /*
       * The user is created in the database it owns, not in `admin`, so its
       * credentials are only meaningful there — which is what stops one
       * customer's connection string from reaching another's data. `dbOwner`
       * is everything within that one database and nothing outside it.
       */
      try {
        await database.command({
          createUser: username,
          pwd: password,
          roles: [{ role: 'dbOwner', db: name }],
        });
      } catch (error) {
        if (!isDuplicateUser(error)) throw error;
        // Already there: this is a password reset rather than a first create.
        await database.command({ updateUser: username, pwd: password });
      }

      /*
       * MongoDB creates a database when something is first written to it, so
       * one that has only had a user added is invisible to `listDatabases` and
       * to any tool that enumerates. A single empty collection makes it real,
       * which is what makes the database browser show something other than
       * "not found" the first time it is opened.
       */
      const collections = await database.listCollections({}, { nameOnly: true }).toArray();
      if (collections.length === 0) await database.createCollection('winpanel_placeholder');
    });
  },

  async drop(ctx, account) {
    const name = assertSafeDbName(account.name);
    const username = assertSafeDbName(account.username);

    await asRoot(ctx, async (client) => {
      const database = client.db(name);
      // The user first: dropping a database does not remove logins defined on
      // it, and one left behind would block the name being used again.
      await database.command({ dropUser: username }).catch(() => undefined);
      await database.dropDatabase();
    });
  },

  async list(ctx) {
    return await asRoot(ctx, async (client) => {
      const result = await client.db('admin').admin().listDatabases({ nameOnly: true });
      return result.databases.map((entry) => entry.name);
    });
  },

  async sizeOf(ctx, name) {
    assertSafeDbName(name);

    return await asRoot(ctx, async (client) => {
      const stats = (await client.db(name).command({ dbStats: 1 })) as Document;
      const bytes = Number(stats['storageSize'] ?? stats['dataSize'] ?? 0);
      return Number.isFinite(bytes) ? bytes : null;
    }).catch(() => null);
  },
};
