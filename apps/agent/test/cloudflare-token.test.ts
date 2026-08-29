import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { secrets, sites, users } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { ServiceManager, buildServiceXml } from '../src/windows/service-manager.js';
import { CaddyReconciler } from '../src/caddy/reconciler.js';
import { CaddyClient } from '../src/caddy/client.js';
import {
  CADDY_SERVICE_ID,
  caddyAutosavePath,
  caddyServiceEnv,
  cloudflareTokenEnvironment,
  quarantineUnloadableCaddyConfig,
  syncCaddyEnvironment,
} from '../src/caddy/service.js';
import {
  clearSiteCloudflareToken,
  clearLegacyCloudflareToken,
  LEGACY_CLOUDFLARE_TOKEN_ENV_VAR,
  LEGACY_CLOUDFLARE_TOKEN_KEY,
  cloudflareTokenEnvVar,
  cloudflareTokenForSite,
  cloudflareTokenGroups,
  loadLegacyCloudflareToken,
  loadSiteCloudflareToken,
  migrateLegacyCloudflareToken,
  storeSiteCloudflareToken,
} from '../src/dns/token.js';

/**
 * The certificate token, end to end.
 *
 * The generated Caddy config refers to each token as `{env.CF_API_TOKEN_…}`
 * rather than embedding it, which means the config and the service environment
 * have to be kept in step by something. When they are not, nothing fails
 * loudly: Caddy starts, serves HTTP happily, and never manages to issue a
 * certificate, which surfaces days later as an expired site.
 *
 * Every token belongs to one website. There is no shared token: a Cloudflare
 * token only reaches the zones of the account that issued it, so a machine-wide
 * one could manage exactly one account's domains and silently fail for the rest.
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
function createSite(
  domain: string,
  options: { ownerUserId?: string | null; parentSiteId?: string | null } = {},
): string {
  const id = crypto.randomUUID();

  db.db
    .insert(sites)
    .values({
      id,
      slug: domain.replace(/\./g, '-'),
      ownerUserId: options.ownerUserId ?? null,
      parentSiteId: options.parentSiteId ?? null,
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

function createUser(id: string): void {
  db.db
    .insert(users)
    .values({ id, username: id, passwordHash: 'test-hash', role: 'user' })
    .run();
}

function storeLegacyCloudflareToken(token: string, associatedData = LEGACY_CLOUDFLARE_TOKEN_KEY): void {
  db.db
    .insert(secrets)
    .values({ key: LEGACY_CLOUDFLARE_TOKEN_KEY, ciphertext: vault.encrypt(token, associatedData) })
    .run();
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

describe('a token per website', () => {
  it('stages the legacy token on the only unconfigured root website', () => {
    const id = createSite('example.com');
    storeLegacyCloudflareToken('legacy-token-value');

    expect(migrateLegacyCloudflareToken(db, vault)).toEqual({ status: 'staged', siteId: id });
    expect(loadSiteCloudflareToken(db, vault, id)).toBe('legacy-token-value');
    expect(loadLegacyCloudflareToken(db, vault)).toBe('legacy-token-value');

    expect(cloudflareTokenEnvironment(db, vault)).toEqual({
      [cloudflareTokenEnvVar('legacy-token-value')]: 'legacy-token-value',
      [LEGACY_CLOUDFLARE_TOKEN_ENV_VAR]: 'legacy-token-value',
    });

    expect(clearLegacyCloudflareToken(db)).toBe(true);
    expect(loadLegacyCloudflareToken(db, vault)).toBeNull();
  });

  it('leaves the legacy token untouched when more than one root website is eligible', () => {
    const first = createSite('example.com');
    const second = createSite('other.example');
    storeLegacyCloudflareToken('legacy-token-value');

    expect(migrateLegacyCloudflareToken(db, vault)).toEqual({ status: 'ambiguous' });
    expect(loadSiteCloudflareToken(db, vault, first)).toBeNull();
    expect(loadSiteCloudflareToken(db, vault, second)).toBeNull();
    expect(loadLegacyCloudflareToken(db, vault)).toBe('legacy-token-value');
  });

  it('does not assign the legacy token across a mixed root-site state', () => {
    const configured = createSite('example.com');
    const unconfigured = createSite('other.example');
    storeSiteCloudflareToken(db, vault, configured, 'different-token-value');
    storeLegacyCloudflareToken('legacy-token-value');

    expect(migrateLegacyCloudflareToken(db, vault)).toEqual({ status: 'ambiguous' });
    expect(loadSiteCloudflareToken(db, vault, unconfigured)).toBeNull();
    expect(loadLegacyCloudflareToken(db, vault)).toBe('legacy-token-value');
  });

  it('does not migrate a legacy row whose vault authentication fails', () => {
    const id = createSite('example.com');
    storeLegacyCloudflareToken('legacy-token-value', 'wrong-associated-data');

    expect(migrateLegacyCloudflareToken(db, vault)).toEqual({ status: 'unreadable' });
    expect(loadSiteCloudflareToken(db, vault, id)).toBeNull();
    expect(loadLegacyCloudflareToken(db, vault)).toBeNull();
    expect(
      db.db.select().from(secrets).where(eq(secrets.key, LEGACY_CLOUDFLARE_TOKEN_KEY)).get(),
    ).toBeDefined();
  });

  it('round-trips through the vault and never stores it in the clear', () => {
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'cf-secret-token');

    expect(loadSiteCloudflareToken(db, vault, id)).toBe('cf-secret-token');

    const raw = db.db.all<{ ciphertext: string }>('SELECT ciphertext FROM secrets' as never);
    expect(JSON.stringify(raw)).not.toContain('cf-secret-token');
  });

  it('resolves a website to its own token, and to nothing without one', () => {
    const id = createSite('example.com');

    expect(cloudflareTokenForSite(db, vault, id)).toBeNull();

    storeSiteCloudflareToken(db, vault, id, 'site-token');
    expect(cloudflareTokenForSite(db, vault, id)).toEqual({ token: 'site-token', source: 'site' });
  });

  it('uses the direct parent token and ignores a legacy child token', () => {
    const parent = createSite('example.com');
    const child = createSite('blog.example.com', {
      parentSiteId: parent,
    });
    storeSiteCloudflareToken(db, vault, parent, 'parent-token');
    storeSiteCloudflareToken(db, vault, child, 'legacy-child-token');

    expect(cloudflareTokenForSite(db, vault, child)).toEqual({
      token: 'parent-token',
      source: 'parent',
    });
  });

  it('does not inherit across owners or through another subdomain', () => {
    createUser('owner-a');
    createUser('owner-b');
    const parent = createSite('example.com', { ownerUserId: 'owner-a' });
    const otherOwner = createSite('other.example.com', {
      ownerUserId: 'owner-b',
      parentSiteId: parent,
    });
    const child = createSite('blog.example.com', {
      ownerUserId: 'owner-a',
      parentSiteId: otherOwner,
    });
    storeSiteCloudflareToken(db, vault, parent, 'parent-token');

    expect(cloudflareTokenForSite(db, vault, otherOwner)).toBeNull();
    expect(cloudflareTokenForSite(db, vault, child)).toBeNull();
  });

  it('reports nothing once the token is removed', () => {
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'site-token');
    clearSiteCloudflareToken(db, id);

    expect(cloudflareTokenForSite(db, vault, id)).toBeNull();
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

    storeSiteCloudflareToken(db, vault, first, 'first-account-token');
    storeSiteCloudflareToken(db, vault, second, 'other-account-token');
    storeSiteCloudflareToken(db, vault, third, 'other-account-token');

    const groups = cloudflareTokenGroups(db, vault, [
      { id: first, domains: ['example.com'] },
      { id: second, domains: ['other.example'] },
      { id: third, domains: ['third.example'] },
    ]);

    expect(groups).toHaveLength(2);

    // The two sites in the same account share one variable.
    const other = groups.find((group) => group.token === 'other-account-token');
    expect(other?.domains).toEqual(['other.example', 'third.example']);
    expect(other?.envVar).toMatch(/^CF_API_TOKEN_[0-9A-F]{8}$/);
    expect(other?.envVar).toBe(cloudflareTokenEnvVar('other-account-token'));

    const firstGroup = groups.find((group) => group.token === 'first-account-token');
    expect(firstGroup?.domains).toEqual(['example.com']);
    expect(firstGroup?.envVar).toBe(cloudflareTokenEnvVar('first-account-token'));
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

  it('puts a subdomain in the parent token certificate policy', () => {
    const parent = createSite('example.com');
    createSite('blog.example.com', {
      parentSiteId: parent,
    });
    storeSiteCloudflareToken(db, vault, parent, 'parent-token');

    const config = new CaddyReconciler(
      db,
      new CaddyClient(),
      path.join(tmpDir, 'sites'),
      vault,
    ).buildConfig() as {
      apps: { tls: { automation: { policies: { subjects: string[]; issuers?: unknown[] }[] } } };
    };

    const policy = config.apps.tls.automation.policies.find((entry) =>
      entry.subjects.includes('blog.example.com'),
    );
    expect(policy?.subjects).toContain('blog.example.com');
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
    expect(Object.keys(caddyServiceEnv('C:\\x')).some((k) => k.startsWith('CF_API_TOKEN'))).toBe(
      false,
    );
  });

  it('uses the same variable name the generated config asks for', () => {
    /*
     * This is the whole bug in one assertion. The config says
     * `{env.CF_API_TOKEN}`; if the service is handed the token under any
     * other name, Caddy resolves it to an empty string and every certificate
     * request fails against Cloudflare rather than here.
     */
    createSite('example.com');
    const first = db.db.select().from(sites).all()[0]!;
    storeSiteCloudflareToken(db, vault, first.id, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites'), vault).buildConfig(),
    );

    const referenced = /\{env\.([A-Z_0-9]+)\}/.exec(config)?.[1];
    expect(referenced).toBe(cloudflareTokenEnvVar('cf-secret-token'));
    expect(cloudflareTokenEnvironment(db, vault)).toHaveProperty(referenced!, 'cf-secret-token');
  });

  it('keeps the token out of the config itself', () => {
    // It goes in the service environment instead, because Caddy autosaves its
    // running config to disk in a folder that is not the locked-down one.
    const keptOut = createSite('example.com');
    storeSiteCloudflareToken(db, vault, keptOut, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites'), vault).buildConfig(),
    );

    expect(config).not.toContain('cf-secret-token');
  });
});

