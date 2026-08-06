import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { SiteService } from '../src/sites/site-service.js';
import { PortAllocator } from '../src/sites/port-allocator.js';

/**
 * Ports are the one resource a server can genuinely run out of, and the
 * failure is slow and invisible: numbers get skipped, new sites start higher
 * and higher, and nothing complains until the range is full. These cover the
 * two things that keep that from happening — allocation filling gaps from the
 * bottom, and rows that no longer mean anything being given back.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let service: SiteService;

const gitSource = {
  kind: 'git' as const,
  url: 'https://github.com/me/app.git',
  branch: 'main',
  subdirectory: '',
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-ports-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);

  const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  service = new SiteService(handle, vault, path.join(tmpDir, 'sites'));
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createNodeSite(name: string) {
  return await service.create({
    displayName: name,
    domains: [`${name}.example`],
    source: gitSource,
    manifest: SiteManifest.parse({ runtime: 'node' }),
  });
}

describe('port allocation', () => {
  it('gives each site a pair and the next site the numbers after it', async () => {
    const first = await createNodeSite('one');
    const second = await createNodeSite('two');

    const a = service.getById(first.id);
    const b = service.getById(second.id);

    expect([a?.portBlue, a?.portGreen]).toEqual([3001, 3002]);
    expect([b?.portBlue, b?.portGreen]).toEqual([3003, 3004]);
  }, 30_000);

  it('reuses the numbers a deleted site gave back rather than climbing', async () => {
    const first = await createNodeSite('one');
    const second = await createNodeSite('two');

    await service.remove(first.id, { deleteFiles: false });

    const third = await createNodeSite('three');
    const c = service.getById(third.id);

    // 3001/3002 are free again, so the new site takes them; it does not
    // continue from where the last one left off.
    expect([c?.portBlue, c?.portGreen]).toEqual([3001, 3002]);
    expect(service.getById(second.id)?.portBlue).toBe(3003);
  }, 30_000);

  it('does not give a static site app ports it will never listen on', async () => {
    const created = await service.create({
      displayName: 'brochure',
      domains: ['brochure.example'],
      source: { kind: 'blank' as const },
      manifest: SiteManifest.parse({ runtime: 'static' }),
    });

    const site = service.getById(created.id);
    expect(site?.portBlue).toBeNull();
    expect(site?.portGreen).toBeNull();
    // It still gets a preview address, which is the only way in without DNS.
    expect(site?.previewPort).toBe(7000);

    // And the app range is untouched, so the next real app starts at the bottom.
    const next = await createNodeSite('api');
    expect(service.getById(next.id)?.portBlue).toBe(3001);
  }, 30_000);
});

describe('PortAllocator.reclaimStalePorts', () => {
  it('frees rows whose site no longer exists', async () => {
    const { id } = await createNodeSite('one');
    const allocator = new PortAllocator(handle);

    // A delete that skipped the allocator, as one before foreign keys were
    // enforced would have done.
    handle.sqlite.prepare('PRAGMA foreign_keys = OFF').run();
    handle.sqlite.prepare('DELETE FROM sites WHERE id = ?').run(id);
    handle.sqlite.prepare('PRAGMA foreign_keys = ON').run();

    expect(allocator.takenPorts().size).toBe(3);
    expect(allocator.reclaimStalePorts()).toBe(3);
    expect(allocator.takenPorts().size).toBe(0);
  }, 30_000);

  it('frees the pair a static site was given by an older version', async () => {
    const created = await service.create({
      displayName: 'brochure',
      domains: ['brochure.example'],
      source: { kind: 'blank' as const },
      manifest: SiteManifest.parse({ runtime: 'static' }),
    });

    // What the old behaviour left behind.
    handle.sqlite
      .prepare('UPDATE sites SET port_blue = 3001, port_green = 3002 WHERE id = ?')
      .run(created.id);
    handle.sqlite
      .prepare("INSERT INTO port_allocations (port, site_id, colour) VALUES (3001, ?, 'blue'), (3002, ?, 'green')")
      .run(created.id, created.id);

    const allocator = new PortAllocator(handle);
    expect(allocator.reclaimStalePorts()).toBe(2);

    // The site must not be left pointing at numbers another site can now take.
    const site = service.getById(created.id);
    expect(site?.portBlue).toBeNull();
    expect(site?.portGreen).toBeNull();
    expect(site?.previewPort).toBe(7000);
  }, 30_000);

  it('leaves a healthy site alone', async () => {
    await createNodeSite('one');
    const allocator = new PortAllocator(handle);

    expect(allocator.reclaimStalePorts()).toBe(0);
    expect(allocator.takenPorts()).toEqual(new Set([3001, 3002, 7000]));
  }, 30_000);
});
