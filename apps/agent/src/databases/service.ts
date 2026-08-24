import { eq } from 'drizzle-orm';
import {
  databaseEngineInfo,
  databaseUriTemplate,
  type DatabaseConnection,
  type DatabaseEngine,
} from '@winpanel/shared';
import { sites, users } from '../db/schema.js';
import { DatabaseError } from './errors.js';
import {
  assertSafeDbName,
  assertSafeLabel,
  generatePassword,
  sitePrefix,
  userPrefix,
} from './names.js';
import { adapterFor } from './registry.js';
import {
  deleteDatabasePassword,
  readDatabasePassword,
  writeDatabasePassword,
} from './secrets.js';
import {
  countDatabasesForOwner,
  findDatabaseByName,
  forgetDatabase,
  listDatabasesForSite,
  recordDatabase,
  type DatabaseRecord,
  type DatabaseSummary,
} from './store.js';
import type { EngineContext } from './types.js';

/**
 * Making, removing and re-keying a database, whichever engine it is on.
 *
 * The order of operations matters and is the same every time: the server is
 * changed first, and the panel's record is written only once that succeeded.
 * The other way round leaves a panel confidently listing a database that does
 * not exist, which is far harder for anyone to recover from than a database
 * the panel has forgotten (which the reconciliation on the next listing finds
 * again anyway).
 */

export interface CreateDatabaseOptions {
  ctx: EngineContext;
  engine: DatabaseEngine;
  /** The part of the name the person chose. The prefix is added here. */
  label: string;
  /** The website this database is for, if it is for one. */
  site: { id: string; ownerUserId: string | null } | null;
  /** Whose database this is. Null only for one an administrator keeps. */
  ownerUserId: string | null;
  /** Their own password, or nothing to have one generated. */
  password?: string | undefined;
}

export interface CreatedDatabase {
  id: string;
  engine: DatabaseEngine;
  name: string;
  username: string;
  /** Returned once. Afterwards it is only ever in the vault. */
  password: string;
  generated: boolean;
}

/**
 * The full name a database gets.
 *
 * A website's databases are named after the website and a person's after the
 * person, because the three servers each have one flat namespace shared by
 * every customer on the machine. Without a prefix, the second customer to ask
 * for `shop` would either be refused for no reason they could see, or — far
 * worse — handed the first one's data.
 */
export function fullDatabaseName(
  label: string,
  site: { id: string } | null,
  ownerUserId: string | null,
): string {
  const prefix = site ? sitePrefix(site.id) : userPrefix(ownerUserId ?? 'server');
  return assertSafeDbName(`${prefix}_${assertSafeLabel(label)}`);
}

/** How the panel tells somebody to connect to their database. */
export function connectionFor(record: DatabaseRecord): DatabaseConnection {
  const info = databaseEngineInfo(record.engine);

  return {
    engine: record.engine,
    host: '127.0.0.1',
    port: info.port,
    database: record.name,
    username: record.username,
    uriTemplate: databaseUriTemplate(record.engine, record.username, record.name),
  };
}

export async function createDatabase(options: CreateDatabaseOptions): Promise<CreatedDatabase> {
  return await provisionNamed({
    ctx: options.ctx,
    engine: options.engine,
    name: fullDatabaseName(options.label, options.site, options.ownerUserId),
    siteId: options.site?.id ?? null,
    ownerUserId: options.ownerUserId,
    password: options.password,
    label: options.label,
  });
}

/**
 * Creates a database under a name the caller has already decided on.
 *
 * Used where the name is not a person's choice — WordPress' own database is
 * named after the site it belongs to and has been since before there was a
 * page to create one from, and renaming it on upgrade would take every
 * existing WordPress site offline.
 */
