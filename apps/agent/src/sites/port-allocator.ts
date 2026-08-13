import { and, eq, inArray } from 'drizzle-orm';
import {
  APP_PORT_RANGE_END,
  APP_PORT_RANGE_START,
  DOTNET_PORT_RANGE_END,
  DOTNET_PORT_RANGE_START,
  PHP_PORT_RANGE_END,
  PHP_PORT_RANGE_START,
  PHP_PORT_STRIDE,
  PREVIEW_PORT_RANGE_END,
  PREVIEW_PORT_RANGE_START,
  validateAssignablePort,
} from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { portAllocations, sites } from '../db/schema.js';
import { excludedPortRanges, isPortExcluded, isPortFree } from '../checks/server-checks.js';

/**
 * Hands out the loopback ports that hosted apps listen on.
 *
 * Each site gets a *pair*, once, when it is created. Only one is live at a
 * time; a release starts on the idle one, gets health-checked there, and
 * traffic is switched over. Deploying does not allocate anything — the same
 * two numbers are reused for the life of the site, alternating between them.
 * The pair is also why the panel never load-balances across both:
 * round-robin would break sticky sessions for anything using WebSockets.
 *
 * Allocation always scans from the bottom of the range, so a number given
 * back is the next one handed out. Nothing walks upward forever unless a row
 * is left behind, which is what `reclaimStalePorts` exists to prevent.
 */

export class PortAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortAllocationError';
  }
}

export interface AllocatedPair {
  blue: number;
  green: number;
}

/**
 * Whether a site is reached through a port at all.
 *
 * Static sites are served from disk by the web server itself, so a pair held
 * for one is two numbers nothing will ever listen on. At two numbers a site
 * and static being the commonest kind, handing them out regardless roughly
 * halved how many websites a server could hold.
 */
export function runtimeNeedsAppPorts(runtime: string): boolean {
  return runtime !== 'static';
}

export class PortAllocator {
  constructor(private readonly handle: DatabaseHandle) {}

  /** Ports already handed out to any site. */
  takenPorts(): Set<number> {
    const rows = this.handle.db.select({ port: portAllocations.port }).from(portAllocations).all();
    return new Set(rows.map((row) => row.port));
  }

  /**
   * Gives back every port no site is actually using.
   *
   * A row that outlives its purpose burns a number permanently, and the only
   * visible symptom is new sites starting further and further up the range
   * with apparently free numbers skipped underneath them. Four ways it
   * happens, all of them silent:
   *   - the site is gone, but the row survived a delete that predated foreign
   *     keys being enforced
   *   - a site creation failed after ports were handed out
   *   - the site is static and never needed a pair at all
   *   - the site's recorded ports were changed and the old rows stayed
   *
   * Safe to run at any time: a site part-way through creation has not written
   * its ports back yet, and is left alone.
   *
   * @returns the number of ports returned to the pool.
   */
  reclaimStalePorts(): number {
    const rows = this.handle.db
      .select({ allocation: portAllocations, site: sites })
      .from(portAllocations)
      .leftJoin(sites, eq(portAllocations.siteId, sites.id))
      .all();

    const stale: number[] = [];
    const unpair = new Set<string>();

    for (const { allocation, site } of rows) {
      if (!site) {
        stale.push(allocation.port);
        continue;
      }

      if (allocation.colour === 'preview') {
        if (site.previewPort !== null && site.previewPort !== allocation.port) {
          stale.push(allocation.port);
        }
        continue;
      }

      if (!runtimeNeedsAppPorts(site.runtime)) {
        stale.push(allocation.port);
        unpair.add(site.id);
        continue;
      }

      // Mid-creation: the pair is handed out before the site records it.
      if (site.portBlue === null || site.portGreen === null) continue;

      if (site.portBlue !== allocation.port && site.portGreen !== allocation.port) {
        stale.push(allocation.port);
      }
    }

    if (stale.length === 0) return 0;

    this.handle.db.transaction((tx) => {
      tx.delete(portAllocations).where(inArray(portAllocations.port, stale)).run();

      // Leaving the numbers on the site would point it at ports another site
      // is now free to take.
      for (const siteId of unpair) {
        tx.update(sites)
          .set({ portBlue: null, portGreen: null })
          .where(eq(sites.id, siteId))
          .run();
      }
    });

    return stale.length;
  }