describe('syncing the token into the service', () => {
  it('does nothing when the web server is not installed yet', async () => {
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });
    expect(result).toBe('not-installed');
  });

  it('writes the token into the service configuration', async () => {
    const configPath = await pretendCaddyIsInstalled(caddyServiceEnv(caddyDir()));
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).toContain(
      `<env name="${cloudflareTokenEnvVar('cf-secret-token')}" value="cf-secret-token"/>`,
    );
  });

  it('takes the token back out when the website disconnects Cloudflare', async () => {
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'cf-secret-token');
    const configPath = await pretendCaddyIsInstalled(
      caddyServiceEnv(caddyDir(), { [cloudflareTokenEnvVar('cf-secret-token')]: 'cf-secret-token' }),
    );

    clearSiteCloudflareToken(db, id);
    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).not.toContain('cf-secret-token');
  });

  it('is a no-op when nothing has changed', async () => {
    // Called on every panel start, so this is what stops the web server being
    // restarted — dropping connections — for no reason each time.
    const id = createSite('example.com');
    storeSiteCloudflareToken(db, vault, id, 'cf-secret-token');
    await pretendCaddyIsInstalled(
      caddyServiceEnv(caddyDir(), { [cloudflareTokenEnvVar('cf-secret-token')]: 'cf-secret-token' }),
    );

    expect(await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() })).toBe(
      'unchanged',
    );
  });
});

