import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites, users, siteOutageStates } from '../src/db/schema.js';
import {
  SiteOutageMonitor,
  type OutageMailMessage,
} from '../src/mail/site-outage-monitor.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let messages: OutageMailMessage[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-outages-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  messages = [];
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function addUser(input: {
  username: string;
  role: 'superadmin' | 'admin' | 'user';
  email: string;
  verified?: boolean;
  outageNotifications?: boolean;
}): string {
  const id = crypto.randomUUID();
  handle.db
    .insert(users)
    .values({
      id,
      username: input.username,
      passwordHash: 'not-used',
      role: input.role,
      email: input.email,
      emailVerifiedAt: input.verified === false ? null : new Date(),
      outageNotifications: input.outageNotifications ?? false,
    })
    .run();
  return id;
}

function addSite(
  ownerUserId: string | null,
  runtime: 'node' | 'static' = 'node',
  enabled = true,
): string {
  const slug = `${runtime}-site-${crypto.randomUUID().slice(0, 8)}`;
  const id = crypto.randomUUID();
  handle.db
    .insert(sites)
    .values({
      id,
      slug,
      displayName: runtime === 'node' ? 'App site' : 'Static site',
      ownerUserId,
      runtime,
      enabled,
      domains: ['example.com'],
      source: { kind: 'upload' },
      manifest: {},
      ...(runtime === 'node' ? { portBlue: 3100 } : { previewPort: 7100 }),
    })
    .run();
  return id;
}

describe('SiteOutageMonitor', () => {
  it('requires two failures, notifies once, and sends one recovery message', async () => {
    addUser({
      username: 'owner',
      role: 'superadmin',
      email: 'owner@example.com',
    });
    addUser({ username: 'admin', role: 'admin', email: 'admin@example.com' });
    const customerId = addUser({
      username: 'customer',
      role: 'user',
      email: 'customer@example.com',
      outageNotifications: true,
    });
    addUser({
      username: 'unverified',
      role: 'admin',
      email: 'unverified@example.com',
      verified: false,
    });
    addUser({
      username: 'quiet-customer',
      role: 'user',
      email: 'quiet@example.com',
      outageNotifications: false,
    });
    addSite(customerId);

    let online = false;
    const monitor = new SiteOutageMonitor({
      db: handle,
      mailer: {
        send: async (message) => {
          messages.push(message);
        },
      },
      probe: async () => online,
    });

    expect((await monitor.sweep()).notifications).toBe(0);
    expect(messages).toHaveLength(0);
    expect((await monitor.sweep()).notifications).toBe(3);
    expect(messages.map((message) => message.to.email)).toEqual([
      'owner@example.com',
      'admin@example.com',
      'customer@example.com',
    ]);
    expect(messages.every((message) => /may be offline/.test(message.subject))).toBe(true);

    await monitor.sweep();
    expect(messages).toHaveLength(3);

    online = true;
    expect((await monitor.sweep()).notifications).toBe(3);
    expect(messages).toHaveLength(6);
    expect(messages.slice(3).every((message) => /reachable again/.test(message.subject))).toBe(true);

    const state = handle.db.select().from(siteOutageStates).get();
    expect(state?.state).toBe('up');
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.notifiedState).toBe('up');
  });

  it('uses a static site preview and ignores disabled or undeployed sites', async () => {
    addUser({ username: 'owner', role: 'superadmin', email: 'owner@example.com' });
    addSite(null, 'static');
    addSite(null, 'static', false);
    handle.db
      .insert(sites)
      .values({
        id: crypto.randomUUID(),
        slug: 'not-deployed',
        displayName: 'Not deployed',
        runtime: 'node',
        domains: [],
        source: { kind: 'upload' },
        manifest: {},
      })
      .run();

    const probed: number[] = [];
    const monitor = new SiteOutageMonitor({
      db: handle,
      mailer: {
        send: async (message) => {
          messages.push(message);
        },
      },
      probe: async (port) => {
        probed.push(port);
        return true;
      },
    });

    const result = await monitor.sweep();

    expect(result.checked).toBe(1);
    expect(result.ignored).toBe(2);
    expect(probed).toEqual([7100]);
    expect(messages).toHaveLength(0);
  });

  it('does not send a recovery message during the first sweep after boot', async () => {
    addUser({ username: 'owner', role: 'superadmin', email: 'owner@example.com' });
    const siteId = addSite(null);
    const now = new Date('2026-09-01T12:00:00Z');
    handle.db
      .insert(siteOutageStates)
      .values({
        siteId,
        state: 'down',
        consecutiveFailures: 2,
        checkedAt: now,
        notifiedState: 'down',
        updatedAt: now,
      })
      .run();

    const monitor = new SiteOutageMonitor({
      db: handle,
      mailer: { send: async (message) => { messages.push(message); } },
      probe: async () => true,
    });

    expect((await monitor.sweep()).notifications).toBe(0);
    expect(messages).toHaveLength(0);
    expect(handle.db.select().from(siteOutageStates).get()?.notifiedState).toBe('up');
  });

  it('ignores a manually stopped process and does not send recovery mail when it starts', async () => {
    addUser({ username: 'owner', role: 'superadmin', email: 'owner@example.com' });
    const siteId = addSite(null);
    const site = handle.db.select().from(sites).where(eq(sites.id, siteId)).get()!;
    let intentionallyStopped = false;
    let online = true;
    const monitor = new SiteOutageMonitor({
      db: handle,
      mailer: { send: async (message) => { messages.push(message); } },
      probe: async () => online,
      isIntentionallyStopped: () => intentionallyStopped,
    });

    await monitor.sweep();
    intentionallyStopped = true;
    online = false;
    expect((await monitor.sweep()).ignored).toBe(1);

    intentionallyStopped = false;
    online = true;
    expect((await monitor.sweep()).notifications).toBe(0);
    expect(messages).toHaveLength(0);
    expect(handle.db.select().from(siteOutageStates).where(eq(siteOutageStates.siteId, site.id)).get()?.notifiedState).toBeNull();
  });
});