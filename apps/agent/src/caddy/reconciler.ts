import path from 'node:path';
import { STALWART_HTTP_PORT, mailHostnameFor, type SiteManifest } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { sites } from '../db/schema.js';
import { cloudflareTokenGroups } from '../dns/token.js';
import { mailHostnames } from '../mail/domains.js';
import type { SecretVault } from '../security/vault.js';
import { contentRootFor } from '../sites/site-service.js';
import type { CaddyClient } from './client.js';
import { CaddyError } from './client.js';
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
        // Omitted, not falsy: a site with the shared folder switched off gets
        // no `/shared` routes at all, so the path is the app's own again.
        ...(site.sharedFolderEnabled ? { siteDir: path.join(sitesRoot, site.slug) } : {}),
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
    /** Omitted turns access logging off, which is what the tests want. */
    private readonly accessLogDir?: string,
  ) {}

  /** Builds the configuration that matches the current database state. */
  buildConfig(options: ReconcileOptions = {}, admin?: unknown): Record<string, unknown> {
    const siteInputs = siteInputsFrom(this.db, this.sitesRoot);

    const rows = this.db.db.select({ id: sites.id, domains: sites.domains }).from(sites).all();
    const dnsChallenges: DnsChallengeGroup[] = cloudflareTokenGroups(
      this.db,
      this.vault,
      rows.map((row) => ({ id: row.id, domains: row.domains as string[] })),
    ).map((group) => ({ envVar: group.envVar, domains: group.domains }));

    /*
     * Every domain mail is actually configured for, not one guessed per site.
     *
     * Covering only the first site left every other domain's mail ports on the
     * self-signed certificate for good. Deriving one per website domain was no
     * better: it asked for `mail.<every subdomain>`, names nobody had set up,
     * and still missed a mail domain belonging to no website. This is the list
     * the mail server itself gave, mirrored into the database.
     */
    const mailNames = mailHostnames(this.db);

    // The only token that can obtain a certificate for a mail hostname is
    // whichever one covers the domain it sits under.
    for (const group of dnsChallenges) {
      const owned = mailNames.filter((mailHostname) =>
        group.domains.some((domain) => mailHostname === mailHostnameFor(domain)),
      );
      if (owned.length > 0) group.domains = [...group.domains, ...owned];
    }

    return buildCaddyConfig({
      sites: siteInputs,
      ...(admin != null ? { admin } : {}),
      ...(this.accessLogDir ? { accessLogDir: this.accessLogDir } : {}),
      /*
       * Without a token for a domain there is no DNS challenge, and TLS-ALPN
       * cannot work through Cloudflare's proxy. Those domains are left to
       * Caddy's defaults rather than pointed at a token that cannot see them,
       * which would fail every renewal forever.
       */
      ...(dnsChallenges.length > 0 ? { dnsChallenges } : {}),
      ...(options.acmeEmail ? { acmeEmail: options.acmeEmail } : {}),
      /*
       * The list itself is the proof the mail server is there: it only ever
       * comes back from a successful `listDomains()` against it, and is
       * emptied again when the component is removed. It used to be gated on a
       * `components` row as well — a table nothing has ever written, so the
       * gate was always shut and no `mail.<domain>` was ever put in front of
       * Caddy. Every mail port stayed on the self-signed certificate, and the
       * fix button reported that the certificate was taking a while to arrive
       * when in truth it had never been asked for.
       */
      ...(mailNames.length > 0
        ? { mailHost: { hostnames: mailNames, port: STALWART_HTTP_PORT } }
        : {}),
    });
  }

  /** Rebuilds and loads the configuration. Throws if Caddy refuses it. */
  async apply(options: ReconcileOptions = {}): Promise<void> {
    /*
     * The admin endpoint is whatever the running server decided at startup,
     * and it has to be handed back unchanged: Caddy binds the replacement
     * listener before it releases the old one, so naming any other address
     * here fails the entire load with "address already in use".
     */
    await this.caddy.load(this.buildConfig(options, await this.caddy.getAdminConfig()));
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

  /**
   * Applies once the web server is able to accept it.
   *
   * The panel and Caddy are separate Windows services that start in parallel,
   * so the first attempt often lands before Caddy's admin API is listening.
   * One swallowed failure there used to leave every route unbuilt until some
   * later edit happened to trigger another apply — and on a server where
   * nobody edits anything, that is never. Preview addresses show the symptom
   * most clearly: the port is allocated and displayed, but nothing is
   * listening on it.
   *
   * Only retries when Caddy could not be reached. A configuration it has
   * actively rejected will be rejected again, and saying so straight away is
   * more useful than saying so a minute later.
   */
  async applyWhenReady(
    options: ReconcileOptions & { attempts?: number; delayMs?: number } = {},
  ): Promise<Error | null> {
    const { attempts = 10, delayMs = 3000, ...reconcile } = options;

    let last: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      last = await this.tryApply(reconcile);
      if (last === null) return null;
      if (last instanceof CaddyError && last.status !== undefined) return last;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return last;
  }
}
