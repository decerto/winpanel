import { eq } from 'drizzle-orm';
import { STALWART_HTTP_PORT, mailHostnameFor, type SiteManifest } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { components, sites } from '../db/schema.js';
import { cloudflareTokenGroups } from '../dns/token.js';
import type { SecretVault } from '../security/vault.js';
import { contentRootFor } from '../sites/site-service.js';
import type { CaddyClient } from './client.js';
import { buildCaddyConfig, type CaddySiteInput, type DnsChallengeGroup } from './config-builder.js';

/**
 * Keeps Caddy's running configuration in step with the panel's database.
 *
 * The database is the single source of truth; Caddy holds a projection of it.
 * Anything that changes what should be served — creating a site, deleting one,
 * adding a domain, finishing a deploy — calls `apply()` and the whole config
 * is rebuilt and loaded. Rebuilding everything rather than patching is a
 * deliberate trade: it is a little more work per change, but it cannot drift,
 * and a config that has quietly drifted from the panel's own records is close
 * to impossible to debug from the outside.
 *
 * `POST /load` is graceful in Caddy — connections are drained rather than cut
 * — so this is safe to call while sites are serving traffic.
 */

export interface ReconcileOptions {
  acmeEmail?: string;
}

/** Turns the sites table into the shape the config builder expects. */
export function siteInputsFrom(db: DatabaseHandle, sitesRoot: string): CaddySiteInput[] {
  return db.db
    .select()
    .from(sites)
    .all()
    .map((site) => {
      const manifest = site.manifest as SiteManifest;
      const activePort = site.activeColour === 'blue' ? site.portBlue : site.portGreen;

      return {
        slug: site.slug,
        domains: site.domains as string[],
        // Only static sites are served from disk; for everything else the
        // path is meaningless and passing one would be misleading.
        ...(manifest.runtime === 'static'
          ? { staticRoot: contentRootFor(sitesRoot, site) }
          : {}),
        activePort,
        manifest,
        previewPort: site.previewPort,
        enabled: site.enabled,
      } satisfies CaddySiteInput;
    });
}

export class CaddyReconciler {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly caddy: CaddyClient,
    private readonly sitesRoot: string,
    private readonly vault: SecretVault,
  ) {}

  /** Builds the configuration that matches the current database state. */
  buildConfig(options: ReconcileOptions = {}): Record<string, unknown> {
    const siteInputs = siteInputsFrom(this.db, this.sitesRoot);

    const rows = this.db.db.select({ id: sites.id, domains: sites.domains }).from(sites).all();
    const dnsChallenges: DnsChallengeGroup[] = cloudflareTokenGroups(
      this.db,
      this.vault,
      rows.map((row) => ({ id: row.id, domains: row.domains as string[] })),
    ).map((group) => ({ envVar: group.envVar, domains: group.domains }));

    const firstDomain = siteInputs.find((site) => site.domains.length > 0)?.domains[0];

    // The mail server's own hostname needs a certificate too, and the only
    // token that can obtain one is whichever covers the domain it sits under.
    if (firstDomain) {
      const mailHostname = mailHostnameFor(firstDomain);
      const owner = dnsChallenges.find((group) => group.domains.includes(firstDomain));
      if (owner) owner.domains = [...owner.domains, mailHostname];
    }

    // Derived rather than passed in: a caller that forgot the flag would take
    // the webmail interface offline without anything appearing to be wrong.
    const mailInstalled =
      this.db.db.select().from(components).where(eq(components.id, 'stalwart')).get()?.state ===
      'installed';

    return buildCaddyConfig({
      sites: siteInputs,
      /*
       * Without a token for a domain there is no DNS challenge, and TLS-ALPN
       * cannot work through Cloudflare's proxy. Those domains are left to
       * Caddy's defaults rather than pointed at a token that cannot see them,
       * which would fail every renewal forever.
       */
      ...(dnsChallenges.length > 0 ? { dnsChallenges } : {}),
      ...(options.acmeEmail ? { acmeEmail: options.acmeEmail } : {}),
      ...(mailInstalled && firstDomain
        ? { mailHost: { hostname: mailHostnameFor(firstDomain), port: STALWART_HTTP_PORT } }
        : {}),
    });
  }

  /** Rebuilds and loads the configuration. Throws if Caddy refuses it. */
  async apply(options: ReconcileOptions = {}): Promise<void> {
    await this.caddy.load(this.buildConfig(options));
  }

  /**
   * Applies, but never throws.
   *
   * Used on the paths where a routing failure must not take the calling
   * operation down with it — creating a site is still a success even if the
   * web server happens to be stopped, and the next reconcile will pick it up.
   *
   * @returns the error, if there was one, so the caller can surface it.
   */
  async tryApply(options: ReconcileOptions = {}): Promise<Error | null> {
    try {
      await this.apply(options);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
