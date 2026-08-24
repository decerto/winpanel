import { DATABASE_ENGINES, type DatabaseEngine } from '@winpanel/shared';
import { mariadbAdapter } from './mariadb.js';
import { mongodbAdapter } from './mongodb.js';
import { postgresAdapter } from './postgres.js';
import type { DatabaseAdapter, EngineContext } from './types.js';

/**
 * Which engine is which.
 *
 * Everything above this line works in terms of a `DatabaseEngine`; everything
 * below it knows about exactly one product. This is the only place the two
 * meet, which is what keeps "add a fourth engine" a matter of writing one
 * adapter rather than editing the router, the panel and the installer.
 */

const ADAPTERS: Record<DatabaseEngine, DatabaseAdapter> = {
  mariadb: mariadbAdapter,
  postgres: postgresAdapter,
  mongodb: mongodbAdapter,
};

export function adapterFor(engine: DatabaseEngine): DatabaseAdapter {
  return ADAPTERS[engine];
}

export interface EngineAvailability {
  engine: DatabaseEngine;
  /** The server's programs are on disk. */
  installed: boolean;
  /** The panel holds the credentials it needs to make changes. */
  ready: boolean;
}

/**
 * What this server can actually offer, asked once per page.
 *
 * The panel shows nothing at all for an engine that is not installed — no
 * greyed-out option, no "install this first" dropdown entry. An engine you do
 * not have is not a choice you are making.
 */
export async function engineAvailability(ctx: EngineContext): Promise<EngineAvailability[]> {
  return await Promise.all(
    DATABASE_ENGINES.map(async (info) => {
      const adapter = adapterFor(info.id);
      const installed = await adapter.installed(ctx.binDir).catch(() => false);

      return {
        engine: info.id,
        installed,
        ready: installed && adapter.configured(ctx),
      };
    }),
  );
}

/** The engines a database may actually be created on right now. */
export async function usableEngines(ctx: EngineContext): Promise<DatabaseEngine[]> {
  return (await engineAvailability(ctx))
    .filter((entry) => entry.ready)
    .map((entry) => entry.engine);
}
