import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { storeSiteCloudflareToken } from '../src/dns/token.js';
import { storeMailDomains } from '../src/mail/domains.js';
import { CaddyReconciler, siteInputsFrom } from '../src/caddy/reconciler.js';
import {
  UNCLAIMED_HOST_ROUTE_ID,
  previewServerIdFor,
  routeIdFor,
} from '../src/caddy/config-builder.js';
import { CaddyClient } from '../src/caddy/client.js';

/**
 * The step that was missing entirely.
 *
 * `buildCaddyConfig` was written, exported and thoroughly tested, but nothing
 * ever handed the result to Caddy — so no website was ever served, and the
 * upstream switch at the end of a deploy patched an `@id` that had never been
 * registered. The tests below exist so that the *wiring*, not just the shape
 * of the JSON, has to keep working.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;
let vault: SecretVault;
const sitesRoot = (): string => path.join(tmpDir, 'sites');

function insertSite(overrides: Partial<typeof sites.$inferInsert> = {}): string {
  const id = crypto.randomUUID();
  db.db
    .insert(sites)
    .values({
      id,
      slug: 'example',
      displayName: 'Example',
      runtime: 'node',
      domains: ['example.com'],
      source: { kind: 'git', url: 'https://example.com/x.git', branch: 'main', subdirectory: '' },
      manifest: { schemaVersion: 1, runtime: 'node' },
      portBlue: 3001,
      portGreen: 3002,
      previewPort: 7001,
      ...overrides,
    })
    .run();

  return id;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-reconcile-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  vault.lock();
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('turning the database into a Caddy config', () => {
  it('produces a route for a site that has a domain', () => {
    insertSite();

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const route = config.apps.http.servers.main.routes.find(
      (r: any) => r['@id'] === routeIdFor('example'),
    );

    expect(route.match[0].host).toEqual(['example.com']);
  });

  it('proxies to the colour that is actually serving', () => {
    insertSite({ activeColour: 'green' });

    const [site] = siteInputsFrom(db, sitesRoot());
    expect(site!.activePort).toBe(3002);
  });

  it('serves a static site out of its public folder when it has no repository', () => {
    // The case the panel could not do at all: a folder of HTML files.
    insertSite({
      runtime: 'static',
      source: { kind: 'blank' },
      manifest: { schemaVersion: 1, runtime: 'static' },
    });

    const [site] = siteInputsFrom(db, sitesRoot());
    expect(site!.staticRoot).toBe(path.join(sitesRoot(), 'example', 'public'));
  });

  it('serves a static git site out of the current release', () => {
    // `current` is a junction the deploy repoints, so the path stays stable
    // while the release behind it changes.
    insertSite({
      runtime: 'static',
      manifest: { schemaVersion: 1, runtime: 'static' },
    });

    const [site] = siteInputsFrom(db, sitesRoot());
    expect(site!.staticRoot).toBe(path.join(sitesRoot(), 'example', 'release'));
  });

  it('gives a domainless site a preview listener and nothing on port 80', () => {
    insertSite({ domains: [] });

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;

    expect(config.apps.http.servers[previewServerIdFor('example')].listen).toEqual([':7001']);
    expect(config.apps.http.servers.main.routes.map((r: any) => r['@id'])).toEqual([
      UNCLAIMED_HOST_ROUTE_ID,
    ]);
  });

  it('asks for certificates only once Cloudflare is connected', () => {
    /*
     * Requesting them without a token means the DNS challenge cannot run, and
     * TLS-ALPN cannot work through Cloudflare's proxy. Caddy would then fail
     * every HTTPS request rather than serving the site over HTTP.
     */
    insertSite();
    const reconciler = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault);

    expect(JSON.stringify(reconciler.buildConfig())).not.toContain('acme');

    const siteId = db.db.select().from(sites).all()[0]!.id;
    storeSiteCloudflareToken(db, vault, siteId, 'cf-secret-token');

    expect(JSON.stringify(reconciler.buildConfig())).toContain('acme');
  });

  it('leaves out a site that has been disabled', () => {
    insertSite({ enabled: false });
    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    expect(config.apps.http.servers.main.routes.map((r: any) => r['@id'])).toEqual([
      UNCLAIMED_HOST_ROUTE_ID,
    ]);
    expect(config.apps.http.servers[previewServerIdFor('example')]).toBeUndefined();
  });

  it('publishes the shared folder by default', () => {
    insertSite();

    const [site] = siteInputsFrom(db, sitesRoot());
    expect(site!.siteDir).toBe(path.join(sitesRoot(), 'example'));
  });

  it('gives /shared back to the site when the folder is switched off', () => {
    // Not merely unrouted: the path has to reach the app again, or turning the
    // setting off would leave a hole where the site's own page used to be.
    insertSite({ sharedFolderEnabled: false });

    const [site] = siteInputsFrom(db, sitesRoot());
    expect(site!.siteDir).toBeUndefined();

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig();
    expect(JSON.stringify(config)).not.toContain('/shared/*');
  });

  it('leaves out the mail route until the mail server reports a domain', () => {
    insertSite();
    storeMailDomains(db, []);

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const ids = config.apps.http.servers.main.routes.map((r: any) => r['@id']);
    expect(ids).not.toContain('mail_route');
  });

  it('asks for a certificate for every domain mail is set up for', () => {
    // Covering only the first site left every other domain's mail ports on the
    // mail server's self-signed certificate, which no mail client accepts.
    insertSite();
    storeMailDomains(db, ['example.com', 'second.com']);

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const route = config.apps.http.servers.main.routes.find((r: any) => r['@id'] === 'mail_route');

    expect(route.match[0].host).toEqual(['mail.example.com', 'mail.second.com']);
  });

  it('asks for nothing for a domain that only hosts a website', () => {
    // `mail.<every subdomain>` is a name nobody set up, and asking a
    // certificate authority for it fails on repeat rather than harmlessly.
    insertSite({ domains: ['example.com', 'app.example.com'] });
    storeMailDomains(db, ['example.com']);

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const route = config.apps.http.servers.main.routes.find((r: any) => r['@id'] === 'mail_route');

    expect(route.match[0].host).toEqual(['mail.example.com']);
  });

  it('puts a mail hostname under the token that can see its domain', () => {
    const siteId = insertSite();
    storeMailDomains(db, ['example.com']);
    storeSiteCloudflareToken(db, vault, siteId, 'cf-secret-token');

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const policy = config.apps.tls.automation.policies.find((p: any) => p.issuers);

    expect(policy.subjects).toEqual(expect.arrayContaining(['example.com', 'mail.example.com']));
  });

  it('uses the website token for mail when the site lists only the www name', () => {
    /*
     * The whole promise of a token per website: one token covers its zone, so
     * the person who pasted it does not then have to work out why email alone
     * was left without a certificate.
     */
    const siteId = insertSite({ domains: ['www.example.com'] });
    storeMailDomains(db, ['example.com']);
    storeSiteCloudflareToken(db, vault, siteId, 'cf-secret-token');

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const policy = config.apps.tls.automation.policies.find((p: any) => p.issuers);

    expect(policy.subjects).toContain('mail.example.com');
  });

  it('never hands a name to a token from somebody else\u2019s account', () => {
    // A token only reaches its own zones, so naming it under one that cannot
    // see it would fail every renewal forever.
    const mine = insertSite({ slug: 'mine', domains: ['example.com'] });
    insertSite({ slug: 'theirs', displayName: 'Theirs', domains: ['other.example'] });
    storeMailDomains(db, ['other.example']);
    storeSiteCloudflareToken(db, vault, mine, 'cf-secret-token');

    const config = new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).buildConfig() as any;
    const policy = config.apps.tls.automation.policies.find((p: any) => p.issuers);

    expect(policy.subjects).not.toContain('mail.other.example');
  });
});

