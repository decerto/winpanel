import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { Slug, type SiteManifest, type SiteSource } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { deployments, sites } from '../db/schema.js';
import { PortAllocator } from './port-allocator.js';
import type { SecretVault } from '../security/vault.js';
import { secrets } from '../db/schema.js';

/**
 * Creating, listing and removing websites.
 *
 * Site creation deliberately does the boring parts for the user: it derives a
 * safe folder name, allocates ports, and lays out the directory structure. The
 * wizard should only ever ask about things the panel genuinely cannot work out.
 */

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteError';
  }
}

/** Turns a display name or domain into a safe, unique folder name. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  // A slug becomes a folder name and a Windows service id, so it can never be
  // empty and must not end in a hyphen.
  const cleaned = base.replace(/-+$/g, '');
  return cleaned.length >= 2 ? cleaned : `site-${crypto.randomBytes(3).toString('hex')}`;
}

export interface CreateSiteInput {
  displayName: string;
  domains: string[];
  source: SiteSource;
  manifest: SiteManifest;
  envVars?: Record<string, string>;
  gitToken?: string;
  diskQuotaBytes?: number;
}

export class SiteService {
  private readonly ports: PortAllocator;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly vault: SecretVault,
    private readonly sitesRoot: string,
  ) {
    this.ports = new PortAllocator(db);
  }

  list() {
    return this.db.db.select().from(sites).orderBy(sites.displayName).all();
  }

  get(slug: string) {
    return this.db.db.select().from(sites).where(eq(sites.slug, slug)).get();
  }

  getById(id: string) {
    return this.db.db.select().from(sites).where(eq(sites.id, id)).get();
  }

  deploymentsFor(siteId: string, limit = 20) {
    return this.db.db
      .select()
      .from(deployments)
      .where(eq(deployments.siteId, siteId))
      .orderBy(desc(deployments.startedAt))
      .limit(limit)
      .all();
  }

  private uniqueSlug(preferred: string): string {
    let candidate = preferred;
    let counter = 2;

    while (this.db.db.select().from(sites).where(eq(sites.slug, candidate)).get()) {
      candidate = `${preferred.slice(0, 44)}-${counter}`;
      counter++;
    }
    return candidate;
  }

  async create(input: CreateSiteInput): Promise<{ id: string; slug: string }> {
    const preferred = slugify(input.domains[0] ?? input.displayName);
    const parsed = Slug.safeParse(preferred);
    if (!parsed.success) {
      throw new SiteError('That website name cannot be used. Try a simpler name.');
    }

    const slug = this.uniqueSlug(parsed.data);
    const id = crypto.randomUUID();

    this.db.db
      .insert(sites)
      .values({
        id,
        slug,
        displayName: input.displayName,
        runtime: input.manifest.runtime,
        domains: input.domains,
        source: input.source,
        manifest: input.manifest,
        ...(input.diskQuotaBytes !== undefined
          ? { diskQuotaBytes: input.diskQuotaBytes }
          : {}),
      })
      .run();

    try {
      const pair = await this.ports.allocatePair(id, input.manifest.runtime);

      this.db.db
        .update(sites)
        .set({ portBlue: pair.blue, portGreen: pair.green })
        .where(eq(sites.id, id))
        .run();

      const siteDir = path.join(this.sitesRoot, slug);
      await fs.mkdir(path.join(siteDir, 'releases'), { recursive: true });
      await fs.mkdir(path.join(siteDir, 'shared'), { recursive: true });
      await fs.mkdir(path.join(siteDir, 'logs'), { recursive: true });

      if (input.envVars) await this.setEnv(id, input.envVars);
      if (input.gitToken) await this.setGitToken(id, input.gitToken);

      return { id, slug };
    } catch (error) {
      // Do not leave a half-created site behind: it would occupy the slug and
      // show up in the list as something that can never work.
      this.db.db.delete(sites).where(eq(sites.id, id)).run();
      throw error;
    }
  }

  async remove(id: string, options: { deleteFiles: boolean }): Promise<void> {
    const site = this.getById(id);
    if (!site) return;

    this.ports.release(id);
    this.db.db.delete(secrets).where(eq(secrets.key, `site.env:${id}`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitToken:${id}`)).run();
    this.db.db.delete(sites).where(eq(sites.id, id)).run();

    if (options.deleteFiles) {
      await fs.rm(path.join(this.sitesRoot, site.slug), { recursive: true, force: true });
    }
  }

  /** Stores the site's environment variables, encrypted. */
  async setEnv(siteId: string, env: Record<string, string>): Promise<void> {
    const key = `site.env:${siteId}`;
    const ciphertext = this.vault.encrypt(JSON.stringify(env), key);

    this.db.db
      .insert(secrets)
      .values({ key, ciphertext })
      .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
      .run();

    // The names are stored in the clear so the UI can show them without
    // decrypting anything; the values never leave the vault.
    const site = this.getById(siteId);
    if (site) {
      const manifest = site.manifest as SiteManifest;
      this.db.db
        .update(sites)
        .set({ manifest: { ...manifest, envVars: Object.keys(env) } })
        .where(eq(sites.id, siteId))
        .run();
    }
  }

  async getEnv(siteId: string): Promise<Record<string, string>> {
    const key = `site.env:${siteId}`;
    const row = this.db.db.select().from(secrets).where(eq(secrets.key, key)).get();
    if (!row) return {};

    try {
      return JSON.parse(this.vault.decrypt(row.ciphertext, key)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async setGitToken(siteId: string, token: string): Promise<void> {
    const key = `site.gitToken:${siteId}`;
    const ciphertext = this.vault.encrypt(token, key);

    this.db.db
      .insert(secrets)
      .values({ key, ciphertext })
      .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
      .run();
  }

  async getGitToken(siteId: string): Promise<string | undefined> {
    const key = `site.gitToken:${siteId}`;
    const row = this.db.db.select().from(secrets).where(eq(secrets.key, key)).get();
    if (!row) return undefined;

    try {
      return this.vault.decrypt(row.ciphertext, key);
    } catch {
      return undefined;
    }
  }

  /** The port currently receiving traffic. */
  activePort(siteId: string): number | null {
    const site = this.getById(siteId);
    if (!site) return null;
    return site.activeColour === 'blue' ? site.portBlue : site.portGreen;
  }
}
