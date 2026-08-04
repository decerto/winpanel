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
  syncCaddyEnvironment,
} from '../src/caddy/service.js';
import {
  clearCloudflareToken,
  hasCloudflareToken,
  loadCloudflareToken,
  storeCloudflareToken,
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

/** Stands in for a Caddy service that has already been installed. */
async function pretendCaddyIsInstalled(env: Record<string, string> = {}): Promise<string> {
  await fs.mkdir(configDir(), { recursive: true });
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

describe('the environment Caddy is given', () => {
  it('always points Caddy at its own data directory', () => {
    // Left unset, a LocalSystem service writes its certificates somewhere
    // nobody thinks to back up.
    const env = caddyServiceEnv('C:\\WinPanel\\caddy');

    expect(env['XDG_DATA_HOME']).toBe('C:\\WinPanel\\caddy');
    expect(env['XDG_CONFIG_HOME']).toBe('C:\\WinPanel\\caddy');
  });

  it('omits the token entirely when there is none', () => {
    expect(caddyServiceEnv('C:\\x', null)).not.toHaveProperty(CLOUDFLARE_TOKEN_ENV_VAR);
    expect(caddyServiceEnv('C:\\x', '')).not.toHaveProperty(CLOUDFLARE_TOKEN_ENV_VAR);
  });

  it('uses the same variable name the generated config asks for', () => {
    /*
     * This is the whole bug in one assertion. The config says
     * `{env.CF_API_TOKEN}`; if the service is handed the token under any
     * other name, Caddy resolves it to an empty string and every certificate
     * request fails against Cloudflare rather than here.
     */
    db.db
      .insert(sites)
      .values({
        id: crypto.randomUUID(),
        slug: 'example',
        displayName: 'Example',
        runtime: 'node',
        domains: ['example.com'],
        source: { kind: 'blank' },
        manifest: { schemaVersion: 1, runtime: 'node' },
        portBlue: 3001,
        portGreen: 3002,
      })
      .run();

    storeCloudflareToken(db, vault, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites')).buildConfig(),
    );

    const referenced = /\{env\.([A-Z_]+)\}/.exec(config)?.[1];
    expect(referenced).toBe(CLOUDFLARE_TOKEN_ENV_VAR);
    expect(caddyServiceEnv(caddyDir(), 'cf-secret-token')).toHaveProperty(referenced!);
  });

  it('keeps the token out of the config itself', () => {
    // It goes in the service environment instead, because Caddy autosaves its
    // running config to disk in a folder that is not the locked-down one.
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const config = JSON.stringify(
      new CaddyReconciler(db, new CaddyClient(), path.join(tmpDir, 'sites')).buildConfig(),
    );

    expect(config).not.toContain('cf-secret-token');
  });
});

describe('syncing the token into the service', () => {
  it('does nothing when the web server is not installed yet', async () => {
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });
    expect(result).toBe('not-installed');
  });

  it('writes the token into the service configuration', async () => {
    const configPath = await pretendCaddyIsInstalled(caddyServiceEnv(caddyDir()));
    storeCloudflareToken(db, vault, 'cf-secret-token');

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).toContain(
      `<env name="${CLOUDFLARE_TOKEN_ENV_VAR}" value="cf-secret-token"/>`,
    );
  });

  it('takes the token back out when Cloudflare is disconnected', async () => {
    const configPath = await pretendCaddyIsInstalled(
      caddyServiceEnv(caddyDir(), 'cf-secret-token'),
    );

    const result = await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() });

    expect(result).toBe('updated');
    expect(await fs.readFile(configPath, 'utf8')).not.toContain('cf-secret-token');
  });

  it('is a no-op when nothing has changed', async () => {
    // Called on every panel start, so this is what stops the web server being
    // restarted — dropping connections — for no reason each time.
    storeCloudflareToken(db, vault, 'cf-secret-token');
    await pretendCaddyIsInstalled(caddyServiceEnv(caddyDir(), 'cf-secret-token'));

    expect(await syncCaddyEnvironment({ db, vault, services, caddyDir: caddyDir() })).toBe(
      'unchanged',
    );
  });
});