describe('applying the configuration', () => {
  it('reports rather than throws when the web server is not running', async () => {
    // A fresh machine has no Caddy yet, and the panel is where you go to
    // install it. Failing hard here would make the panel unusable.
    insertSite();

    const reconciler = new CaddyReconciler(
      db,
      new CaddyClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }),
      sitesRoot(),
      vault,
    );

    const error = await reconciler.tryApply();
    expect(error).toBeInstanceOf(Error);

    await expect(reconciler.apply()).rejects.toThrow();
  });

  it('repeats what the web server said it disliked', async () => {
    // "The web server rejected the change." on its own is a dead end: Caddy
    // names the offending part of the config and nobody was seeing it.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'listening on :443: address in use' }), {
        status: 400,
      })) as typeof fetch;

    try {
      await expect(new CaddyClient().load({})).rejects.toThrow(/address in use/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('names an origin the admin API accepts', async () => {
    // Node attaches an empty Origin to every write, and Caddy refuses those.
    const original = globalThis.fetch;
    let sent: string | null = null;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sent = new Headers(init.headers).get('origin');
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await new CaddyClient({ baseUrl: 'http://127.0.0.1:2019' }).load({});
    } finally {
      globalThis.fetch = original;
    }

    expect(sent).toBe('http://127.0.0.1:2019');
  });

  it('hands the admin endpoint back exactly as it found it', async () => {
    // Caddy binds the replacement admin listener before releasing the old one,
    // so a config naming any other address fails the whole load with "Only one
    // usage of each socket address" and the deploy cannot switch traffic.
    insertSite();

    const original = globalThis.fetch;
    let loaded: any = null;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (init.method === 'GET') {
        return new Response(JSON.stringify({ admin: { listen: 'localhost:2019' } }), {
          status: 200,
        });
      }
      loaded = JSON.parse(String(init.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).apply();
    } finally {
      globalThis.fetch = original;
    }

    expect(loaded.admin).toEqual({ listen: 'localhost:2019' });
  });

  it('omits the admin block when the server has no config of its own', async () => {
    insertSite();

    const original = globalThis.fetch;
    let loaded: any = null;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      // A Caddy started with `--resume` and no saved config answers `null`,
      // and rejects `/config/admin` outright with "invalid traversal path".
      if (init.method === 'GET') return new Response('null', { status: 200 });
      loaded = JSON.parse(String(init.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault).apply();
    } finally {
      globalThis.fetch = original;
    }

    expect(loaded).not.toHaveProperty('admin');
  });
});

