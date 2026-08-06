import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, lt, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { siteTraffic, sites, trafficCursors } from '../db/schema.js';
import { accessLogPathFor } from '../caddy/config-builder.js';
import { bucketLines, type Totals } from './access-log.js';

/**
 * Turns the web server's access logs into the traffic figures the panel shows.
 *
 * Runs on a timer inside the agent rather than as a job, because it is not
 * something a user starts and it must not queue behind a ten-minute deploy —
 * the whole point is that the numbers are close to live.
 *
 * Two properties matter and both come from the cursor table:
 *
 *  - Nothing is counted twice. Reading resumes from a saved byte offset, so a
 *    restart in the middle of a busy hour does not double that hour.
 *  - Nothing is counted late. Caddy rolls a file when it gets big, and the
 *    rolled copy keeps a distinct name, so it is picked up on the next sweep
 *    and finished rather than abandoned mid-file.
 */

/** How much of one file to take in a single pass, so a backlog cannot blow up memory. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Passes per file per sweep. Anything still behind is picked up a minute later. */
const MAX_PASSES = 8;

/** History worth keeping. Beyond this the rows are noise nobody looks at. */
const RETAIN_DAYS = 400;

export const TRAFFIC_INTERVAL_MS = 60_000;

export interface TrafficCollectorOptions {
  db: DatabaseHandle;
  accessLogDir: string;
  /** Surfaces a failure without letting it stop the timer. */
  onError?: (error: Error) => void;
}

interface FileRead {
  buckets: Map<number, Totals>;
  /** Where to resume, and the size the file had when we stopped. */
  offset: number;
  size: number;
  /** True when there is more in this file than one pass would take. */
  more: boolean;
}

/**
 * Reads whatever is new in one log file.
 *
 * Only whole lines are consumed: the offset advances to the last newline seen,
 * so a line the web server is halfway through writing is read again next time
 * rather than being parsed as truncated JSON and dropped.
 */
export async function readNewLines(
  filePath: string,
  from: number,
  maxBytes = MAX_READ_BYTES,
): Promise<FileRead | null> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    // A site that has had no requests yet has no log file, which is normal.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const stat = await handle.stat();

    /*
     * Smaller than where we left off means this is not the same file any
     * more — it was rolled, or truncated by hand. Starting again from the
     * beginning risks re-counting, but the alternative is reading garbage
     * from the middle of an unrelated line, and a rolled file is normally
     * a fresh one with almost nothing in it.
     */
    const start = stat.size < from ? 0 : from;
    const available = stat.size - start;
    if (available <= 0) {
      return { buckets: new Map(), offset: start, size: stat.size, more: false };
    }

    const take = Math.min(available, maxBytes);
    const buffer = Buffer.allocUnsafe(take);
    const { bytesRead } = await handle.read(buffer, 0, take, start);

    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lastNewline = text.lastIndexOf('\n');

    // No complete line yet. Leave the offset alone and try again next sweep.
    if (lastNewline === -1) {
      return { buckets: new Map(), offset: start, size: stat.size, more: false };
    }

    const complete = text.slice(0, lastNewline);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1;

    return {
      buckets: bucketLines(complete.split('\n')),
      offset: start + consumed,
      size: stat.size,
      more: start + consumed < stat.size,
    };
  } finally {
    await handle.close();
  }
}

/** Whether the web server has ever written a request for this site. */
export async function accessLogExists(dir: string, slug: string): Promise<boolean> {
  try {
    await fs.access(accessLogPathFor(dir, slug));
    return true;
  } catch {
    return false;
  }
}

/**
 * The live log file for a site plus any rolled copies of it still on disk.
 *
 * Caddy names a rolled file `<slug>-<timestamp>.log` and keeps a couple of
 * them. They stop growing, so their cursors settle at the end and cost one
 * `stat` per sweep after that.
 *
 * Ordered oldest first, so the hours a rolled file holds land before the live
 * file's.
 */
