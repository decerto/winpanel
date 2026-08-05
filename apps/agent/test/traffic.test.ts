import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites, siteTraffic } from '../src/db/schema.js';
import { bucketOf, parseAccessLine } from '../src/traffic/access-log.js';
import { TrafficCollector, readNewLines } from '../src/traffic/collector.js';
import { trafficAllTime, trafficSeries, trafficThisMonth } from '../src/traffic/queries.js';
import { buildCaddyConfig, accessLoggerNameFor } from '../src/caddy/config-builder.js';
import { SiteManifest } from '@winpanel/shared';

/**
 * Traffic counting, from a line of log to a figure on a page.
 *
 * The property that matters most is that nothing is counted twice: the panel
 * reads a file something else is still writing to, on a timer, across
 * restarts and rotations. A double count is not a visible bug — it is a
 * plausible-looking number that is wrong, which is worse.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

/*
 * A minute into the current hour.
 *
 * Fixed timestamps were tried and quietly stopped working: the collector
 * prunes history older than its retention window, so a log dated to whenever
 * the test was written eventually vanishes the moment it is recorded.
 */
const AT_MS = bucketOf(Date.now()) + 60_000;

let tmpDir: string;
let logDir: string;
let db: DatabaseHandle;
const SITE_ID = 'site-1';

/** One Caddy access-log entry, in the shape its `json` encoder writes. */
function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 'info',
    ts: AT_MS / 1000,
    logger: 'http.log.access.site_example',
    msg: 'handled request',
    request: { method: 'GET', host: 'example.com', uri: '/' },
    bytes_read: 100,
    duration: 0.05,
    size: 2000,
    status: 200,
    ...overrides,
  });
}

async function append(slug: string, lines: string[]): Promise<void> {
  await fs.appendFile(path.join(logDir, `${slug}.log`), `${lines.join('\n')}\n`, 'utf8');
}

