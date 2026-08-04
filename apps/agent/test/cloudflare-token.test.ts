import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { ServiceManager, buildServiceXml } from '../src/windows/service-manager.js';
import { CaddyReconciler } from '../src/caddy/reconciler.js';
import { CaddyClient } from '../src/caddy/client.js';
import {
  CADDY_SERVICE_ID,
  CLOUDFLARE_TOKEN_ENV_VAR,
  caddyServiceEnv,
  cloudflareTokenEnvironment,
  syncCaddyEnvironment,
} from '../src/caddy/service.js';
import {
  clearCloudflareToken,
  clearSiteCloudflareToken,
  cloudflareTokenForSite,
  cloudflareTokenGroups,
  hasCloudflareToken,
  loadCloudflareToken,
  storeCloudflareToken,
  storeSiteCloudflareToken,
} from '../src/dns/token.js';

/**
 * The certificate token, end to end.
 *
 * The generated Caddy config refers to the token as `{env.CF_API_TOKEN}`
 * rather than embedding it, which means the config and the service environment
 * have to be kept in step by something. Nothing was: the token was stored in
 * the vault and never reached Caddy, so the DNS challenge could not run and no
 * certificate was ever issued. Nothing failed loudly at any point.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;
let vault: SecretVault;
let services: ServiceManager;

const caddyDir = (): string => path.join(tmpDir, 'caddy');
const configDir = (): string => path.join(tmpDir, 'services');

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-cf-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  services = new ServiceManager(path.join(tmpDir, 'WinSW.exe'), configDir());
});

afterEach(async () => {
  vault.lock();
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A website with one domain, which is all any of this cares about. */
function createSite(domain: string): string {
  const id = crypto.randomUUID();

  db.db
    .insert(sites)
    .values({
      id,
      slug: domain.replace(/\./g, '-'),
      displayName: domain,
      runtime: 'node',
      domains: [domain],
      source: { kind: 'blank' },
      manifest: { schemaVersion: 1, runtime: 'node' },
      portBlue: 3001,
      portGreen: 3002,
    })
    .run();

  return id;
}

/** Stands in for a Caddy service that has already been installed. */
async function pretendCaddyIsInstalled(env: Record<string, string> = {}): Promise<string> {  await fs.mkdir(configDir(), { recursive: true });
  const configPath = path.join(configDir(), `${CADDY_SERVICE_ID}.xml`);

  await fs.writeFile(
    configPath,
    buildServiceXml({
      id: CADDY_SERVICE_ID,
      displayName: 'WinPanel Web server',
      description: 'Serves your websites',
      executable: path.join(tmpDir, 'caddy.exe'),
      args: ['run', '--resume'],
      logPath: path.join(tmpDir, 'logs'),
      env,
    }),
  );

  return configPath;
}

describe('storing the token', () => {
  it('round-trips through the vault and never stores it in the clear', () => {
    storeCloudflareToken(db, vault, 'cf-secret-token');

    expect(loadCloudflareToken(db, vault)).toBe('cf-secret-token');
    expect(hasCloudflareToken(db)).toBe(true);

    const raw = db.db.all<{ ciphertext: string }>('SELECT ciphertext FROM secrets' as never);
    expect(JSON.stringify(raw)).not.toContain('cf-secret-token');
  });

  it('reports no token once disconnected', () => {
    storeCloudflareToken(db, vault, 'cf-secret-token');
    clearCloudflareToken(db);

    expect(loadCloudflareToken(db, vault)).toBeNull();
    expect(hasCloudflareToken(db)).toBe(false);
  });
});

