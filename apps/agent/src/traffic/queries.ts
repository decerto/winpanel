import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { siteTraffic } from '../db/schema.js';
import { HOUR_MS, emptyTotals, type Totals } from './access-log.js';

/**
 * Reading the traffic figures back out.
 *
 * Kept apart from the collector because they answer to different pressures:
 * the collector runs unattended once a minute, this runs while somebody is
 * looking at a page and waiting.
 */

export const TRAFFIC_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

const RANGE_HOURS: Record<TrafficRange, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
};

/**
 * A day's resolution for anything longer than a couple of days.
 *
 * Ninety days of hourly points is two thousand of them on a chart six hundred
 * pixels wide, which is not a chart, it is a texture.
 */
function stepFor(range: TrafficRange): number {
  return range === '24h' || range === '7d' ? HOUR_MS : 24 * HOUR_MS;
}

export interface TrafficPoint extends Totals {
  /** Start of the interval this point covers. */
  at: Date;
}

export interface TrafficSummary extends Totals {
  /** Mean time spent handling a request, in milliseconds. */
  meanResponseMs: number;
}

function summarise(totals: Totals): TrafficSummary {
  return {
    ...totals,
    meanResponseMs: totals.requests === 0 ? 0 : Math.round(totals.durationMs / totals.requests),
  };
}

function rowsBetween(
  db: DatabaseHandle,
  siteId: string,
  from: Date,
  to: Date,
): Array<{ bucketStart: Date } & Totals> {
  return db.db
    .select()
    .from(siteTraffic)
    .where(
      and(
        eq(siteTraffic.siteId, siteId),
        gte(siteTraffic.bucketStart, from),
        lt(siteTraffic.bucketStart, to),
      ),
    )
    .orderBy(asc(siteTraffic.bucketStart))
    .all();
}

function fold(rows: ReadonlyArray<Totals>): Totals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.requests += row.requests;
    totals.bytesIn += row.bytesIn;
    totals.bytesOut += row.bytesOut;
    totals.status2xx += row.status2xx;
    totals.status3xx += row.status3xx;
    totals.status4xx += row.status4xx;
    totals.status5xx += row.status5xx;
    totals.durationMs += row.durationMs;
  }
  return totals;
}

/**
 * The series for a range, with empty intervals present rather than missing.
 *
 * A gap in the data and an hour with no visitors look identical to a chart
 * that is only given the rows that exist, and they mean opposite things.
 */
export function trafficSeries(
  db: DatabaseHandle,
  siteId: string,
  range: TrafficRange,
  now = Date.now(),
): { points: TrafficPoint[]; summary: TrafficSummary } {
  const step = stepFor(range);
  const end = Math.floor(now / step) * step + step;
  const start = end - RANGE_HOURS[range] * HOUR_MS;

  const buckets = new Map<number, Totals>();
  for (let at = start; at < end; at += step) buckets.set(at, emptyTotals());

  for (const row of rowsBetween(db, siteId, new Date(start), new Date(end))) {
    const key = Math.floor(row.bucketStart.getTime() / step) * step;
    const totals = buckets.get(key);
    if (!totals) continue;

    totals.requests += row.requests;
    totals.bytesIn += row.bytesIn;
    totals.bytesOut += row.bytesOut;
    totals.status2xx += row.status2xx;
    totals.status3xx += row.status3xx;
    totals.status4xx += row.status4xx;
    totals.status5xx += row.status5xx;
    totals.durationMs += row.durationMs;
  }

  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, totals]) => ({ at: new Date(at), ...totals }));

  return { points, summary: summarise(fold(points)) };
}

/** Totals since midnight on the first of the current month, in local time. */
export function trafficThisMonth(
  db: DatabaseHandle,
  siteId: string,
  now = new Date(),
): TrafficSummary & { since: Date } {
  const since = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = rowsBetween(db, siteId, since, new Date(now.getTime() + HOUR_MS));
  return { ...summarise(fold(rows)), since };
}

/** Everything ever recorded, and when the first of it was. */
export function trafficAllTime(
  db: DatabaseHandle,
  siteId: string,
): TrafficSummary & { since: Date | null } {
  const row = db.db
    .select({
      requests: sql<number>`coalesce(sum(${siteTraffic.requests}), 0)`,
      bytesIn: sql<number>`coalesce(sum(${siteTraffic.bytesIn}), 0)`,
      bytesOut: sql<number>`coalesce(sum(${siteTraffic.bytesOut}), 0)`,
      status2xx: sql<number>`coalesce(sum(${siteTraffic.status2xx}), 0)`,
      status3xx: sql<number>`coalesce(sum(${siteTraffic.status3xx}), 0)`,
      status4xx: sql<number>`coalesce(sum(${siteTraffic.status4xx}), 0)`,
      status5xx: sql<number>`coalesce(sum(${siteTraffic.status5xx}), 0)`,
      durationMs: sql<number>`coalesce(sum(${siteTraffic.durationMs}), 0)`,
      since: sql<number | null>`min(${siteTraffic.bucketStart})`,
    })
    .from(siteTraffic)
    .where(eq(siteTraffic.siteId, siteId))
    .get();

  if (!row) return { ...summarise(emptyTotals()), since: null };

  const { since, ...totals } = row;
  return { ...summarise(totals), since: since === null ? null : new Date(since) };
}
