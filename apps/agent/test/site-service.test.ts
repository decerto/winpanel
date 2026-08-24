import crypto from 'node:crypto';
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

  it('stores a repository token encrypted, against the person who added it', async () => {
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const { id } = await service.create({
      ...baseInput,
      gitToken: { userId: alice, token: 'ghp_secrettokenvalue' },
    });

    const row = handle.sqlite
      .prepare('SELECT ciphertext FROM secrets WHERE key = ?')
      .get(`site.gitToken:${id}:${alice}`) as { ciphertext: string };

    expect(row.ciphertext).not.toContain('ghp_secrettokenvalue');
    expect(await service.getGitToken(id, alice)).toBe('ghp_secrettokenvalue');

    // The whole point: handing the site to Bob must not hand him Alice's
    // credential, so his view of the same site has no token at all.
    expect(await service.getGitToken(id, bob)).toBeUndefined();
  }, 30_000);

  it('lists who has stored access without decrypting anything', async () => {
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const { id } = await service.create(baseInput);

    await service.setGitToken(id, alice, 'ghp_alice');
    await service.setGitToken(id, bob, 'ghp_bob');

    expect(service.gitTokenHolders(id).map((holder) => holder.userId).sort()).toEqual(
      [alice, bob].sort(),
    );

    service.clearGitToken(id, bob);
    expect(service.gitTokenHolders(id).map((holder) => holder.userId)).toEqual([alice]);
    expect(await service.getGitToken(id, alice)).toBe('ghp_alice');
  }, 30_000);

  it('forgets a token given an empty value rather than storing one', async () => {
    const alice = crypto.randomUUID();
    const { id } = await service.create(baseInput);

    await service.setGitToken(id, alice, 'ghp_alice');
    await service.setGitToken(id, alice, '   ');

    expect(service.gitTokenHolders(id)).toEqual([]);
    expect(await service.getGitToken(id, alice)).toBeUndefined();
  }, 30_000);

  it('returns nothing rather than throwing when a secret is absent', async () => {
    const { id } = await service.create(baseInput);
    expect(await service.getGitToken(id, crypto.randomUUID())).toBeUndefined();
    expect(await service.getEnv(id)).toEqual({});
  }, 30_000);
});

