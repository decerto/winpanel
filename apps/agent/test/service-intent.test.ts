import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import {
  createServiceStopIntentStore,
  SERVICE_STOP_INTENTS_KEY,
} from '../src/windows/service-intent.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-service-intent-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('createServiceStopIntentStore', () => {
  it('round-trips service stop intent through the panel database', () => {
    const store = createServiceStopIntentStore(handle);

    expect(store.load()).toEqual([]);
    store.save(['winpanel-caddy', 'winpanel-site-example-blue']);

    expect(store.load()).toEqual(['winpanel-caddy', 'winpanel-site-example-blue']);
    expect(handle.db.select().from(settings).all()).toHaveLength(1);
  });

  it('ignores malformed stored values', () => {
    handle.sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(SERVICE_STOP_INTENTS_KEY, JSON.stringify({ id: 'not-an-array' }));

    expect(createServiceStopIntentStore(handle).load()).toEqual([]);
  });
});