export async function logFilesFor(dir: string, slug: string): Promise<string[]> {
  const live = accessLogPathFor(dir, slug);
  const rolled: string[] = [];

  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(`${slug}-`) && name.endsWith('.log')) {
        rolled.push(path.join(dir, name));
      }
    }
  } catch {
    // No log folder yet: nothing has been served through the web server.
  }

  // The rolled names carry a sortable timestamp, so this is chronological.
  return [...rolled.sort(), live];
}

export class TrafficCollector {  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly options: TrafficCollectorOptions) {}

  start(intervalMs = TRAFFIC_INTERVAL_MS): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Counts everything new across every website.
   *
   * @returns how many requests were added, which is what the tests assert on.
   */
  async sweep(): Promise<number> {
    // Overlapping sweeps would read the same bytes twice, since the cursor is
    // only written at the end of a file's pass.
    if (this.#running) return 0;
    this.#running = true;

    try {
      const rows = this.options.db.db
        .select({ id: sites.id, slug: sites.slug })
        .from(sites)
        .all();

      let counted = 0;
      for (const site of rows) {
        try {
          counted += await this.#collectSite(site.id, site.slug);
        } catch (error) {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }

      this.#prune();
      return counted;
    } finally {
      this.#running = false;
    }
  }

  /**
   * The live file plus any rolled copies of it still on disk.
   */
  async #logFilesFor(slug: string): Promise<string[]> {
    return logFilesFor(this.options.accessLogDir, slug);
  }

  async #collectSite(siteId: string, slug: string): Promise<number> {
    let counted = 0;

    for (const filePath of await this.#logFilesFor(slug)) {
      const cursor = this.options.db.db
        .select()
        .from(trafficCursors)
        .where(eq(trafficCursors.path, filePath))
        .get();

      let offset = cursor?.offset ?? 0;

      // A backlog is read in bounded passes rather than one huge buffer. The
      // cap stops a sweep that is behind by a gigabyte from holding the whole
      // thing in memory at once.
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const result = await readNewLines(filePath, offset);
        if (!result) break;

        for (const [bucketStart, totals] of result.buckets) {
          this.#record(siteId, bucketStart, totals);
          counted += totals.requests;
        }

        offset = result.offset;

        this.options.db.db
          .insert(trafficCursors)
          .values({ path: filePath, offset, size: result.size, readAt: new Date() })
          .onConflictDoUpdate({
            target: trafficCursors.path,
            set: { offset, size: result.size, readAt: new Date() },
          })
          .run();

        if (!result.more) break;
      }
    }

    return counted;
  }

  /** Adds one hour's totals to whatever is already recorded for that hour. */
  #record(siteId: string, bucketStart: number, totals: Totals): void {
    this.options.db.db
      .insert(siteTraffic)
      .values({ siteId, bucketStart: new Date(bucketStart), ...totals })
      .onConflictDoUpdate({
        target: [siteTraffic.siteId, siteTraffic.bucketStart],
        set: {
          requests: sql`${siteTraffic.requests} + ${totals.requests}`,
          bytesIn: sql`${siteTraffic.bytesIn} + ${totals.bytesIn}`,
          bytesOut: sql`${siteTraffic.bytesOut} + ${totals.bytesOut}`,
          status2xx: sql`${siteTraffic.status2xx} + ${totals.status2xx}`,
          status3xx: sql`${siteTraffic.status3xx} + ${totals.status3xx}`,
          status4xx: sql`${siteTraffic.status4xx} + ${totals.status4xx}`,
          status5xx: sql`${siteTraffic.status5xx} + ${totals.status5xx}`,
          durationMs: sql`${siteTraffic.durationMs} + ${totals.durationMs}`,
        },
      })
      .run();
  }

  /** Drops history nobody can ask for, and cursors for files that are gone. */
  #prune(): void {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 3_600_000);
    this.options.db.db.delete(siteTraffic).where(lt(siteTraffic.bucketStart, cutoff)).run();

    const stale = new Date(Date.now() - 7 * 24 * 3_600_000);
    this.options.db.db.delete(trafficCursors).where(lt(trafficCursors.readAt, stale)).run();
  }
}