export async function provisionNamed(options: {
  ctx: EngineContext;
  engine: DatabaseEngine;
  name: string;
  siteId: string | null;
  ownerUserId: string | null;
  password?: string | undefined;
  /** What to call it in an error, if it is not the name itself. */
  label?: string;
}): Promise<CreatedDatabase> {
  const { ctx, engine } = options;
  const adapter = adapterFor(engine);

  if (!(await adapter.installed(ctx.binDir))) {
    throw new DatabaseError(
      `${databaseEngineInfo(engine).product} is not installed on this server.`,
    );
  }
  if (!adapter.configured(ctx)) {
    throw new DatabaseError(
      `${databaseEngineInfo(engine).product} has not finished setting itself up. ` +
        'Reinstall it from the Programs section of Settings.',
    );
  }

  const name = assertSafeDbName(options.name);

  if (findDatabaseByName(ctx.db, engine, name)) {
    throw new DatabaseError(
      `There is already a database called ${options.label ?? name} here.`,
    );
  }

  const chosen = options.password?.trim() ? options.password : null;
  const password = chosen ?? generatePassword();

  await adapter.provision(ctx, { name, username: name }, password);

  writeDatabasePassword(ctx.db, ctx.vault, engine, name, password);
  const id = recordDatabase(ctx.db, {
    engine,
    name,
    username: name,
    siteId: options.siteId,
    ownerUserId: options.ownerUserId,
  });

  return { id, engine, name, username: name, password, generated: chosen === null };
}

/** Removes a database, its login, its stored password and the panel's record. */
export async function removeDatabase(ctx: EngineContext, record: DatabaseRecord): Promise<void> {
  const adapter = adapterFor(record.engine);

  if (await adapter.installed(ctx.binDir)) {
    await adapter.drop(ctx, { name: record.name, username: record.username });
  }

  deleteDatabasePassword(ctx.db, record.engine, record.name, record.siteId);
  forgetDatabase(ctx.db, record.id);
}

/**
 * Sets a new password on an existing database.
 *
 * Re-provisioning is how every engine here does this: the create path already
 * has to cope with the database being there, so a reset is the same call with
 * a different secret rather than a second code path that could drift from it.
 */
export async function resetDatabasePassword(
  ctx: EngineContext,
  record: DatabaseRecord,
  chosen?: string | undefined,
): Promise<{ password: string; generated: boolean }> {
  const supplied = chosen?.trim() ? chosen : null;
  const password = supplied ?? generatePassword();

  await adapterFor(record.engine).provision(
    ctx,
    { name: record.name, username: record.username },
    password,
  );

  writeDatabasePassword(ctx.db, ctx.vault, record.engine, record.name, password);
  return { password, generated: supplied === null };
}

/** A database's stored password, for showing to whoever owns it. */
export function revealDatabasePassword(ctx: EngineContext, record: DatabaseRecord): string | null {
  return readDatabasePassword(ctx.db, ctx.vault, record.engine, record.name, record.siteId);
}

/**
 * Brings databases the panel made before it kept records into the fold.
 *
 * Site databases used to be found by listing MariaDB and matching a name
 * prefix, which is why upgrading must not make somebody's WordPress database
 * disappear from their panel. Every MariaDB database whose name starts with
 * one of these sites' prefixes and which has no record yet gets one,
 * attributed to that site's owner.
 *
 * The server is asked once for every site rather than once per site: on a
 * machine with two hundred websites, the per-site version was two hundred
 * round trips to draw one page.
 *
 * Silent when MariaDB is not installed or is not answering: this runs on the
 * way to showing a page, and a database server that is down is a thing to
 * report there, not to fail the whole listing over.
 */
