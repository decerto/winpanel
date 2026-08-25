import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, isNull, like } from 'drizzle-orm';
import {
  PUBLIC_DIR,
  RELEASE_DIR,
  SHARED_DIR,
  Slug,
  isReservedDeviceName,
  type SiteManifest,
  type SiteSource,
} from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { deployments, sites } from '../db/schema.js';
import { removeLegacyLayout } from './deploy-pipeline.js';
import { PortAllocator, runtimeNeedsAppPorts } from './port-allocator.js';
import { scaffoldSite } from './scaffold.js';
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
  // empty, must not end in a hyphen, and must not be a name Windows reserves
  // for a device — there is no folder called `con`, `nul` or `lpt1`.
  const cleaned = base.replace(/-+$/g, '');
  if (cleaned.length < 2 || isReservedDeviceName(cleaned)) {
    return `site-${crypto.randomBytes(3).toString('hex')}`;
  }
  return cleaned;
}

/**
 * Where one person's access token for one website is kept.
 *
 * Keyed by both, deliberately. A token is a credential for somebody's whole
 * account on the git host, so it cannot belong to the website: handing the
 * website to a customer would otherwise hand them the credential with it, and
 * they could point the site at any repository that token can read.
 */
function gitTokenKey(siteId: string, userId: string): string {
  return `site.gitToken:${siteId}:${userId}`;
}

export interface CreateSiteInput {
  displayName: string;
  /** May be empty: the site is then reachable on its preview port only. */
  domains: string[];
  source: SiteSource;
  manifest: SiteManifest;
  envVars?: Record<string, string>;
  /** An access token belongs to the person who pasted it, not to the site. */
  gitToken?: { userId: string; token: string };
  /** OpenSSH private key of a deploy key, for a private repository. */
  gitSshKey?: { privateKey: string; publicKey: string };
  /** Main website this independently deployable subdomain belongs to. */
  parentSiteId?: string | null;
  diskQuotaBytes?: number;
  /** The flavour the site was created from, if any. */
  preset?: 'wordpress' | null;
  /** Whose website this is. Null leaves it belonging to the server. */
  ownerUserId?: string | null;
}

export interface CreatedSite {
  id: string;
  slug: string;
  previewPort: number | null;
  /** Starter files written into the public folder, if any. */
  scaffolded: string[];
}

/**
 * Where a site's served files live.
 *
 * Git sites are served out of `release/`, which the last successful deploy
 * swapped into place. Everything else is served straight from `public`, which
 * the user owns and the panel never overwrites.
 */
export function contentRootFor(
  sitesRoot: string,
  site: { slug: string; source: unknown; manifest: unknown },
): string {
  const siteDir = path.join(sitesRoot, site.slug);
  const source = site.source as SiteSource;
  const manifest = site.manifest as SiteManifest;

  if (source.kind !== 'git') {
    return path.join(siteDir, PUBLIC_DIR, manifest.staticRoot ?? '');
  }

  return path.join(siteDir, RELEASE_DIR, manifest.staticRoot ?? '');
}

/**
 * The folder a site's process is started in.
 *
 * Not the same as the content root: the common "frontend builds into backend"
 * layout serves files from one folder and runs `package.json` from another,
 * and every command the user runs by hand — install, a script, a one-off node
 * invocation — has to land where the app itself runs or it does nothing useful.
 */
export function appRootFor(
  sitesRoot: string,
  site: { slug: string; source: unknown; manifest: unknown },
): string {
  const siteDir = path.join(sitesRoot, site.slug);
  const source = site.source as SiteSource;
  const manifest = site.manifest as SiteManifest;
  const base =
    source.kind === 'git' ? path.join(siteDir, RELEASE_DIR) : path.join(siteDir, PUBLIC_DIR);

  return path.join(base, manifest.app.cwd ?? '');
}

