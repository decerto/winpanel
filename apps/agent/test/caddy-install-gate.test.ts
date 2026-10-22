import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADDY_CONFIRMATION_CODE } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { writeSecret } from '../src/security/secret-store.js';
import type { ServiceManager } from '../src/windows/service-manager.js';
import { CADDY_OFFICIAL_URL } from '../src/components/catalogue.js';
import { DownloadError } from '../src/components/download.js';
import {
  createInstallComponentHandler,
  type InstallerDependencies,
} from '../src/components/installer.js';
import {
  hasAnyCloudflareToken,
  LEGACY_CLOUDFLARE_TOKEN_KEY,
  storeSiteCloudflareToken,
} from '../src/dns/token.js';
import type { JobContext } from '../src/jobs/queue.js';

/**
 * Caddy's Cloudflare build is the only one that can issue Cloudflare DNS
 * certificates. When it cannot be downloaded, the official build is installed
 * only with the user's say-so, and only when a token is actually in use. The
 * gate must fire before the running Caddy is stopped, or a slow build service
 * would take every website down.
 */

const mocks = vi.hoisted(() => ({ downloadVerified: vi.fn() }));

vi.mock('../src/components/download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/download.js')>()),
  downloadVerified: mocks.downloadVerified,
}));

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;
let vault: SecretVault;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-caddy-gate-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  mocks.downloadVerified.mockReset();
});

afterEach(async () => {
  vault.lock();
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A service manager that reports Caddy as already registered and running. */
function runningServices() {
  return {
    isInstalled: vi.fn(async () => true),
    uninstall: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    reconfigure: vi.fn(async () => undefined),
  };
}

function dependencies(services: ReturnType<typeof runningServices>): InstallerDependencies {
  return {
    db,
    vault,
    services: services as unknown as ServiceManager,
    binDir: path.join(tmpDir, 'bin'),
    sitesRoot: path.join(tmpDir, 'sites'),
    dataDir: path.join(tmpDir, 'data'),
    logDir: path.join(tmpDir, 'logs'),
    caddyDir: path.join(tmpDir, 'caddy'),
    agentDistDir: tmpDir,
    mailHostname: () => 'mail.example.test',
  };
}

function context(lines: string[]): JobContext {
  return {
    jobId: 'job-caddy-gate',
    log: (message) => {
      lines.push(message);
    },
    progress: () => undefined,
    isCancelled: () => false,
    throwIfCancelled: () => undefined,
  };
}

/** The Cloudflare build is unreachable; the official build downloads fine. */
function buildServiceUnavailable(): void {
  mocks.downloadVerified.mockImplementation(async (options: { url: string }) => {
    if (options.url === CADDY_OFFICIAL_URL) return undefined;
    throw new DownloadError('The Caddy build service did not answer in time.');
  });
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the install to fail.');
}

describe('Caddy install with a Cloudflare build that cannot be downloaded', () => {
  it('asks before the official build when a Cloudflare token is in use, and leaves Caddy running', async () => {
    storeSiteCloudflareToken(db, vault, crypto.randomUUID(), 'cf-token-value');
    buildServiceUnavailable();
    const services = runningServices();
    const lines: string[] = [];

    const handler = createInstallComponentHandler(dependencies(services));
    const error = await errorOf(handler({ componentId: 'caddy' }, context(lines)));

    expect(error.message).toContain(CADDY_CONFIRMATION_CODE);
    expect(mocks.downloadVerified).toHaveBeenCalledTimes(1);
    expect(services.uninstall).not.toHaveBeenCalled();
  });

  it('falls back to the official build without asking when no Cloudflare token exists', async () => {
    buildServiceUnavailable();
    const services = runningServices();
    const lines: string[] = [];

    const handler = createInstallComponentHandler(dependencies(services));
    const error = await errorOf(handler({ componentId: 'caddy' }, context(lines)));

    expect(error.message).not.toContain(CADDY_CONFIRMATION_CODE);
    expect(mocks.downloadVerified).toHaveBeenCalledTimes(2);
    expect(mocks.downloadVerified.mock.calls[1]?.[0]).toMatchObject({ url: CADDY_OFFICIAL_URL });
    expect(lines.some((line) => line.includes('Installing the official Caddy'))).toBe(true);
  });

  it('installs the official build straight away once the user has confirmed it', async () => {
    storeSiteCloudflareToken(db, vault, crypto.randomUUID(), 'cf-token-value');
    mocks.downloadVerified.mockResolvedValue(undefined);
    const services = runningServices();
    const lines: string[] = [];

    const handler = createInstallComponentHandler(dependencies(services));
    await errorOf(
      handler({ componentId: 'caddy', officialCaddyConfirmed: true }, context(lines)),
    );

    expect(mocks.downloadVerified).toHaveBeenCalledTimes(1);
    expect(mocks.downloadVerified.mock.calls[0]?.[0]).toMatchObject({ url: CADDY_OFFICIAL_URL });
    expect(lines.some((line) => line.includes('as confirmed'))).toBe(true);
  });
});

describe('hasAnyCloudflareToken', () => {
  it('is false when no token has been stored', () => {
    expect(hasAnyCloudflareToken(db)).toBe(false);
  });

  it('sees a per-website token', () => {
    storeSiteCloudflareToken(db, vault, crypto.randomUUID(), 'cf-token-value');
    expect(hasAnyCloudflareToken(db)).toBe(true);
  });

  it('sees the legacy machine-wide token until it is migrated', () => {
    writeSecret(db, vault, LEGACY_CLOUDFLARE_TOKEN_KEY, 'legacy-token-value');
    expect(hasAnyCloudflareToken(db)).toBe(true);
  });
});