describe('SiteService.adoptLegacyGitTokens', () => {
  const baseInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'git' as const, url: 'https://example.com/x.git', branch: 'main', subdirectory: '' },
    manifest: SiteManifest.parse({}),
  };

  /** A token from before tokens had an owner: keyed by site alone. */
  function writeLegacyToken(siteId: string, token: string): void {
    const key = `site.gitToken:${siteId}`;
    handle.sqlite
      .prepare('INSERT INTO secrets (key, ciphertext) VALUES (?, ?)')
      .run(key, vault.encrypt(token, key));
  }

  it("gives the site's own token to the site's owner", async () => {
    const owner = crypto.randomUUID();
    handle.sqlite
      .prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(owner, 'customer', 'x', 'user');

    const { id } = await service.create({ ...baseInput, ownerUserId: owner });
    writeLegacyToken(id, 'ghp_legacy');

    expect(await service.adoptLegacyGitTokens(null)).toBe(1);

    // Re-encrypted under the new key, which is bound to it as AAD, and the
    // shared copy anyone could have used is gone.
    expect(await service.getGitToken(id, owner)).toBe('ghp_legacy');
    expect(service.gitTokenHolders(id).map((holder) => holder.userId)).toEqual([owner]);
    expect(
      handle.sqlite.prepare('SELECT count(*) as n FROM secrets WHERE key = ?').get(
        `site.gitToken:${id}`,
      ),
    ).toEqual({ n: 0 });
  }, 30_000);

  it('gives a server-owned site\u2019s token to the first owner account', async () => {
    const superadmin = crypto.randomUUID();
    handle.sqlite
      .prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(superadmin, 'jordan', 'x', 'superadmin');

    const { id } = await service.create(baseInput);
    writeLegacyToken(id, 'ghp_legacy');

    expect(await service.adoptLegacyGitTokens(superadmin)).toBe(1);
    expect(await service.getGitToken(id, superadmin)).toBe('ghp_legacy');
  }, 30_000);

  it('deletes a token it cannot give to anybody', async () => {
    const { id } = await service.create(baseInput);
    writeLegacyToken(id, 'ghp_legacy');

    expect(await service.adoptLegacyGitTokens(null)).toBe(0);
    expect(service.gitTokenHolders(id)).toEqual([]);
    expect(
      handle.sqlite.prepare('SELECT count(*) as n FROM secrets WHERE key LIKE ?').get(
        `site.gitToken:${id}%`,
      ),
    ).toEqual({ n: 0 });
  }, 30_000);

  it('leaves tokens that already have an owner alone, and is safe to repeat', async () => {
    const alice = crypto.randomUUID();
    const { id } = await service.create(baseInput);
    await service.setGitToken(id, alice, 'ghp_alice');

    expect(await service.adoptLegacyGitTokens(crypto.randomUUID())).toBe(0);
    expect(await service.adoptLegacyGitTokens(crypto.randomUUID())).toBe(0);
    expect(await service.getGitToken(id, alice)).toBe('ghp_alice');
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
    const { id } = await service.create({
      ...baseInput,
      gitToken: { userId: crypto.randomUUID(), token: 'ghp_token' },
    });
    await service.remove(id, { deleteFiles: false });

    const remaining = handle.sqlite
      .prepare('SELECT count(*) as n FROM secrets WHERE key LIKE ?')
      .get(`%${id}%`) as { n: number };

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

describe('SiteService.cleanUpLegacyLayouts', () => {
  const baseInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'git' as const, url: 'https://github.com/me/kitora.git', branch: 'main', subdirectory: '' },
    manifest: SiteManifest.parse({ runtime: 'node' }),
  };

  it('removes the dated release folders left by the old layout', async () => {
    const { slug } = await service.create(baseInput);
    const siteDir = path.join(tmpDir, 'sites', slug);

    await fs.mkdir(path.join(siteDir, 'releases', '20260804-195841'), { recursive: true });
    await fs.mkdir(path.join(siteDir, 'releases', '20260804-203657'), { recursive: true });
    await fs.mkdir(path.join(siteDir, 'current'), { recursive: true });

    expect(await service.cleanUpLegacyLayouts()).toBe(1);

    await expect(fs.access(path.join(siteDir, 'releases'))).rejects.toThrow();
    await expect(fs.access(path.join(siteDir, 'current'))).rejects.toThrow();
    // The folder that is actually being served is untouched.
    await expect(fs.access(path.join(siteDir, 'release'))).resolves.toBeUndefined();
  }, 30_000);

  it('does nothing for a site that is already on the current layout', async () => {
    await service.create(baseInput);
    expect(await service.cleanUpLegacyLayouts()).toBe(0);
  }, 30_000);

  it('removes the unused public folder from a git site, but only while it is empty', async () => {
    const { slug } = await service.create(baseInput);
    const publicDir = path.join(tmpDir, 'sites', slug, 'public');

    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'notes.txt'), 'mine');

    expect(await service.cleanUpLegacyLayouts()).toBe(0);
    await expect(fs.access(path.join(publicDir, 'notes.txt'))).resolves.toBeUndefined();

    await fs.rm(path.join(publicDir, 'notes.txt'));
    expect(await service.cleanUpLegacyLayouts()).toBe(1);
    await expect(fs.access(publicDir)).rejects.toThrow();
  }, 30_000);

  it('leaves the public folder of a site the user manages alone', async () => {
    const { slug } = await service.create({
      ...baseInput,
      domains: ['example.com'],
      source: { kind: 'upload' as const },
    });

    expect(await service.cleanUpLegacyLayouts()).toBe(0);
    await expect(
      fs.access(path.join(tmpDir, 'sites', slug, 'public')),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('leaves the old folders alone when the live folder is missing', async () => {
    const { slug } = await service.create(baseInput);
    const siteDir = path.join(tmpDir, 'sites', slug);

    await fs.rm(path.join(siteDir, 'release'), { recursive: true, force: true });
    await fs.mkdir(path.join(siteDir, 'releases', '20260804-195841'), { recursive: true });

    expect(await service.cleanUpLegacyLayouts()).toBe(0);
    await expect(fs.access(path.join(siteDir, 'releases'))).resolves.toBeUndefined();
  }, 30_000);
});
