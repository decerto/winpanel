import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites as sitesTable } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { SiteService } from '../src/sites/site-service.js';
import { buildSiteHealthChecks } from '../src/checks/site-checks.js';

/**
 * The per-website check answers the question every server-level check cannot:
 * is *this* site actually serving? It probes the application port and the
 * preview port separately, because the two break independently — and the
 * preview breaking while the domain stays up is the failure that produced this
 * file.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let sites: SiteService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-sitechecks-'));
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

/** The app and preview ports the check will probe, for the only site present. */
function portsOf(slug: string): { app: number | null; preview: number | null } {
  const row = handle.db.select().from(sitesTable).all().find((s) => s.slug === slug)!;
  return {
    app: row.activeColour === 'blue' ? row.portBlue : row.portGreen,
    preview: row.previewPort,
  };
}

describe('buildSiteHealthChecks', () => {
  it('builds one check per site that runs a process, and none for a static site', async () => {
    await createSite('shop', 'node');
    await createSite('brochure', 'static');

    const ids = buildSiteHealthChecks(handle).map((c) => c.id);
    expect(ids).toEqual(['site.shop-example.serving']);
  }, 30_000);

  it('is ok when both the app and the preview answer', async () => {
    await createSite('shop', 'node');

    const outcome = await buildSiteHealthChecks(handle, async () => true)[0]!.run();
    expect(outcome.state).toBe('ok');
  }, 30_000);

  it('reports the site down, not just the preview, when the app port is silent', async () => {
    await createSite('shop', 'node');

    // Nothing answers on any port: the application process is gone.
    const outcome = await buildSiteHealthChecks(handle, async () => false)[0]!.run();

    expect(outcome.state).toBe('blocked');
    expect(outcome.reason).toMatch(/down on its address and its preview/i);
    expect(outcome.fix?.kind).toBe('manual');
  }, 30_000);

  it('warns about the preview specifically when the app answers but the preview does not', async () => {
    await createSite('shop', 'node');
    const { app, preview } = portsOf('shop-example');

    const outcome = await buildSiteHealthChecks(handle, async (port) => {
      if (port === app) return true; // the application answers
      if (port === preview) return false; // the preview does not
      return false;
    })[0]!.run();

    expect(outcome.state).toBe('warning');
    expect(outcome.reason).toMatch(/preview/i);
  }, 30_000);

  it('does not flag a site that is switched off', async () => {
    await createSite('shop', 'node');
    handle.db.update(sitesTable).set({ enabled: false }).run();

    const outcome = await buildSiteHealthChecks(handle, async () => false)[0]!.run();
    expect(outcome.state).toBe('ok');
  }, 30_000);
});