export async function adoptLegacyDatabases(
  ctx: EngineContext,
  sites: ReadonlyArray<{ id: string; ownerUserId: string | null }>,
): Promise<void> {
  if (sites.length === 0) return;

  const adapter = adapterFor('mariadb');
  if (!(await adapter.installed(ctx.binDir)) || !adapter.configured(ctx)) return;

  const names = await adapter.list(ctx).catch(() => []);
  if (names.length === 0) return;

  for (const site of sites) {
    const prefix = sitePrefix(site.id);
    const known = new Set(listDatabasesForSite(ctx.db, site.id).map((entry) => entry.name));

    for (const name of names) {
      // The bare prefix is WordPress' own database, which predates the naming
      // scheme that puts a chosen label after it.
      if (name !== prefix && !name.startsWith(`${prefix}_`)) continue;
      if (known.has(name)) continue;

      recordDatabase(ctx.db, {
        engine: 'mariadb',
        name,
        username: name,
        siteId: site.id,
        ownerUserId: site.ownerUserId,
      });
    }
  }
}

/**
 * Drops the records for databases that are no longer on their server.
 *
 * Somebody with a command line can remove a database the panel made, and a
 * panel that goes on listing it — offering to open it, counting it against an
 * allowance — is worse than one that quietly notices. The engine is only asked
 * once per listing, and an engine that cannot be reached is left alone: "the
 * server is down" must never be mistaken for "the databases are gone".
 */
export async function reconcile(
  ctx: EngineContext,
  records: readonly DatabaseSummary[],
): Promise<DatabaseSummary[]> {
  const engines = [...new Set(records.map((record) => record.engine))];
  const present = new Map<DatabaseEngine, Set<string>>();

  await Promise.all(
    engines.map(async (engine) => {
      const adapter = adapterFor(engine);
      if (!(await adapter.installed(ctx.binDir)) || !adapter.configured(ctx)) return;

      const names = await adapter.list(ctx).catch(() => null);
      if (names) present.set(engine, new Set(names));
    }),
  );

  const kept: DatabaseSummary[] = [];

  for (const record of records) {
    const names = present.get(record.engine);
    if (names && !names.has(record.name)) {
      deleteDatabasePassword(ctx.db, record.engine, record.name, record.siteId);
      forgetDatabase(ctx.db, record.id);
      continue;
    }
    kept.push(record);
  }

  return kept;
}

/**
 * What an account may still create.
 *
 * Two allowances apply, and both have to hold. The account's own limit is what
 * was sold to them; a website's limit is how much of that they may spend on
 * one site. Either being null means unlimited, which is what an administrator
 * and the owner always have.
 */
export interface Allowance {
  /** Null for no limit. */
  limit: number | null;
  used: number;
  /** Set when something is in the way, phrased for the person reading it. */
  problem: string | null;
}

export function accountAllowance(
  ctx: EngineContext,
  ownerUserId: string | null,
): Allowance {
  if (!ownerUserId) return { limit: null, used: 0, problem: null };

  const owner = ctx.db.db
    .select({ limit: users.databaseLimit })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .get();

  const limit = owner?.limit ?? null;
  const used = countDatabasesForOwner(ctx.db, ownerUserId);

  return {
    limit,
    used,
    problem:
      limit !== null && used >= limit
        ? limit === 0
          ? 'Databases are not included on this account. Ask your administrator to add them.'
          : `This account can have up to ${limit} ${limit === 1 ? 'database' : 'databases'}. ` +
            'Remove one, or ask your administrator to raise the limit.'
        : null,
  };
}

export function siteAllowance(ctx: EngineContext, siteId: string): Allowance {
  const site = ctx.db.db
    .select({ limit: sites.databaseLimit })
    .from(sites)
    .where(eq(sites.id, siteId))
    .get();

  const limit = site?.limit ?? null;
  const used = listDatabasesForSite(ctx.db, siteId).length;

  return {
    limit,
    used,
    problem:
      limit !== null && used >= limit
        ? limit === 0
          ? 'This website is not allowed databases. Ask your administrator to allow them.'
          : `This website can have up to ${limit} ${limit === 1 ? 'database' : 'databases'}. ` +
            'Remove one, or ask your administrator to raise the limit.'
        : null,
  };
}
