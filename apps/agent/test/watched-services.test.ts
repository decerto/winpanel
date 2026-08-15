import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { jobs } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { SiteService } from '../src/sites/site-service.js';
import { partitionHolders } from '../src/windows/stray-processes.js';
import {
  annotateResponding,
  siteWatchedServices,
  watchdogServices,
  watchedServiceFor,
} from '../src/windows/watched-services.js';
import type { PanelService } from '../src/windows/panel-services.js';

/**
 * A website's own orphaned process is invisible from outside: it answers the
 * web server perfectly, so the site looks healthy while the panel reports it
 * stopped and every restart fails to bind. Recovering from that means knowing
 * exactly which ports and which executables belong to which service — and
 * being sure the panel never uses that knowledge to end somebody else's
 * program.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let sites: SiteService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-watched-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);

  const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  sites = new SiteService(handle, vault, path.join(tmpDir, 'sites'));
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createSite(name: string, runtime: 'node' | 'static' | 'dotnet') {
  return await sites.create({
    displayName: name,
    domains: [`${name}.example`],
    source: { kind: 'git', url: 'https://github.com/me/app.git', branch: 'main', subdirectory: '' },
    manifest: SiteManifest.parse({ runtime }),
  });
}

describe('siteWatchedServices', () => {
  it('watches both colours of a website, each on its own port', async () => {
    const site = await createSite('shop', 'node');

    expect(siteWatchedServices(handle)).toEqual([
      {
        id: 'winpanel-site-shop-example-blue',
        label: 'shop-example website',
        images: ['node.exe'],
        ports: [3001],
        siteId: site.id,
      },
      {
        id: 'winpanel-site-shop-example-green',
        label: 'shop-example website',
        images: ['node.exe'],
        ports: [3002],
        siteId: site.id,
      },
    ]);
  }, 30_000);

  it('ignores a static site, which has no process to recover', async () => {
    await createSite('brochure', 'static');

    expect(siteWatchedServices(handle)).toEqual([]);
  }, 30_000);

  it('expects a .NET site to be running as dotnet.exe', async () => {
    await createSite('api', 'dotnet');

    expect(siteWatchedServices(handle)[0]?.images).toEqual(['dotnet.exe']);
  }, 30_000);

  it('finds the components as well as the websites, by service id', async () => {
    await createSite('shop', 'node');

    expect(watchedServiceFor(handle, 'winpanel-caddy')?.ports).toContain(443);
    expect(watchedServiceFor(handle, 'winpanel-site-shop-example-green')?.ports).toEqual([3002]);
    expect(watchedServiceFor(handle, 'winpanel-site-nothing-blue')).toBeUndefined();
  }, 30_000);
});

describe('watchdogServices', () => {
  it('leaves a website alone while it is being deployed', async () => {
    const site = await createSite('shop', 'node');

    handle.db
      .insert(jobs)
      .values({
        id: 'job-1',
        kind: 'deploy',
        status: 'running',
        title: 'Deploying',
        siteId: site.id,
      })
      .run();

    expect(watchdogServices(handle).some((service) => service.siteId === site.id)).toBe(false);
    // The components are still watched: a deploy has nothing to do with them.
    expect(watchdogServices(handle).map((service) => service.id)).toContain('winpanel-caddy');

    // But the ports it owns are still known, because the deploy itself asks.
    expect(watchedServiceFor(handle, 'winpanel-site-shop-example-blue')?.ports).toEqual([3001]);
  }, 30_000);

  it('watches it again once the deploy has finished', async () => {
    const site = await createSite('shop', 'node');

    handle.db
      .insert(jobs)
      .values({
        id: 'job-1',
        kind: 'deploy',
        status: 'succeeded',
        title: 'Deploying',
        siteId: site.id,
      })
      .run();

    expect(watchdogServices(handle).some((service) => service.siteId === site.id)).toBe(true);
  }, 30_000);

  /*
   * The watchdog runs inside the panel. If the panel were in its list, the
   * process it would find on the panel's port while the service reads as
   * stopped — during development, or with the panel started by hand — is
   * itself, and it would end it. Stopping the panel deliberately still has to
   * be able to clear a leftover, so it is unblockable but never watched.
   */
  it('never watches the panel itself, but can still be asked to free its port', async () => {
    expect(watchdogServices(handle).map((service) => service.id)).not.toContain('winpanel-agent');
    expect(watchedServiceFor(handle, 'winpanel-agent')?.images).toEqual(['node.exe']);
  }, 30_000);
});

describe('partitionHolders', () => {
  const holders = [
    { pid: 100, port: 3001, image: 'node.exe' },
    { pid: 200, port: 3001, image: 'sqlservr.exe' },
    { pid: 300, port: 3001, image: 'C:\\Program Files\\nodejs\\NODE.EXE' },
  ];

  it('claims only what runs the same program, whatever its path or case', () => {
    const { ours, foreign } = partitionHolders(holders, ['node.exe']);

    expect(ours.map((holder) => holder.pid)).toEqual([100, 300]);
    expect(foreign.map((holder) => holder.pid)).toEqual([200]);
  });

  it('claims nothing when no executable is named, so an empty list is never a licence to kill', () => {
    const { ours, foreign } = partitionHolders(holders, []);

    expect(ours).toEqual([]);
    expect(foreign).toHaveLength(3);
  });
});

describe('annotateResponding', () => {
  function listed(id: string, state: PanelService['state']): PanelService {
    return { id, label: id, kind: 'site', state };
  }

  it('flags a running website that answers on none of its ports', async () => {
    await createSite('shop', 'node');

    const result = await annotateResponding(
      handle,
      [listed('winpanel-site-shop-example-blue', 'running')],
      async () => false,
    );

    expect(result[0]?.responding).toBe(false);
  }, 30_000);

  it('leaves a running website that answers as responding', async () => {
    await createSite('shop', 'node');

    const result = await annotateResponding(
      handle,
      [listed('winpanel-site-shop-example-blue', 'running')],
      async () => true,
    );

    expect(result[0]?.responding).toBe(true);
  }, 30_000);

  it('does not probe a stopped service, so a deliberate stop is never flagged', async () => {
    await createSite('shop', 'node');
    let probed = false;

    const result = await annotateResponding(
      handle,
      [listed('winpanel-site-shop-example-blue', 'stopped')],
      async () => {
        probed = true;
        return false;
      },
    );

    expect(probed).toBe(false);
    expect(result[0]?.responding).toBeUndefined();
  }, 30_000);

  it('leaves a running service it has no ports for untouched', async () => {
    // The panel itself has a port in the config but none recorded per-site; a
    // static site has no process at all. Neither is probed.
    const result = await annotateResponding(
      handle,
      [listed('winpanel-site-ghost-blue', 'running')],
      async () => false,
    );

    expect(result[0]?.responding).toBeUndefined();
  }, 30_000);
});
