import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { ServiceManager, buildServiceXml } from '../src/windows/service-manager.js';
import { loadMailAdminCredentials } from '../src/mail/credentials.js';
import {
  PANEL_MAIL_ADMIN,
  RECOVERY_ADMIN_ENV_VAR,
  STALWART_SERVICE_ID,
  ensureMailAdminCredentials,
  mailServiceEnv,
  syncMailEnvironment,
} from '../src/mail/service.js';

/**
 * How the panel comes to have an account on the mail server at all.
 *
 * Stalwart keeps its accounts inside its own datastore, so a freshly installed
 * one has no credential anybody outside it knows. Before this, the panel asked
 * the user for a password that had never been set, and every answer was
 * rejected — the mailbox screen could never be reached.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;
let vault: SecretVault;
let services: ServiceManager;

const configDir = (): string => path.join(tmpDir, 'services');

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-mail-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  services = new ServiceManager(path.join(tmpDir, 'WinSW.exe'), configDir());

  // Service ids are machine-wide, so on a developer's own server sc.exe finds
  // the real mail service and the test would restart it. The configuration
  // under test lives in tmpDir; the state of the real one is irrelevant.
  services.getState = async () => 'stopped';
});

afterEach(async () => {
  vault.lock();
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Stands in for a mail server that has already been installed. */
async function pretendMailIsInstalled(env: Record<string, string> = {}): Promise<string> {
  await fs.mkdir(configDir(), { recursive: true });
  const configPath = path.join(configDir(), `${STALWART_SERVICE_ID}.xml`);

  await fs.writeFile(
    configPath,
    buildServiceXml({
      id: STALWART_SERVICE_ID,
      displayName: 'WinPanel Mail server',
      description: 'Runs your email',
      executable: path.join(tmpDir, 'stalwart.exe'),
      args: [],
      logPath: path.join(tmpDir, 'logs'),
      env,
    }),
  );

  return configPath;
}

describe('the credential the panel manages mail with', () => {
  it('is created once and then reused', () => {
    const first = ensureMailAdminCredentials(db, vault);
    const second = ensureMailAdminCredentials(db, vault);

    expect(first.username).toBe(PANEL_MAIL_ADMIN);
    expect(second).toEqual(first);
    expect(loadMailAdminCredentials(db, vault)).toEqual(first);
  });

  it('never contains a colon, which is the separator it is passed with', () => {
    // `name:password` truncates at the first colon, so a password containing
    // one would be silently wrong rather than rejected.
    for (let attempt = 0; attempt < 20; attempt++) {
      const password = ensureMailAdminCredentials(db, vault).password;
      expect(password).not.toContain(':');
      expect(password.length).toBeGreaterThan(20);
      db.db.run('DELETE FROM secrets' as never);
    }
  });

  it('is handed over under the name the mail server reads it from', () => {
    const env = mailServiceEnv({ username: 'winpanel', password: 'p4ssw0rd' });
    expect(env[RECOVERY_ADMIN_ENV_VAR]).toBe('winpanel:p4ssw0rd');
  });

  it('is stored in the vault rather than in the clear', () => {
    const credentials = ensureMailAdminCredentials(db, vault);

    const raw = db.db.all<{ ciphertext: string }>('SELECT ciphertext FROM secrets' as never);
    expect(JSON.stringify(raw)).not.toContain(credentials.password);
  });
});

describe('handing it to the mail server', () => {
  it('writes it into the service configuration', async () => {
    const configPath = await pretendMailIsInstalled();

    expect(await syncMailEnvironment({ db, vault, services })).toBe('updated');

    const credentials = loadMailAdminCredentials(db, vault);
    expect(credentials).not.toBeNull();
    expect(await fs.readFile(configPath, 'utf8')).toContain(
      `${RECOVERY_ADMIN_ENV_VAR}" value="${credentials?.username}:${credentials?.password}`,
    );
  });

  it('does nothing on a second run, so a restart is not provoked on every boot', async () => {
    await pretendMailIsInstalled();

    expect(await syncMailEnvironment({ db, vault, services })).toBe('updated');
    expect(await syncMailEnvironment({ db, vault, services })).toBe('unchanged');
  });

  it('stores nothing when the mail server is not installed', async () => {
    // A credential the mail server was never given is worse than none: the
    // panel would report itself connected and every request would be refused.
    expect(await syncMailEnvironment({ db, vault, services })).toBe('not-installed');
    expect(loadMailAdminCredentials(db, vault)).toBeNull();
  });

  it('keeps a credential the user connected by hand', async () => {
    await pretendMailIsInstalled();
    await syncMailEnvironment({ db, vault, services });
    const first = loadMailAdminCredentials(db, vault);

    await syncMailEnvironment({ db, vault, services });

    expect(loadMailAdminCredentials(db, vault)).toEqual(first);
  });
});
