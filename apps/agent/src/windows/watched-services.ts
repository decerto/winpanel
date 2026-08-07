import { inArray } from 'drizzle-orm';
import { config } from '../config.js';
import type { DatabaseHandle } from '../db/index.js';
import { jobs, sites } from '../db/schema.js';
import { AGENT_SERVICE_ID, siteServiceId } from './panel-services.js';
import type { ServiceRecovery } from './service-manager.js';
import { WATCHED_SERVICES, type WatchedService } from './service-watchdog.js';
import {
  clearStrayListeners,
  describeHolder,
  listPortHolders,
  partitionHolders,
} from './stray-processes.js';

/**
 * Which ports and executables each supervised service owns.
 *
 * Needed wherever the panel has to tell "this service is down" apart from
 * "this service is down because its own orphan still has the socket". The
 * components are a fixed list; websites are not, so they are read from the
 * database every time rather than captured once at start-up — a site created
 * five minutes ago has to be watched as closely as one created last year.
 *
 * The ports come from the database rather than from the service's own
 * configuration file on purpose. The panel allocated them, so it knows them
 * exactly, and a website is free to call its port variable whatever it likes
 * — guessing it out of the environment would eventually match something like
 * `SMTP_PORT` and aim a kill at the wrong process.
 */

/** The executables a site of each runtime can legitimately be running as. */
const RUNTIME_IMAGES: Record<string, readonly string[]> = {
  node: ['node.exe'],
  dotnet: ['dotnet.exe'],
};

/**
 * The panel itself, which can be unblocked but is never watched.
 *
 * Its orphan holds `bin\node\node.exe` open, which is exactly what makes an
 * update fail on a file the user cannot connect to any program — so stopping
 * the panel before an update has to be able to clear it.
 *
 * Left out of `watchdogServices` deliberately. The watchdog runs inside the
 * panel, so the only way it could ever find the panel's service stopped with
 * something of ours on the panel's port is if that something were itself.
 */
const PANEL_SERVICE: WatchedService = {
  id: AGENT_SERVICE_ID,
  label: 'control panel',
  images: ['node.exe'],
  ports: [config.port],
};

/**
 * Sites with a deploy in flight, which must be left entirely alone.
 *
 * A deploy stops the service on purpose, swaps the folder underneath it and
 * starts it again. Anything else starting it in the middle of that is fighting
 * the deploy for the same files, and the deploy is the one that knows what it
 * is doing.
 */
function sitesMidDeploy(db: DatabaseHandle): Set<string> {
  const rows = db.db
    .select({ siteId: jobs.siteId })
    .from(jobs)
    .where(inArray(jobs.status, ['pending', 'running']))
    .all();

  return new Set(rows.map((row) => row.siteId).filter((id): id is string => id !== null));
}

/**
 * One entry per website service that has a process at all.
 *
 * Both colours are included. Each has its own port and its own service, both
 * are set to start automatically, and the inactive one is just as capable of
 * being blocked by an orphan as the live one.
 */
export function siteWatchedServices(db: DatabaseHandle): WatchedService[] {
  const rows = db.db
    .select({
      id: sites.id,
      slug: sites.slug,
      runtime: sites.runtime,
      portBlue: sites.portBlue,
      portGreen: sites.portGreen,
    })
    .from(sites)
    .all();

  const watched: WatchedService[] = [];

  for (const row of rows) {
    const images = RUNTIME_IMAGES[row.runtime];
    if (!images) continue;

    for (const [colour, port] of [
      ['blue', row.portBlue],
      ['green', row.portGreen],
    ] as const) {
      if (port === null) continue;

      watched.push({
        id: siteServiceId(row.slug, colour),
        // Reads as "the <slug> website" in the sentences this appears in.
        label: `${row.slug} website`,
        images,
        ports: [port],
        siteId: row.id,
      });
    }
  }

  return watched;
}

/**
 * Everything the panel supervises: its components and every website.
 *
 * This is what the watchdog acts on, so a website with a deploy in flight is
 * left out. A deploy stops the service on purpose, swaps the folder underneath
 * it and starts it again; anything else starting it in the middle is fighting
 * the deploy over the same files, and the deploy is the one that knows what it
 * is doing.
 */
export function watchdogServices(db: DatabaseHandle): WatchedService[] {
  const busy = sitesMidDeploy(db);

  return [
    ...WATCHED_SERVICES,
    ...siteWatchedServices(db).filter((service) => !service.siteId || !busy.has(service.siteId)),
  ];
}

/**
 * Every supervised service, whatever it happens to be doing.
 *
 * Used to answer "which ports does this service own", which stays true during
 * a deploy and has to: the deploy itself is one of the callers.
 */
export function allWatchedServices(db: DatabaseHandle): WatchedService[] {
  return [PANEL_SERVICE, ...WATCHED_SERVICES, ...siteWatchedServices(db)];
}

export function watchedServiceFor(db: DatabaseHandle, id: string): WatchedService | undefined {
  const lower = id.toLowerCase();
  return allWatchedServices(db).find((service) => service.id.toLowerCase() === lower);
}

/**
 * Frees a service's own ports so a start that failed on `EADDRINUSE` can be
 * retried. Reports whether anything was actually cleared, because retrying a
 * start that failed for some other reason only wastes the user's time.
 */
export async function unblockService(db: DatabaseHandle, id: string): Promise<boolean> {
  const service = watchedServiceFor(db, id);
  if (!service) return false;

  const { killed } = await clearStrayListeners(service.ports, service.images);
  return killed.length > 0;
}

/**
 * Names whatever is holding a service's ports that the panel must not end.
 *
 * Null when the port is free, or held only by the service's own processes,
 * which are cleared rather than described.
 */
export async function describeBlockers(db: DatabaseHandle, id: string): Promise<string | null> {
  const service = watchedServiceFor(db, id);
  if (!service) return null;

  const { foreign } = partitionHolders(await listPortHolders(service.ports), service.images);
  return foreign.length > 0 ? foreign.map(describeHolder).join(', ') : null;
}

/**
 * Both halves of port recovery, bound to a database.
 *
 * Handed to the service manager, and to anything else that has to start or
 * stop a service without knowing what a database is.
 */
export function createServiceRecovery(db: DatabaseHandle): ServiceRecovery {
  return {
    unblock: (id) => unblockService(db, id),
    describeBlockers: (id) => describeBlockers(db, id),
  };
}