  /**
   * Finds two free ports and records them against the site.
   *
   * Checks three things, because each catches a different failure:
   *   - the reserved list, so the panel's own port can never be taken
   *   - Windows' excluded ranges, which cause binds to fail while netstat
   *     shows nothing listening
   *   - an actual bind, which catches anything else already running
   */
  async allocatePair(
    siteId: string,
    runtime: 'node' | 'dotnet' | 'static' | 'proxy' | 'php' = 'node',
  ): Promise<AllocatedPair> {
    const existing = this.handle.db
      .select()
      .from(portAllocations)
      .where(eq(portAllocations.siteId, siteId))
      .all();

    const alreadyBlue = existing.find((row) => row.colour === 'blue');
    const alreadyGreen = existing.find((row) => row.colour === 'green');
    if (alreadyBlue && alreadyGreen) {
      return { blue: alreadyBlue.port, green: alreadyGreen.port };
    }

    /*
     * PHP is different: one php-cgi worker handles one request at a time, so
     * a site runs a small pool of them on consecutive ports. Each colour is
     * allocated a *block* of `PHP_PORT_STRIDE` ports and the recorded blue /
     * green number is the block's base; the pool uses base .. base+stride-1.
     */
    if (runtime === 'php') {
      return this.allocatePhpPair(siteId);
    }

    const [start, end] =
      runtime === 'dotnet'
        ? [DOTNET_PORT_RANGE_START, DOTNET_PORT_RANGE_END]
        : [APP_PORT_RANGE_START, APP_PORT_RANGE_END];

    const taken = this.takenPorts();
    const excluded = await excludedPortRanges();
    const found: number[] = [];

    for (let port = start; port <= end && found.length < 2; port++) {
      if (!validateAssignablePort(port, taken).ok) continue;
      if (isPortExcluded(port, excluded)) continue;
      if (found.includes(port)) continue;
      if (!(await isPortFree(port, '127.0.0.1'))) continue;
      found.push(port);
    }

    if (found.length < 2) {
      throw new PortAllocationError(
        'There are no free ports left for a new website. Remove an unused site and try again.',
      );
    }

    const [blue, green] = found as [number, number];

    this.handle.db.transaction((tx) => {
      tx.delete(portAllocations)
        .where(
          and(
            eq(portAllocations.siteId, siteId),
            inArray(portAllocations.colour, ['blue', 'green']),
          ),
        )
        .run();
      tx.insert(portAllocations).values([
        { port: blue, siteId, colour: 'blue' },
        { port: green, siteId, colour: 'green' },
      ]).run();
    });

    return { blue, green };
  }