function collector(): TrafficCollector {
  return new TrafficCollector({ db, accessLogDir: logDir });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-traffic-'));
  logDir = path.join(tmpDir, 'access');
  await fs.mkdir(logDir, { recursive: true });

  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  db.db
    .insert(sites)
    .values({
      id: SITE_ID,
      slug: 'example',
      displayName: 'Example',
      runtime: 'node',
      domains: ['example.com'],
      source: { kind: 'blank' },
      manifest: { schemaVersion: 1, runtime: 'node' },
    })
    .run();
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('reading one log line', () => {
  it('reads Caddy\u2019s float-seconds timestamp as milliseconds', () => {
    expect(parseAccessLine(entry({ ts: 1_700_000_000.5 }))?.at).toBe(1_700_000_000_500);
  });

  it('takes the response size as bytes out and the request body as bytes in', () => {
    const parsed = parseAccessLine(entry())!;
    expect(parsed.bytesOut).toBe(2000);
    expect(parsed.bytesIn).toBe(100);
    expect(parsed.durationMs).toBe(50);
  });

  it('ignores lines that are not a handled request', () => {
    // Caddy logs plenty of its own business at the same level. Counting a
    // certificate renewal as a visitor would be quietly absurd.
    expect(parseAccessLine('{"level":"info","msg":"certificate obtained"}')).toBeNull();
    expect(parseAccessLine('not json at all')).toBeNull();
    expect(parseAccessLine('')).toBeNull();
  });
});

describe('reading forward through a file', () => {
  it('stops at the last complete line', async () => {
    const filePath = path.join(logDir, 'example.log');
    await fs.writeFile(filePath, `${entry()}\n${entry()}`, 'utf8');

    const result = (await readNewLines(filePath, 0))!;

    // Two lines are present but only one has been terminated. Parsing the
    // half-written one would drop it for good once the rest arrived.
    expect([...result.buckets.values()][0]?.requests).toBe(1);
    expect(result.offset).toBeLessThan(result.size);
  });

  it('answers with nothing when the file does not exist', async () => {
    expect(await readNewLines(path.join(logDir, 'missing.log'), 0)).toBeNull();
  });
});

describe('collecting into hourly totals', () => {
  it('counts requests, bytes and status classes', async () => {
    await append('example', [entry(), entry({ status: 404, size: 30 }), entry({ status: 500 })]);

    expect(await collector().sweep()).toBe(3);

    const row = db.db.select().from(siteTraffic).all()[0]!;
    expect(row.requests).toBe(3);
    expect(row.bytesOut).toBe(2000 + 30 + 2000);
    expect(row.bytesIn).toBe(300);
    expect(row.status2xx).toBe(1);
    expect(row.status4xx).toBe(1);
    expect(row.status5xx).toBe(1);
    expect(row.bucketStart.getTime()).toBe(bucketOf(AT_MS));
  });

  it('does not count the same line twice', async () => {
    await append('example', [entry(), entry()]);
    await collector().sweep();

    // A second sweep with nothing new must add nothing. Without the cursor
    // every figure on the page would climb by itself once a minute.
    expect(await collector().sweep()).toBe(0);
    expect(db.db.select().from(siteTraffic).all()[0]!.requests).toBe(2);
  });

  it('picks up only what arrived since the last sweep', async () => {
    await append('example', [entry()]);
    await collector().sweep();

    await append('example', [entry(), entry()]);
    expect(await collector().sweep()).toBe(2);
    expect(db.db.select().from(siteTraffic).all()[0]!.requests).toBe(3);
  });

  it('starts again when the file is rolled out from under it', async () => {
    await append('example', [entry(), entry(), entry()]);
    await collector().sweep();

    // What a roll looks like from here: the name is the same, the contents
    // are not, and the file is suddenly smaller than the saved offset.
    await fs.writeFile(path.join(logDir, 'example.log'), `${entry()}\n`, 'utf8');

    expect(await collector().sweep()).toBe(1);
    expect(db.db.select().from(siteTraffic).all()[0]!.requests).toBe(4);
  });

  it('keeps separate hours apart', async () => {
    await append('example', [entry(), entry({ ts: (AT_MS - 3_600_000) / 1000 })]);
    await collector().sweep();

    expect(db.db.select().from(siteTraffic).all()).toHaveLength(2);
  });

  it('leaves a site with no log file alone', async () => {
    expect(await collector().sweep()).toBe(0);
    expect(db.db.select().from(siteTraffic).all()).toHaveLength(0);
  });
});

describe('reading the figures back', () => {
  it('returns an interval for every hour, including the quiet ones', () => {
    const { points } = trafficSeries(db, SITE_ID, '24h', Date.now());

    // A missing point and a point with no visitors mean opposite things, and
    // a chart given only the rows that exist cannot tell them apart.
    expect(points).toHaveLength(24);
    expect(points.every((point) => point.requests === 0)).toBe(true);
  });

  it('averages the response time over the requests it saw', async () => {
    await append('example', [entry({ duration: 0.1 }), entry({ duration: 0.3 })]);
    await collector().sweep();

    const { summary } = trafficSeries(db, SITE_ID, '90d');
    expect(summary.requests).toBe(2);
    expect(summary.meanResponseMs).toBe(200);
  });

  it('reports a month and an all-time total', async () => {
    await append('example', [entry()]);
    await collector().sweep();

    expect(trafficAllTime(db, SITE_ID).bytesOut).toBe(2000);
    expect(trafficAllTime(db, SITE_ID).since).not.toBeNull();
    expect(trafficThisMonth(db, SITE_ID).requests).toBe(1);
  });
});

describe('asking the web server to write the logs', () => {
  const site = {
    slug: 'example',
    domains: ['example.com', 'www.example.com'],
    activePort: 3001,
    manifest: SiteManifest.parse({ runtime: 'node' }),
    previewPort: 7001,
    enabled: true,
  };

  it('gives each website its own log file', () => {
    const config = buildCaddyConfig({ sites: [site], accessLogDir: 'C:\\logs' }) as any;
    const logger = config.logging.logs[accessLoggerNameFor('example')];

    expect(logger.writer.filename).toBe(path.join('C:\\logs', 'example.log'));
    expect(logger.encoder.format).toBe('json');
  });

  it('maps every domain of a site to that site\u2019s log', () => {
    const config = buildCaddyConfig({ sites: [site], accessLogDir: 'C:\\logs' }) as any;

    expect(config.apps.http.servers.main.logs.logger_names).toEqual({
      'example.com': 'site_example',
      'www.example.com': 'site_example',
    });
  });

  it('counts the preview address against the same website', () => {
    const config = buildCaddyConfig({ sites: [site], accessLogDir: 'C:\\logs' }) as any;
    const preview = config.apps.http.servers['preview_example'];

    expect(preview.logs.default_logger_name).toBe('site_example');
  });

  it('keeps the entries out of the default log', () => {
    // Caddy writes to every log whose filter matches, and the default one
    // matches everything: without this each request lands on disk twice.
    const config = buildCaddyConfig({ sites: [site], accessLogDir: 'C:\\logs' }) as any;

    expect(config.logging.logs.default.exclude).toEqual(['http.log.access.site_example']);
  });

  it('leaves logging off entirely when no folder is given', () => {
    const config = buildCaddyConfig({ sites: [site] }) as any;

    expect(Object.keys(config.logging.logs)).toEqual(['default']);
    expect(config.apps.http.servers.main.logs).toBeUndefined();
  });
});
