import { and, eq, inArray } from 'drizzle-orm';
import {
  APP_PORT_RANGE_END,
  APP_PORT_RANGE_START,
  DOTNET_PORT_RANGE_END,
  DOTNET_PORT_RANGE_START,
  PREVIEW_PORT_RANGE_END,
  PREVIEW_PORT_RANGE_START,
  validateAssignablePort,
} from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { portAllocations } from '../db/schema.js';
import { excludedPortRanges, isPortExcluded, isPortFree } from '../checks/server-checks.js';

/**
 * Hands out the loopback ports that hosted apps listen on.
 *
 * Each site gets a *pair*. Only one is live at a time; a release starts on the
 * idle one, gets health-checked there, and traffic is switched over. That is
 * what makes a deploy zero-downtime, and it is also why the panel never
 * load-balances across both — round-robin would break sticky sessions for
 * anything using WebSockets.
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

export class PortAllocator {
  constructor(private readonly handle: DatabaseHandle) {}

  /** Ports already handed out to any site. */
  takenPorts(): Set<number> {
    const rows = this.handle.db.select({ port: portAllocations.port }).from(portAllocations).all();
    return new Set(rows.map((row) => row.port));
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
    runtime: 'node' | 'dotnet' | 'static' | 'proxy' = 'node',
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