/**
 * The token's variable name is derived from the token, so changing one renames
 * it — and Caddy boots from the config it last saved, which still asks for the
 * old name. That config cannot be replaced through the admin API, because the
 * admin API only exists once Caddy has started.
 */
describe('a saved configuration the web server cannot load', () => {
  const unloadable =
    'Error: loading initial config: loading new config: loading http app module: ' +
    "provision http: getting tls app: loading tls app module: provision tls: " +
    "loading module 'acme': provision tls.issuance.acme: loading DNS provider module: " +
    "loading module 'cloudflare': provision dns.providers.cloudflare: API token '' appears invalid";

  it('is moved aside so the web server can start again', async () => {
    const autosave = caddyAutosavePath(caddyDir());
    await fs.mkdir(path.dirname(autosave), { recursive: true });
    await fs.writeFile(autosave, '{"apps":{}}', 'utf8');

    const quarantined = await quarantineUnloadableCaddyConfig(caddyDir(), unloadable);

    expect(quarantined).not.toBeNull();
    await expect(fs.access(autosave)).rejects.toThrow();
    // Kept rather than deleted, so it can still be looked at afterwards.
    expect(await fs.readFile(quarantined!, 'utf8')).toBe('{"apps":{}}');
  });

  it('is left alone when the web server failed for some other reason', async () => {
    const autosave = caddyAutosavePath(caddyDir());
    await fs.mkdir(path.dirname(autosave), { recursive: true });
    await fs.writeFile(autosave, '{"apps":{}}', 'utf8');

    const quarantined = await quarantineUnloadableCaddyConfig(
      caddyDir(),
      'Only one usage of each socket address is normally permitted',
    );

    expect(quarantined).toBeNull();
    expect(await fs.readFile(autosave, 'utf8')).toBe('{"apps":{}}');
  });

  it('reports nothing when there is no saved configuration to move', async () => {
    expect(await quarantineUnloadableCaddyConfig(caddyDir(), unloadable)).toBeNull();
  });
});
