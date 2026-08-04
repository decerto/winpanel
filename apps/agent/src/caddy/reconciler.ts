import { eq } from 'drizzle-orm';
import { STALWART_HTTP_PORT, mailHostnameFor, type SiteManifest } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { components, secrets, sites } from '../db/schema.js';
import { contentRootFor } from '../sites/site-service.js';
import type { CaddyClient } from './client.js';
import { buildCaddyConfig, type CaddySiteInput } from './config-builder.js';

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

const CLOUDFLARE_TOKEN_KEY = 'cloudflare.token';

/** The environment variable Caddy reads the Cloudflare token from. */
export const CLOUDFLARE_TOKEN_ENV_VAR = 'CF_API_TOKEN';

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
  ) {}

  /** Builds the configuration that matches the current database state. */
  buildConfig(options: ReconcileOptions = {}): Record<string, unknown> {
    const siteInputs = siteInputsFrom(this.db, this.sitesRoot);

    const hasCloudflare =
      this.db.db.select().from(secrets).where(eq(secrets.key, CLOUDFLARE_TOKEN_KEY)).get() !==
      undefined;

    const firstDomain = siteInputs.find((site) => site.domains.length > 0)?.domains[0];

    // Derived rather than passed in: a caller that forgot the flag would take
    // the webmail interface offline without anything appearing to be wrong.
    const mailInstalled =
      this.db.db.select().from(components).where(eq(components.id, 'stalwart')).get()?.state ===
      'installed';

    return buildCaddyConfig({
      sites: siteInputs,
      // Without a token there is no DNS challenge, and TLS-ALPN cannot work
      // through Cloudflare's proxy. Asking for certificates we cannot obtain
      // would make every request fail rather than fall back to HTTP.
      ...(hasCloudflare ? { cloudflareTokenEnvVar: CLOUDFLARE_TOKEN_ENV_VAR } : {}),
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