describe('waiting for the web server to come up', () => {
  /**
   * The panel and Caddy are separate Windows services, so at boot the first
   * attempt regularly lands before Caddy is listening. A single swallowed
   * failure there left every route — including preview addresses — unbuilt
   * until some later edit happened to trigger another apply.
   */
  it('retries while Caddy is still starting, then applies', async () => {
    insertSite({ domains: [] });

    const original = globalThis.fetch;
    let calls = 0;
    let loaded: any = null;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      if (calls <= 2) throw new Error('connect ECONNREFUSED 127.0.0.1:2019');
      if (init.method === 'GET') return new Response('null', { status: 200 });
      loaded = JSON.parse(String(init.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const error = await new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault)
        .applyWhenReady({ attempts: 5, delayMs: 1 });
      expect(error).toBeNull();
    } finally {
      globalThis.fetch = original;
    }

    expect(loaded.apps.http.servers[previewServerIdFor('example')].listen).toEqual([':7001']);
  });

  it('gives up immediately when Caddy answers but refuses the config', async () => {
    insertSite();

    const original = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      if (init.method === 'GET') return new Response('null', { status: 200 });
      return new Response(JSON.stringify({ error: 'listen tcp :80: bind: in use' }), {
        status: 400,
      });
    }) as unknown as typeof fetch;

    try {
      const error = await new CaddyReconciler(db, new CaddyClient(), sitesRoot(), vault)
        .applyWhenReady({ attempts: 5, delayMs: 1 });
      expect(error?.message).toContain('bind: in use');
    } finally {
      globalThis.fetch = original;
    }

    // One GET plus one POST: a rejection is not retried.
    expect(calls).toBe(2);
  });
});
