import type { Document } from 'mongodb';
import { DatabaseError } from './errors.js';
import { assertSafeDbName } from './names.js';
import { withMongo } from './mongodb.js';
import { readDatabasePassword } from './secrets.js';
import type { DatabaseRecord } from './store.js';
import type { EngineContext } from './types.js';

/**
 * Looking inside a MongoDB database.
 *
 * Adminer covers the two SQL engines, and its MongoDB driver needs a PECL
 * extension that PHP on Windows does not ship — so rather than leave MongoDB
 * as the engine you cannot see into, the panel reads it directly through the
 * driver it already uses to create databases.
 *
 * Deliberately read-only. A viewer that can also delete is a much larger
 * promise: it needs confirmation flows, an audit trail of what was changed and
 * a way back from a mistake. Browsing is what people actually want from a
 * hosting panel, and everything else is a connection string away.
 *
 * The connection is made as the database's own login, never as the
 * administrator. That way the worst a bug here can do is show somebody their
 * own data.
 */

/** How much of a document is worth sending to a browser at once. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

function credentialsFor(
  ctx: EngineContext,
  record: DatabaseRecord,
): { username: string; password: string; authSource: string } {
  if (record.engine !== 'mongodb') {
    throw new DatabaseError('Only MongoDB databases are browsed this way.');
  }

  const password = readDatabasePassword(ctx.db, ctx.vault, 'mongodb', record.name, record.siteId);
  if (!password) {
    throw new DatabaseError(
      'The panel no longer holds a password for that database, so it cannot open it. ' +
        'Set a new password and try again.',
    );
  }

  return {
    username: record.username,
    password,
    // The user was created inside its own database, which is where it has to
    // authenticate — `admin` would refuse it.
    authSource: assertSafeDbName(record.name),
  };
}

export interface CollectionSummary {
  name: string;
  documents: number;
  storageBytes: number | null;
}

export async function browseCollections(
  ctx: EngineContext,
  record: DatabaseRecord,
): Promise<{ collections: CollectionSummary[] }> {
  const credentials = credentialsFor(ctx, record);

  return await withMongo(credentials, async (client) => {
    const database = client.db(record.name);
    const names = await database.listCollections({}, { nameOnly: true }).toArray();

    const collections = await Promise.all(
      names
        .filter((entry) => !entry.name.startsWith('system.'))
        .map(async (entry) => {
          const stats = (await database
            .command({ collStats: entry.name })
            .catch(() => null)) as Document | null;

          return {
            name: entry.name,
            documents: Number(stats?.['count'] ?? 0),
            storageBytes: stats ? Number(stats['storageSize'] ?? 0) : null,
          };
        }),
    );

    return { collections: collections.sort((a, b) => a.name.localeCompare(b.name)) };
  });
}

/**
 * Parses the filter somebody typed.
 *
 * It arrives as text because that is how a MongoDB query is written
 * everywhere else, and refusing anything that is not a plain object is the
 * whole check: a filter is data handed to the driver, not code, so there is
 * nothing to escape — but an array or a bare string would be a confusing
 * failure deep inside the driver rather than a clear one here.
 */
export function parseFilter(text: string | undefined): Document {
  const trimmed = text?.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DatabaseError('That filter is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DatabaseError('A filter has to be a JSON object, such as {"name": "Ada"}.');
  }

  return parsed as Document;
}

export interface DocumentPage {
  collection: string;
  total: number;
  page: number;
  pageSize: number;
  /** Each document rendered as formatted JSON, ready to show. */
  documents: string[];
  /** True when a document was too large to send whole. */
  truncated: boolean;
}

export async function browseDocuments(
  ctx: EngineContext,
  record: DatabaseRecord,
  options: { collection: string; page: number; pageSize: number; filter?: string },
): Promise<DocumentPage> {
  const credentials = credentialsFor(ctx, record);
  const filter = parseFilter(options.filter);

  return await withMongo(credentials, async (client) => {
    const collection = client.db(record.name).collection(options.collection);

    /*
     * An estimate is not good enough here — the count is what the paging is
     * built from, and a filtered count has to be exact or the last page is
     * either missing or empty. Capped so a filter matching a hundred million
     * documents cannot hold the connection open counting them.
     */
    const total = await collection.countDocuments(filter, { limit: 100_000 });

    const rows = await collection
      .find(filter)
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .toArray();

    let truncated = false;

    const documents = rows.map((row) => {
      // The driver's own JSON shape, which keeps ObjectIds and dates legible
      // rather than turning them into empty objects.
      const text = JSON.stringify(row, jsonSafeReplacer, 2);
      if (text.length <= MAX_DOCUMENT_BYTES) return text;

      truncated = true;
      return `${text.slice(0, MAX_DOCUMENT_BYTES)}\n\u2026 (this document is too large to show in full)`;
    });

    return {
      collection: options.collection,
      total,
      page: options.page,
      pageSize: options.pageSize,
      documents,
      truncated,
    };
  });
}

/**
 * Renders the types a MongoDB document holds but JSON does not.
 *
 * Without this an ObjectId serialises as `{}` and a Buffer as a wall of byte
 * indices, which makes the browser useless for exactly the documents people
 * most want to look at.
 */
function jsonSafeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  ) {
    return (value as { toHexString: () => string }).toHexString();
  }
  return value;
}