describe('a token per website', () => {
  it('prefers a website\u2019s own token over the shared one', () => {
    const id = createSite('example.com');
    storeCloudflareToken(db, vault, 'shared-token');
    storeSiteCloudflareToken(db, vault, id, 'site-token');

    expect(cloudflareTokenForSite(db, vault, id)).toEqual({
      token: 'site-token',
      source: 'site',
    });
  });

  it('falls back to the shared token, and to nothing at all', () => {
    const id = createSite('example.com');

    expect(cloudflareTokenForSite(db, vault, id)).toBeNull();

    storeCloudflareToken(db, vault, 'shared-token');
    expect(cloudflareTokenForSite(db, vault, id)).toEqual({
      token: 'shared-token',
      source: 'shared',
    });
  });

  it('goes back to the shared token when a website\u2019s own is removed', () => {
    const id = createSite('example.com');
    storeCloudflareToken(db, vault, 'shared-token');
    storeSiteCloudflareToken(db, vault, id, 'site-token');
    clearSiteCloudflareToken(db, id);

    expect(cloudflareTokenForSite(db, vault, id)?.source).toBe('shared');
  });

  it('gives each account its own variable, and shares one between sites that share a token', () => {
    /*
     * The point of the whole change. A token only reaches the zones of the
     * account that issued it, so two domains in two accounts cannot be served
     * by one policy: the DNS challenge would fail for whichever domain the
     * single token could not see.
     */
    const first = createSite('example.com');
    const second = createSite('other.example');
    const third = createSite('third.example');

    storeCloudflareToken(db, vault, 'shared-token');
    storeSiteCloudflareToken(db, vault, second, 'other-account-token');
    storeSiteCloudflareToken(db, vault, third, 'other-account-token');

    const groups = cloudflareTokenGroups(db, vault, [
      { id: first, domains: ['example.com'] },
      { id: second, domains: ['other.example'] },
      { id: third, domains: ['third.example'] },
    ]);

    expect(groups).toHaveLength(2);

    const shared = groups.find((group) => group.envVar === CLOUDFLARE_TOKEN_ENV_VAR);
    expect(shared?.domains).toEqual(['example.com']);

    const other = groups.find((group) => group.envVar !== CLOUDFLARE_TOKEN_ENV_VAR);
    expect(other?.token).toBe('other-account-token');
    expect(other?.domains).toEqual(['other.example', 'third.example']);
    expect(other?.envVar).toMatch(/^CF_API_TOKEN_[0-9A-F]{8}$/);
  });

  it('leaves a website with no token out of the certificate policies entirely', () => {
    // Naming it under a token that cannot see it would fail every renewal
    // forever, where leaving it out lets Caddy try its own challenges.
    const covered = createSite('example.com');
    createSite('nobody.example');
    storeSiteCloudflareToken(db, vault, covered, 'site-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites'), vault).buildConfig(),
    );

    expect(config).toContain('example.com');
    expect(config).not.toMatch(/nobody\.example[^}]*acme/);
  });

  it('builds one certificate policy per token', () => {
    const first = createSite('example.com');
    const second = createSite('other.example');
    storeSiteCloudflareToken(db, vault, first, 'token-one');
    storeSiteCloudflareToken(db, vault, second, 'token-two');

    const config = new CaddyReconciler(
      db,
      new CaddyClient(),
      path.join(tmpDir, 'sites'),
      vault,
    ).buildConfig() as {
      apps: { tls: { automation: { policies: { subjects: string[] }[] } } };
    };

    const policies = config.apps.tls.automation.policies;
    expect(policies).toHaveLength(2);
    expect(policies.map((policy) => policy.subjects).flat().sort()).toEqual([
      'example.com',
      'other.example',
    ]);
  });
});

describe('the environment Caddy is given', () => {
  it('always points Caddy at its own data directory', () => {
    // Left unset, a LocalSystem service writes its certificates somewhere
    // nobody thinks to back up.
    const env = caddyServiceEnv('C:\\WinPanel\\caddy');

    expect(env['XDG_DATA_HOME']).toBe('C:\\WinPanel\\caddy');
    expect(env['XDG_CONFIG_HOME']).toBe('C:\\WinPanel\\caddy');
  });

  it('omits every token when there are none', () => {
    expect(caddyServiceEnv('C:\\x')).not.toHaveProperty(CLOUDFLARE_TOKEN_ENV_VAR);
    expect(caddyServiceEnv('C:\\x', {})).not.toHaveProperty(CLOUDFLARE_TOKEN_ENV_VAR);
  });

  it('uses the same variable name the generated config asks for', () => {
    /*
     * This is the whole bug in one assertion. The config says
     * `{env.CF_API_TOKEN}`; if the service is handed the token under any
     * other name, Caddy resolves it to an empty string and every certificate
     * request fails against Cloudflare rather than here.
     */
    createSite('example.com');
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites'), vault).buildConfig(),
    );

    const referenced = /\{env\.([A-Z_0-9]+)\}/.exec(config)?.[1];
    expect(referenced).toBe(CLOUDFLARE_TOKEN_ENV_VAR);
    expect(cloudflareTokenEnvironment(db, vault)).toHaveProperty(referenced!, 'cf-secret-token');
  });

  it('keeps the token out of the config itself', () => {
    // It goes in the service environment instead, because Caddy autosaves its
    // running config to disk in a folder that is not the locked-down one.
    createSite('example.com');
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites'), vault).buildConfig(),
    );

    expect(config).not.toContain('cf-secret-token');
  });
});

describe('syncing the token into the service', () => {
  it('does nothing when the web server is not installed yet', async () => {
    createSite('example.com');
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });
    expect(result).toBe('not-installed');
  });

  it('writes the token into the service configuration', async () => {
    const configPath = await pretendCaddyIsInstalled(caddyServiceEnv(caddyDir()));
    createSite('example.com');
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).toContain(
      `<env name="${CLOUDFLARE_TOKEN_ENV_VAR}" value="cf-secret-token"/>`,
    );
  });

  it('takes the token back out when Cloudflare is disconnected', async () => {
    const configPath = await pretendCaddyIsInstalled(
      caddyServiceEnv(caddyDir(), { [CLOUDFLARE_TOKEN_ENV_VAR]: 'cf-secret-token' }),
    );

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).not.toContain('cf-secret-token');
  });

  it('is a no-op when nothing has changed', async () => {
    // Called on every panel start, so this is what stops the web server being
    // restarted — dropping connections — for no reason each time.
    createSite('example.com');
    storeCloudflareToken(db, vault, 'cf-secret-token');
    await pretendCaddyIsInstalled(
      caddyServiceEnv(caddyDir(), { [CLOUDFLARE_TOKEN_ENV_VAR]: 'cf-secret-token' }),
    );

    expect(await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() })).toBe(
      'unchanged',
    );
  });
});