  /**
   * Allocates both colour blocks for a PHP site. See the note in
   * `allocatePair`: the stored port is each block's base and the pool spans
   * `PHP_PORT_STRIDE` consecutive ports above it.
   */
  private async allocatePhpPair(siteId: string): Promise<AllocatedPair> {
    const taken = this.takenPorts();
    const excluded = await excludedPortRanges();

    const findFreeBase = async (): Promise<number | null> => {
      for (
        let base = PHP_PORT_RANGE_START;
        base + PHP_PORT_STRIDE - 1 <= PHP_PORT_RANGE_END;
        base += PHP_PORT_STRIDE
      ) {
        let blockFree = true;
        for (let offset = 0; offset < PHP_PORT_STRIDE && blockFree; offset++) {
          const port = base + offset;
          if (!validateAssignablePort(port, taken).ok) blockFree = false;
          else if (isPortExcluded(port, excluded)) blockFree = false;
          else if (!(await isPortFree(port, '127.0.0.1'))) blockFree = false;
        }
        if (blockFree) return base;
      }
      return null;
    };

    const blue = await findFreeBase();
    // Reserve the blue block provisionally so the green block cannot overlap it.
    if (blue !== null) {
      for (let offset = 0; offset < PHP_PORT_STRIDE; offset++) taken.add(blue + offset);
    }
    const green = await findFreeBase();

    if (blue === null || green === null) {
      throw new PortAllocationError(
        'There are no free ports left for a new website. Remove an unused site and try again.',
      );
    }

    this.handle.db.transaction((tx) => {
      tx.delete(portAllocations)
        .where(
          and(
            eq(portAllocations.siteId, siteId),
            inArray(portAllocations.colour, ['blue', 'green']),
          ),
        )
        .run();
      tx.insert(portAllocations).values([
        { port: blue, siteId, colour: 'blue' },
        { port: green, siteId, colour: 'green' },
      ]).run();
    });

    return { blue, green };
  }

  /**
   * Hands out the public port a site can be reached on without a domain.
   *
   * Separate from the app ports because these are deliberately exposed: the
   * app ports bind to loopback and must stay there, while this one is what
   * Caddy listens on so `http://<server-ip>:<port>` reaches the site. Being
   * able to look at a site before its DNS exists is the difference between
   * "it works" and "wait 24 hours and hope".
   */
  async allocatePreviewPort(siteId: string): Promise<number> {
    const existing = this.handle.db
      .select()
      .from(portAllocations)
      .where(and(eq(portAllocations.siteId, siteId), eq(portAllocations.colour, 'preview')))
      .get();
    if (existing) return existing.port;

    const taken = this.takenPorts();
    const excluded = await excludedPortRanges();

    for (let port = PREVIEW_PORT_RANGE_START; port <= PREVIEW_PORT_RANGE_END; port++) {
      if (!validateAssignablePort(port, taken).ok) continue;
      if (isPortExcluded(port, excluded)) continue;
      if (!(await isPortFree(port, '0.0.0.0'))) continue;

      this.handle.db
        .insert(portAllocations)
        .values({ port, siteId, colour: 'preview' })
        .run();
      return port;
    }

    throw new PortAllocationError(
      'There are no free preview ports left. Remove an unused website and try again.',
    );
  }

  /** Validates a port the user typed in themselves. */
  async assignManual(siteId: string, colour: 'blue' | 'green', port: number): Promise<void> {
    const taken = this.takenPorts();
    // A port already held by this same site is not a conflict.
    const own = this.handle.db
      .select()
      .from(portAllocations)
      .where(and(eq(portAllocations.siteId, siteId), eq(portAllocations.port, port)))
      .get();
    if (own) taken.delete(port);

    const validation = validateAssignablePort(port, taken);
    if (!validation.ok) throw new PortAllocationError(validation.reason);

    const excluded = await excludedPortRanges();
    if (isPortExcluded(port, excluded)) {
      throw new PortAllocationError(
        `Windows has reserved port ${port} for its own use, so it cannot be used here.`,
      );
    }

    this.handle.db
      .insert(portAllocations)
      .values({ port, siteId, colour })
      .onConflictDoUpdate({ target: portAllocations.port, set: { siteId, colour } })
      .run();
  }

  release(siteId: string): void {
    this.handle.db.delete(portAllocations).where(eq(portAllocations.siteId, siteId)).run();
  }

  forSite(siteId: string): AllocatedPair | null {
    const rows = this.handle.db
      .select()
      .from(portAllocations)
      .where(eq(portAllocations.siteId, siteId))
      .all();

    const blue = rows.find((row) => row.colour === 'blue');
    const green = rows.find((row) => row.colour === 'green');
    return blue && green ? { blue: blue.port, green: green.port } : null;
  }
}
