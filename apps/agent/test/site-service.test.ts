import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { SiteService, slugify } from '../src/sites/site-service.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let vault: SecretVault;
let service: SiteService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-sites-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  service = new SiteService(handle, vault, path.join(tmpDir, 'sites'));
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('turns a domain into a safe folder name', () => {
    expect(slugify('kitora.io')).toBe('kitora-io');
    expect(slugify('diminished-studios.com')).toBe('diminished-studios-com');
    expect(slugify('https://www.example.com')).toBe('example-com');
  });

  it('strips characters that are unsafe in a folder or service name', () => {
    expect(slugify('My Site! (v2)')).toBe('my-site-v2');
    expect(slugify('a/b\\c')).toBe('a-b-c');
  });

  it('never produces an empty or trailing-hyphen name', () => {
    // The slug becomes a Windows service id, so neither is acceptable.
    expect(slugify('!!!').length).toBeGreaterThanOrEqual(2);
    expect(slugify('trailing---')).not.toMatch(/-$/);
    expect(slugify('')).toMatch(/^site-/);
  });

  it('caps the length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe('SiteService.create', () => {
  const baseInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'git' as const, url: 'https://github.com/me/kitora.git', branch: 'main', subdirectory: '' },
    manifest: SiteManifest.parse({ runtime: 'node' }),
  };

  it('creates a site with ports and folders', async () => {
    const { id, slug } = await service.create(baseInput);

    expect(slug).toBe('kitora-io');

    const site = service.getById(id);
    expect(site?.portBlue).toBeGreaterThanOrEqual(3001);
    expect(site?.portGreen).not.toBe(site?.portBlue);

    for (const folder of ['release', 'shared', 'logs']) {
      await expect(
        fs.access(path.join(tmpDir, 'sites', slug, folder)),
      ).resolves.toBeUndefined();
    }
  }, 30_000);

  it('gives a second site with the same domain a distinct slug', async () => {
    const first = await service.create(baseInput);
    const second = await service.create(baseInput);

    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toBe('kitora-io-2');
  }, 30_000);

  it('starts on blue', async () => {
    const { id } = await service.create(baseInput);
    const site = service.getById(id);

    expect(site?.activeColour).toBe('blue');
    expect(service.activePort(id)).toBe(site?.portBlue);
  }, 30_000);

  it('stores environment values encrypted, with only the names in the clear', async () => {
    const { id } = await service.create({
      ...baseInput,
      envVars: { DATABASE_URL: 'mongodb+srv://user:pass@cluster/db', PORT: '3000' },
    });

    // The stored row must not contain the secret.
    const row = handle.sqlite
      .prepare('SELECT ciphertext FROM secrets WHERE key = ?')
      .get(`site.env:${id}`) as { ciphertext: string };

    expect(row.ciphertext).not.toContain('mongodb+srv');
    expect(row.ciphertext).not.toContain('pass');

    // But the panel can still read them back.
    expect(await service.getEnv(id)).toEqual({
      DATABASE_URL: 'mongodb+srv://user:pass@cluster/db',
      PORT: '3000',
    });

    // And the names are available for the UI without decrypting.
    const manifest = service.getById(id)?.manifest as { envVars: string[] };
    expect(manifest.envVars).toEqual(['DATABASE_URL', 'PORT']);
  }, 30_000);

  it('stores a repository token encrypted', async () => {
    const { id } = await service.create({ ...baseInput, gitToken: 'ghp_secrettokenvalue' });

    const row = handle.sqlite
      .prepare('SELECT ciphertext FROM secrets WHERE key = ?')
      .get(`site.gitToken:${id}`) as { ciphertext: string };

    expect(row.ciphertext).not.toContain('ghp_secrettokenvalue');
    expect(await service.getGitToken(id)).toBe('ghp_secrettokenvalue');
  }, 30_000);

  it('returns nothing rather than throwing when a secret is absent', async () => {
    const { id } = await service.create(baseInput);
    expect(await service.getGitToken(id)).toBeUndefined();
    expect(await service.getEnv(id)).toEqual({});
  }, 30_000);
});

describe('SiteService.remove', () => {
  const baseInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: SiteManifest.parse({}),
  };

  it('frees the ports so another site can use them', async () => {
    const { id } = await service.create(baseInput);
    const before = service.getById(id);

    await service.remove(id, { deleteFiles: false });

    const next = await service.create(baseInput);
    const after = service.getById(next.id);
    expect(after?.portBlue).toBe(before?.portBlue);
  }, 30_000);

  it('removes the stored secrets', async () => {
    const { id } = await service.create({ ...baseInput, gitToken: 'ghp_token' });
    await service.remove(id, { deleteFiles: false });

    const remaining = handle.sqlite
      .prepare('SELECT count(*) as n FROM secrets WHERE key LIKE ?')
      .get(`%${id}`) as { n: number };

    expect(remaining.n).toBe(0);
  }, 30_000);

  it('keeps the files unless asked to delete them', async () => {
    const { id, slug } = await service.create(baseInput);
    await service.remove(id, { deleteFiles: false });

    await expect(fs.access(path.join(tmpDir, 'sites', slug))).resolves.toBeUndefined();
  }, 30_000);

  it('deletes the files when asked', async () => {
    const { id, slug } = await service.create(baseInput);
    await service.remove(id, { deleteFiles: true });

    await expect(fs.access(path.join(tmpDir, 'sites', slug))).rejects.toThrow();
  }, 30_000);

  it('is safe to call for a site that no longer exists', async () => {
    await expect(
      service.remove('00000000-0000-0000-0000-000000000000', { deleteFiles: true }),
    ).resolves.toBeUndefined();
  });
});

describe('SiteService.ensurePreviewPorts', () => {
  const baseInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: SiteManifest.parse({}),
  };

  it('gives a preview address to a site created before they existed', async () => {
    const { id } = await service.create(baseInput);

    // What every site looks like on a server installed before migration 0003:
    // reachable only through a domain that may not exist yet.
    handle.sqlite.prepare('UPDATE sites SET preview_port = NULL WHERE id = ?').run(id);
    handle.sqlite.prepare('DELETE FROM port_allocations WHERE colour = ?').run('preview');

    expect(await service.ensurePreviewPorts()).toBe(1);

    const port = service.getById(id)?.previewPort;
    expect(port).toBeGreaterThanOrEqual(7000);
    expect(port).toBeLessThanOrEqual(7999);
  }, 30_000);

  it('leaves sites that already have one alone', async () => {
    await service.create(baseInput);
    expect(await service.ensurePreviewPorts()).toBe(0);
  }, 30_000);
});