/** Removes a directory only if it holds nothing at all. */
async function removeEmptyDirectory(target: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(target);
    if (entries.length > 0) return false;
    await fs.rmdir(target);
    return true;
  } catch {
    return false;
  }
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

  /**
   * Every website, or only one person's.
   *
   * `ownerUserId` is what a customer sees the panel through. Filtering here
   * rather than in the router means a new page cannot accidentally show one
   * customer another's hosting.
   */
  list(ownerUserId?: string) {
    const query = this.db.db.select().from(sites);
    return (ownerUserId === undefined ? query : query.where(eq(sites.ownerUserId, ownerUserId)))
      .orderBy(sites.displayName)
      .all();
  }

  /** Hands a website to somebody else, or back to the server. */
  setOwner(siteId: string, ownerUserId: string | null): void {
    this.db.db
      .update(sites)
      .set({ ownerUserId, updatedAt: new Date() })
      .where(eq(sites.id, siteId))
      .run();
  }

  get(slug: string) {
    return this.db.db.select().from(sites).where(eq(sites.slug, slug)).get();
  }

  getById(id: string) {
    return this.db.db.select().from(sites).where(eq(sites.id, id)).get();
  }

  childrenFor(parentSiteId: string) {
    return this.db.db.select().from(sites).where(eq(sites.parentSiteId, parentSiteId)).all();
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

  /**
   * Gives a preview port to any site that has none.
   *
   * Preview ports arrived after the first release, so every site created
   * before then has `previewPort` null and no way in without a working domain.
   * Run at startup, this repairs them; for a server where they all have one it
   * is a single query and does nothing.
   *
   * @returns the number of sites that were given a port.
   */
  async ensurePreviewPorts(): Promise<number> {
    const missing = this.db.db.select().from(sites).where(isNull(sites.previewPort)).all();

    let assigned = 0;
    for (const site of missing) {
      try {
        const port = await this.ports.allocatePreviewPort(site.id);
        this.db.db.update(sites).set({ previewPort: port }).where(eq(sites.id, site.id)).run();
        assigned++;
      } catch {
        // Out of ports, or one is unexpectedly busy. The other sites should
        // still be repaired, and this one is no worse off than before.
      }
    }

    return assigned;
  }

  /**
   * Returns ports nothing is using to the pool.
   *
   * Run at startup so a server that has been through a few deletions, a
   * failed creation, or an upgrade that stopped giving static sites a pair
   * gets those numbers back rather than climbing further up the range.
   *
   * @returns the number of ports freed.
   */
  reclaimStalePorts(): number {
    return this.ports.reclaimStalePorts();
  }

  /**
   * Leaves a site with exactly one folder that holds its website.
   *
   * Removes the timestamped `releases/` tree and `current` junction sites used
   * before they had a single `release/` folder, and the folder of the layout
   * the site does not use — `public/` for a git site, `release/` for one the
   * user fills in themselves — which earlier versions created regardless.
   * A deploy already did the first part, but only a deploy did, so a server
   * that updated and then sat there still showed two dated folders with
   * nothing to say which was live. The answer was neither.
   *
   * Nothing goes unless it is provably dead: the live folder has to exist,
   * and the unused one has to be empty.
   *
   * @returns the number of sites that had something removed.
   */
  async cleanUpLegacyLayouts(): Promise<number> {
    let cleaned = 0;

    for (const site of this.list()) {
      const siteDir = path.join(this.sitesRoot, site.slug);
      const live = contentRootFor(this.sitesRoot, site);

      try {
        await fs.access(live);
      } catch {
        continue;
      }

      try {
        let removed = await removeLegacyLayout(siteDir);

        /*
         * `shared/` is served at `/shared` now, and older versions wrote the
         * site's environment file into it. Waiting for the next deploy to
         * move it would leave the secrets of every site that has not been
         * redeployed sitting under a web root.
         */
        await fs.rm(path.join(siteDir, SHARED_DIR, '.env'), { force: true });

        const unusedLayout =
          (site.source as SiteSource).kind === 'git' ? PUBLIC_DIR : RELEASE_DIR;
        const unused = await removeEmptyDirectory(path.join(siteDir, unusedLayout));
        removed = removed || unused;

        if (removed) cleaned++;
      } catch {
        // A file held open by something else. The next start tries again.
      }
    }

    return cleaned;
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

  async create(input: CreateSiteInput): Promise<CreatedSite> {
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
        preset: input.preset ?? input.manifest.preset ?? null,
        domains: input.domains,
        source: input.source,
        manifest: input.manifest,
        parentSiteId: input.parentSiteId ?? null,
        ownerUserId: input.ownerUserId ?? null,
        ...(input.diskQuotaBytes !== undefined
          ? { diskQuotaBytes: input.diskQuotaBytes }
          : {}),
      })
      .run();

    try {
      // Anything a previous failure or an earlier version left behind is a
      // number this site could be using instead of a higher one.
      this.ports.reclaimStalePorts();

      // Static sites are served from disk, so a pair held for one would be two
      // numbers nothing ever listens on.
      const pair = runtimeNeedsAppPorts(input.manifest.runtime)
        ? await this.ports.allocatePair(id, input.manifest.runtime)
        : null;

      // A site with no domain would otherwise be unreachable, and a site whose
      // DNS has not propagated yet indistinguishable from a broken one.
      let previewPort: number | null = null;
      try {
        previewPort = await this.ports.allocatePreviewPort(id);
      } catch {
        // Running out of preview ports is not a reason to refuse the site.
        previewPort = null;
      }

      this.db.db
        .update(sites)
        .set({ portBlue: pair?.blue ?? null, portGreen: pair?.green ?? null, previewPort })
        .where(eq(sites.id, id))
        .run();

      const siteDir = path.join(this.sitesRoot, slug);
      await fs.mkdir(path.join(siteDir, SHARED_DIR), { recursive: true });
      await fs.mkdir(path.join(siteDir, 'logs'), { recursive: true });

      // Exactly one of the two, always. A second folder that looks like it
      // holds the website but never serves it is the whole of the confusion.
      await fs.mkdir(
        path.join(siteDir, input.source.kind === 'git' ? RELEASE_DIR : PUBLIC_DIR),
        { recursive: true },
      );

      const scaffolded =
        input.source.kind === 'blank'
          ? await scaffoldSite({
              publicDir: path.join(siteDir, PUBLIC_DIR),
              runtime: input.manifest.runtime,
              displayName: input.displayName,
            })
          : [];

      if (input.envVars) await this.setEnv(id, input.envVars);
      if (input.gitToken) {
        await this.setGitToken(id, input.gitToken.userId, input.gitToken.token);
      }
      if (input.gitSshKey) {
        await this.setGitSshKey(id, input.gitSshKey.privateKey, input.gitSshKey.publicKey);
      }

      return { id, slug, previewPort, scaffolded };
    } catch (error) {
      // Do not leave a half-created site behind: it would occupy the slug and
      // show up in the list as something that can never work.
      this.db.db.delete(sites).where(eq(sites.id, id)).run();
      throw error;
    }
  }

  /** Absolute path to the folder this site's files are served from. */
  contentRoot(slug: string): string | null {
    const site = this.get(slug);
    return site ? contentRootFor(this.sitesRoot, site) : null;
  }

  async remove(id: string, options: { deleteFiles: boolean }): Promise<void> {
    const site = this.getById(id);
    if (!site) return;

    this.ports.release(id);
    this.db.db.delete(secrets).where(eq(secrets.key, `site.env:${id}`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitToken:${id}`)).run();
    this.db.db.delete(secrets).where(like(secrets.key, `site.gitToken:${id}:%`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitSshKey:${id}`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitSshPublicKey:${id}`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.cloudflareToken:${id}`)).run();
    this.db.db.delete(sites).where(eq(sites.id, id)).run();

    if (options.deleteFiles) {
      // The site's services stopped moments ago and Windows keeps their files
      // open a little longer than the processes that had them.
      await fs.rm(path.join(this.sitesRoot, site.slug), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
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

  async setGitToken(siteId: string, userId: string, token: string): Promise<void> {
    const key = gitTokenKey(siteId, userId);

    if (token.trim().length === 0) {
      this.db.db.delete(secrets).where(eq(secrets.key, key)).run();
      return;
    }

    const ciphertext = this.vault.encrypt(token, key);

    this.db.db
      .insert(secrets)
      .values({ key, ciphertext })
      .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
      .run();
  }

  async getGitToken(siteId: string, userId: string): Promise<string | undefined> {
    return this.readSecret(gitTokenKey(siteId, userId));
  }

  /** Forgets one person's token for one website. */
  clearGitToken(siteId: string, userId: string): void {
    this.db.db.delete(secrets).where(eq(secrets.key, gitTokenKey(siteId, userId))).run();
  }

  /**
   * Who has stored a token for this website, and when.
   *
   * Read straight off the vault keys, so there is no second list to keep in
   * step with the secrets themselves. The tokens are never decrypted here:
   * the page only needs to say whose access is in use, not what it is.
   */
  gitTokenHolders(siteId: string): { userId: string; addedAt: Date }[] {
    const prefix = `site.gitToken:${siteId}:`;

    return this.db.db
      .select()
      .from(secrets)
      .where(like(secrets.key, `${prefix}%`))
      .all()
      .map((row) => ({ userId: row.key.slice(prefix.length), addedAt: row.updatedAt }));
  }

  /**
   * Gives every pre-accounts git token an owner.
   *
   * Tokens used to belong to the website, so anybody who could open it could
   * deploy with somebody else's credentials. They now belong to a person, and
   * the only honest guess at who that was is whoever holds the site — or the
   * first owner account, for a site that belongs to the server. Run once on
   * boot; a token left unclaimed would silently stop deploys working.
   */
  async adoptLegacyGitTokens(fallbackUserId: string | null): Promise<number> {
    const legacy = this.db.db
      .select()
      .from(secrets)
      .where(like(secrets.key, 'site.gitToken:%'))
      .all()
      .filter((row) => row.key.split(':').length === 2);

    let adopted = 0;

    for (const row of legacy) {
      const siteId = row.key.slice('site.gitToken:'.length);
      const site = this.getById(siteId);
      const userId = site?.ownerUserId ?? fallbackUserId;

      // The ciphertext is bound to its key, so moving it means re-encrypting.
      const token = userId ? this.readSecret(row.key) : undefined;
      if (userId && token) {
        await this.setGitToken(siteId, userId, token);
        adopted += 1;
      }

      this.db.db.delete(secrets).where(eq(secrets.key, row.key)).run();
    }

    return adopted;
  }

  /**
   * Stores a deploy key for this site.
   *
   * The public half is kept as well, even though it is not secret: it has to
   * be shown again whenever someone asks "which key did I install?", and
   * re-deriving it would mean decrypting the private half to do so.
   */
  async setGitSshKey(siteId: string, privateKey: string, publicKey: string): Promise<void> {
    for (const [suffix, value] of [
      ['gitSshKey', privateKey],
      ['gitSshPublicKey', publicKey],
    ] as const) {
      const key = `site.${suffix}:${siteId}`;
      const ciphertext = this.vault.encrypt(value, key);

      this.db.db
        .insert(secrets)
        .values({ key, ciphertext })
        .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
        .run();
    }
  }

  private readSecret(key: string): string | undefined {
    const row = this.db.db.select().from(secrets).where(eq(secrets.key, key)).get();
    if (!row) return undefined;

    try {
      return this.vault.decrypt(row.ciphertext, key);
    } catch {
      return undefined;
    }
  }

  async getGitSshKey(siteId: string): Promise<string | undefined> {
    return this.readSecret(`site.gitSshKey:${siteId}`);
  }

  /** The line the user pastes into the repository's deploy keys. */
  async getGitSshPublicKey(siteId: string): Promise<string | undefined> {
    return this.readSecret(`site.gitSshPublicKey:${siteId}`);
  }

  /** Forgets the deploy key, for a site moving to a token or a public repo. */
  clearGitSshKey(siteId: string): void {
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitSshKey:${siteId}`)).run();
    this.db.db.delete(secrets).where(eq(secrets.key, `site.gitSshPublicKey:${siteId}`)).run();
  }

  /** The port currently receiving traffic. */
  activePort(siteId: string): number | null {
    const site = this.getById(siteId);
    if (!site) return null;
    return site.activeColour === 'blue' ? site.portBlue : site.portGreen;
  }
}
