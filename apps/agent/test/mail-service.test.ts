import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { ServiceManager, buildServiceXml } from '../src/windows/service-manager.js';
import { loadMailAdminCredentials } from '../src/mail/credentials.js';
import {
  PANEL_MAIL_ADMIN,
  prepareStalwartForWebServer,
  RECOVERY_ADMIN_ENV_VAR,
  STALWART_SERVICE_ID,
  ensureMailAdminCredentials,
  mailServiceEnv,
  repairStalwartWebPortConflict,
  readInstalledMailCertificate,
  recordInstalledMailCertificate,
  reconcileMailListeners,
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

/**
 * Whether the certificate reached the mail ports is recorded rather than
 * searched for. Asking the mail server means trusting its own search to find a
 * record by name, and "found nothing" reads exactly like "there is nothing" --
 * which showed a certificate as missing on a server that already had it.
 */
describe('what the panel put on the mail ports', () => {
  it('remembers the certificate it installed, by expiry', () => {
    const expires = new Date('2026-11-26T10:00:00.000Z');
    recordInstalledMailCertificate(db, 'mail.example.com', expires);

    expect(readInstalledMailCertificate(db, 'mail.example.com')).toBe(expires.toISOString());
  });

  it('knows nothing about a hostname it has never installed one for', () => {
    expect(readInstalledMailCertificate(db, 'mail.example.com')).toBeNull();
  });

  it('matches the hostname regardless of case', () => {
    const expires = new Date('2026-11-26T10:00:00.000Z');
    recordInstalledMailCertificate(db, 'MAIL.example.com', expires);

    expect(readInstalledMailCertificate(db, 'mail.example.com')).toBe(expires.toISOString());
  });

  it('moves to the new expiry when the certificate is renewed', () => {
    recordInstalledMailCertificate(db, 'mail.example.com', new Date('2026-11-26T10:00:00.000Z'));
    const renewed = new Date('2027-02-01T10:00:00.000Z');
    recordInstalledMailCertificate(db, 'mail.example.com', renewed);

    expect(readInstalledMailCertificate(db, 'mail.example.com')).toBe(renewed.toISOString());
  });
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

  it('retries listener repair while Stalwart is still starting after a reboot', async () => {
    await pretendMailIsInstalled();
    ensureMailAdminCredentials(db, vault);

    let jmapAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/jmap') && jmapAttempts++ === 0) {
        throw new TypeError('fetch failed');
      }

      const body = JSON.parse(init?.body as string) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const methodResponses = body.methodCalls.map(([name, , id]) => {
        if (name === 'x:NetworkListener/query') return [name, { ids: ['smtp', 'https'] }, id];
        if (name === 'x:NetworkListener/get') {
          return [
            name,
            {
              list: [
                { id: 'smtp', name: 'smtp', protocol: 'smtp', bind: { '0': '0.0.0.0:25' } },
                { id: 'https', name: 'https', bind: { '0': '[::]:443' } },
              ],
            },
            id,
          ];
        }
        return [name, {}, id];
      });

      return new Response(JSON.stringify({ methodResponses }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const restart = vi.fn(async () => undefined);
    try {
      const result = await reconcileMailListeners(
        { db, vault, services: { restart } as unknown as ServiceManager },
        { retryForMs: 100, retryDelayMs: 0, sleep: async () => undefined },
      );

      expect(result.changes).toHaveLength(2);
      expect(restart).toHaveBeenCalledOnce();
      expect(jmapAttempts).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still restarts after a listener change when a later readiness check fails', async () => {
    await pretendMailIsInstalled();
    ensureMailAdminCredentials(db, vault);

    let listeners = [
      { id: 'smtp', name: 'smtp', protocol: 'smtp', bind: { '0': '0.0.0.0:25' } },
      { id: 'https', name: 'https', bind: { '0': '[::]:443' } },
      { id: 'submission', name: 'submission', protocol: 'smtp', bind: { '0': '0.0.0.0:587' } },
    ];
    let requests = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/jmap')) return new Response('{}', { status: 404 });

      const body = JSON.parse(init?.body as string) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const [name, , id] = body.methodCalls[0] ?? [];
      requests++;

      // The first listener mutation has already been accepted by this point.
      if (requests === 4) throw new TypeError('fetch failed while checking submission');
      if (name === 'x:NetworkListener/query') {
        return new Response(
          JSON.stringify({ methodResponses: [[name, { ids: listeners.map((listener) => listener.id) }, id]] }),
          { status: 200 },
        );
      }
      if (name === 'x:NetworkListener/get') {
        return new Response(
          JSON.stringify({ methodResponses: [[name, { list: listeners }, id]] }),
          { status: 200 },
        );
      }
      if (name === 'x:NetworkListener/set') {
        listeners = listeners.filter((listener) => listener.id !== 'https');
      }

      return new Response(JSON.stringify({ methodResponses: [[name, {}, id]] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const restart = vi.fn(async () => undefined);
    try {
      const result = await reconcileMailListeners(
        { db, vault, services: { restart } as unknown as ServiceManager },
        { retryForMs: 100, retryDelayMs: 0, sleep: async () => undefined },
      );

      expect(result.changes).toHaveLength(1);
      expect(restart).toHaveBeenCalledOnce();
      expect(requests).toBe(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('repairs a saved web listener before Caddy can release its port', async () => {
    await pretendMailIsInstalled();
    ensureMailAdminCredentials(db, vault);

    const listeners = [
      { id: 'https', name: 'https', bind: { '0': '[::]:443' } },
      { id: 'submission', name: 'submission', protocol: 'smtp', bind: { '0': '0.0.0.0:587' } },
    ];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const [name, , id] = body.methodCalls[0] ?? [];
      if (!String(url).endsWith('/jmap') || !name || !id) return new Response('{}', { status: 404 });

      const result = name.endsWith('/query')
        ? { ids: listeners.map((listener) => listener.id) }
        : { list: listeners };
      return new Response(JSON.stringify({ methodResponses: [[name, result, id]] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const restart = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const setEnvironment = vi.fn(async () => 'unchanged' as const);
    const getState = vi.fn(async () => 'running' as const);
    try {
      const result = await prepareStalwartForWebServer(
        {
          db,
          vault,
          services: { getState, setEnvironment, restart, stop } as unknown as ServiceManager,
        },
        { listHolders: async () => [], retryForMs: 0 },
      );

      expect(result?.changes).toHaveLength(1);
      expect(result?.changes[0]).toContain('443');
      expect(result?.restarted).toBe(true);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('provisions an older panel-managed mail service before repairing its port', async () => {
    await pretendMailIsInstalled();

    const listeners = [
      { id: 'https', name: 'https', bind: { '0': '[::]:443' } },
      { id: 'submission', name: 'submission', protocol: 'smtp', bind: { '0': '0.0.0.0:587' } },
    ];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const [name, , id] = body.methodCalls[0] ?? [];
      if (!String(url).endsWith('/jmap') || !name || !id) return new Response('{}', { status: 404 });

      const result = name.endsWith('/query')
        ? { ids: listeners.map((listener) => listener.id) }
        : { list: listeners };
      return new Response(JSON.stringify({ methodResponses: [[name, result, id]] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const getState = vi.fn(async () => 'stopped' as const);
    const setEnvironment = vi.fn(async () => 'updated' as const);
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    try {
      const result = await prepareStalwartForWebServer(
        {
          db,
          vault,
          services: { getState, setEnvironment, start, stop, restart } as unknown as ServiceManager,
        },
        {
          // The port is only released once the repaired listener has restarted.
          listHolders: async () =>
            restart.mock.calls.length > 0 ? [] : [{ pid: 7540, port: 443, image: 'stalwart.exe' }],
          retryForMs: 0,
          settleForMs: 0,
        },
      );

      expect(result?.changes).toHaveLength(1);
      expect(start).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(loadMailAdminCredentials(db, vault)).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops the mail server when its settings cannot be reached to free the web port', async () => {
    await pretendMailIsInstalled();
    ensureMailAdminCredentials(db, vault);

    // The credential the panel holds is not the one this installation accepts.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );

    const getState = vi.fn(async () => 'running' as const);
    const setEnvironment = vi.fn(async () => 'unchanged' as const);
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    try {
      const result = await prepareStalwartForWebServer(
        {
          db,
          vault,
          services: { getState, setEnvironment, start, stop, restart } as unknown as ServiceManager,
        },
        {
          listHolders: async () => [{ pid: 4964, port: 443, image: 'stalwart.exe' }],
          retryForMs: 0,
          settleForMs: 0,
        },
      );

      expect(stop).toHaveBeenCalledWith('winpanel-stalwart');
      expect(result?.changes.at(-1)).toContain('443');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts and restarts Stalwart to clear a stale web-port conflict', async () => {
    await pretendMailIsInstalled();
    ensureMailAdminCredentials(db, vault);

    const listeners = [
      { id: 'smtp', name: 'smtp', protocol: 'smtp', bind: { '0': '0.0.0.0:25' } },
      { id: 'submission', name: 'submission', protocol: 'smtp', bind: { '0': '0.0.0.0:587' } },
    ];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const [name, , id] = body.methodCalls[0] ?? [];
      if (!String(url).endsWith('/jmap') || !name || !id) return new Response('{}', { status: 404 });

      const result = name.endsWith('/query')
        ? { ids: listeners.map((listener) => listener.id) }
        : { list: listeners };
      return new Response(JSON.stringify({ methodResponses: [[name, result, id]] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const start = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const getState = vi.fn(async () => 'stopped' as const);
    try {
      const result = await repairStalwartWebPortConflict(
        {
          db,
          vault,
          services: { getState, start, restart } as unknown as ServiceManager,
        },
        {
          listHolders: async () => [{ pid: 6168, port: 443, image: 'stalwart.exe' }],
          retryForMs: 0,
        },
      );

      expect(result).toEqual({ changes: [], restarted: true });
      expect(start).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
