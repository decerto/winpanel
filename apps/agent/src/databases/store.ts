import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseEngine } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { hostedDatabases, sites, users } from '../db/schema.js';

/**
 * The panel's record of every database it has made.
 *
 * Reading ownership out of the database server was tried and does not work:
 * MongoDB will not list a database nothing has been written to, PostgreSQL
 * lists its own system databases alongside everybody's, and none of the three
 * has any idea which customer a database belongs to. So the panel keeps its
 * own record, and consults the server only to notice when something has been
 * removed behind its back.
 */

export interface DatabaseRecord {
  id: string;
  engine: DatabaseEngine;
  name: string;
  username: string;
  siteId: string | null;
  ownerUserId: string | null;
  createdAt: Date;
}

/** A record with the names a person would recognise attached. */
export interface DatabaseSummary extends DatabaseRecord {
  siteSlug: string | null;
  siteName: string | null;
  ownerUsername: string | null;
}

const SELECTION = {
  id: hostedDatabases.id,
  engine: hostedDatabases.engine,
  name: hostedDatabases.name,
  username: hostedDatabases.username,
  siteId: hostedDatabases.siteId,
  ownerUserId: hostedDatabases.ownerUserId,
  createdAt: hostedDatabases.createdAt,
  siteSlug: sites.slug,
  siteName: sites.displayName,
  ownerUsername: users.username,
};

function baseQuery(db: DatabaseHandle) {
  return db.db
    .select(SELECTION)
    .from(hostedDatabases)
    .leftJoin(sites, eq(hostedDatabases.siteId, sites.id))
    .leftJoin(users, eq(hostedDatabases.ownerUserId, users.id));
}

/** Every database on the server, newest last. Admins only. */
export function listAllDatabases(db: DatabaseHandle): DatabaseSummary[] {
  return baseQuery(db).all() as DatabaseSummary[];
}

/** The databases one account owns, whatever website they are attached to. */
export function listDatabasesForOwner(db: DatabaseHandle, ownerUserId: string): DatabaseSummary[] {
  return baseQuery(db).where(eq(hostedDatabases.ownerUserId, ownerUserId)).all() as DatabaseSummary[];
}

export function listDatabasesForSite(db: DatabaseHandle, siteId: string): DatabaseSummary[] {
  return baseQuery(db).where(eq(hostedDatabases.siteId, siteId)).all() as DatabaseSummary[];
}

export function getDatabase(db: DatabaseHandle, id: string): DatabaseSummary | null {
  return (baseQuery(db).where(eq(hostedDatabases.id, id)).get() as DatabaseSummary | undefined) ?? null;
}

export function findDatabaseByName(
  db: DatabaseHandle,
  engine: DatabaseEngine,
  name: string,
): DatabaseSummary | null {
  return (
    (baseQuery(db)
      .where(and(eq(hostedDatabases.engine, engine), eq(hostedDatabases.name, name)))
      .get() as DatabaseSummary | undefined) ?? null
  );
}

/** How many databases an account holds, which is what its allowance is against. */
export function countDatabasesForOwner(db: DatabaseHandle, ownerUserId: string): number {
  return db.db
    .select({ id: hostedDatabases.id })
    .from(hostedDatabases)
    .where(eq(hostedDatabases.ownerUserId, ownerUserId))
    .all().length;
}

/** Databases nobody owns — made by an administrator for the server itself. */
export function countUnownedDatabases(db: DatabaseHandle): number {
  return db.db
    .select({ id: hostedDatabases.id })
    .from(hostedDatabases)
    .where(isNull(hostedDatabases.ownerUserId))
    .all().length;
}

export function recordDatabase(
  db: DatabaseHandle,
  entry: {
    engine: DatabaseEngine;
    name: string;
    username: string;
    siteId: string | null;
    ownerUserId: string | null;
  },
): string {
  const id = crypto.randomUUID();

  db.db
    .insert(hostedDatabases)
    .values({
      id,
      engine: entry.engine,
      name: entry.name,
      username: entry.username,
      siteId: entry.siteId,
      ownerUserId: entry.ownerUserId,
    })
    .run();

  return id;
}

export function forgetDatabase(db: DatabaseHandle, id: string): void {
  db.db.delete(hostedDatabases).where(eq(hostedDatabases.id, id)).run();
}
