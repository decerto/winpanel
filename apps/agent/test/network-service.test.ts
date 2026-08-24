import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { SecretVault } from '../src/security/vault.js';
import { DatabaseNetworkService } from '../src/databases/network-service.js';
import { mariaDbAccountPlan, mariaDbRemoteHosts } from '../src/databases/mariadb.js';
import { mongoAuthRestrictions } from '../src/databases/mongodb.js';
import { combineDatabaseNetworkPolicies } from '../src/databases/network.js';
import { getDatabase, recordDatabase, setDatabaseNetwork } from '../src/databases/store.js';
import { engineBinDir, engineDataDir } from '../src/databases/types.js';
import type { ServiceDefinition, ServiceManager } from '../src/windows/service-manager.js';
import type { FirewallManager, FirewallRule } from '../src/bootstrap/windows-setup.js';

/**
 * Who may reach a database from off the machine.
 *
 * The choice belongs to whoever owns the database, but a listener and a
 * firewall rule are machine-wide. So the question throughout is not "did the
 * port open" but "did opening it for one database leave anybody else's within
 * reach" — which is what the per-database rules below exist to answer.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-network-service-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function serviceDouble(
  onReconfigure: (definition: ServiceDefinition) => Promise<'updated'> = async () => 'updated',
): ServiceManager {
  return {
    isInstalled: async () => true,
    // Stopped, so the engines whose logins are changed over a connection are
    // left alone; this suite is about the file and firewall side.
    getState: async () => 'stopped',
    reconfigure: onReconfigure,
  } as unknown as ServiceManager;
}

function firewallDouble(applied: FirewallRule[], removed: string[]): FirewallManager {
  return {
    apply: async (rule: FirewallRule) => {
      applied.push(rule);
    },
    remove: async (name: string) => {
      removed.push(name);
    },
  } as unknown as FirewallManager;
}

const hbaPath = () => path.join(engineDataDir(path.join(tmpDir, 'data'), 'postgres'), 'pg_hba.conf');

async function makePostgresService(
  service: ServiceManager,
  applied: FirewallRule[] = [],
  removed: string[] = [],
): Promise<DatabaseNetworkService> {
  const binDir = path.join(tmpDir, 'bin');
  const dataDir = path.join(tmpDir, 'data');
  await fs.mkdir(engineBinDir(binDir, 'postgres'), { recursive: true });
  await fs.writeFile(path.join(engineBinDir(binDir, 'postgres'), 'postgres.exe'), 'test');
  await fs.mkdir(engineDataDir(dataDir, 'postgres'), { recursive: true });
  await fs.writeFile(hbaPath(), '# local access\nlocal all all trust\n');

  return new DatabaseNetworkService({
    db,
    vault: new SecretVault(path.join(tmpDir, 'vault.key')),
    services: service,
    firewall: firewallDouble(applied, removed),
    binDir,
    dataDir,
    logDir: path.join(tmpDir, 'logs'),
  });
}

function givePostgresDatabase(name: string): string {
  return recordDatabase(db, {
    engine: 'postgres',
    name,
    username: name,
    siteId: null,
    ownerUserId: null,
  });
}

describe('one database opening the port', () => {
  it('lets in its own sources and nobody else\u2019s database', async () => {
    const applied: FirewallRule[] = [];
    const reconfigured: ServiceDefinition[] = [];
    const service = await makePostgresService(
      serviceDouble(async (definition) => {
        reconfigured.push(definition);
        return 'updated';
      }),
      applied,
    );

    const mine = givePostgresDatabase('u_freya_shop');
    givePostgresDatabase('u_sam_blog');

    await service.setForDatabase(getDatabase(db, mine)!, {
      mode: 'whitelist',
      remoteCidrs: ['203.0.113.42'],
    });

    const hba = await fs.readFile(hbaPath(), 'utf8');
    // Named database and role, never "all all": the other customer's database
    // has no line at all, so the open port does nothing for it.
    expect(hba).toContain('host u_freya_shop u_freya_shop 203.0.113.42/32 scram-sha-256');
    expect(hba).not.toContain('u_sam_blog');
    expect(hba).not.toContain('host all all');

    expect(applied.at(-1)).toMatchObject({ port: 5432, remoteIp: '203.0.113.42' });
    expect(reconfigured.at(-1)?.args).toContain('0.0.0.0');
  });

  it('closes the port again once the last database goes back to loopback', async () => {
    const removed: string[] = [];
    const reconfigured: ServiceDefinition[] = [];
    const service = await makePostgresService(
      serviceDouble(async (definition) => {
        reconfigured.push(definition);
        return 'updated';
      }),
      [],
      removed,
    );

    const id = givePostgresDatabase('u_freya_shop');
    await service.setForDatabase(getDatabase(db, id)!, {
      mode: 'whitelist',
      remoteCidrs: ['203.0.113.42'],
    });
    await service.setForDatabase(getDatabase(db, id)!, { mode: 'loopback', remoteCidrs: [] });

    expect(await fs.readFile(hbaPath(), 'utf8')).not.toContain('WINPANEL DATABASE NETWORK ACCESS');
    expect(removed).toContain('WinPanel - Database (PostgreSQL)');
    expect(reconfigured.at(-1)?.args).toContain('127.0.0.1');
  });

  it('keeps the port open while another database still wants it', async () => {
    const applied: FirewallRule[] = [];
    const service = await makePostgresService(serviceDouble(), applied);

    const first = givePostgresDatabase('u_freya_shop');
    const second = givePostgresDatabase('u_sam_blog');

    await service.setForDatabase(getDatabase(db, first)!, {
      mode: 'whitelist',
      remoteCidrs: ['203.0.113.42'],
    });
    await service.setForDatabase(getDatabase(db, second)!, {
      mode: 'whitelist',
      remoteCidrs: ['198.51.100.7'],
    });
    await service.setForDatabase(getDatabase(db, first)!, { mode: 'loopback', remoteCidrs: [] });

    const hba = await fs.readFile(hbaPath(), 'utf8');
    expect(hba).toContain('198.51.100.7/32');
    expect(hba).not.toContain('203.0.113.42');
    expect(applied.at(-1)).toMatchObject({ remoteIp: '198.51.100.7' });
  });

  it('puts the database back as it was when the listener will not take it', async () => {
    const service = await makePostgresService(
      serviceDouble(async () => {
        throw new Error('restart failed');
      }),
    );

    const id = givePostgresDatabase('u_freya_shop');

    await expect(
      service.setForDatabase(getDatabase(db, id)!, {
        mode: 'whitelist',
        remoteCidrs: ['198.51.100.0/24'],
      }),
    ).rejects.toThrow('restart failed');

    expect(getDatabase(db, id)!.network.mode).toBe('loopback');
    expect(await fs.readFile(hbaPath(), 'utf8')).not.toContain('WINPANEL DATABASE NETWORK ACCESS');
  });

  it('reconciles every engine even when one has no server program on disk', async () => {
    const reconfigured: ServiceDefinition[] = [];
    const service = await makePostgresService(
      serviceDouble(async (definition) => {
        reconfigured.push(definition);
        return 'updated';
      }),
    );

    // Only PostgreSQL is staged, so the other two fail to resolve a server.
    await expect(service.reconcileInstalled()).rejects.toThrow(/MariaDB/);
    expect(reconfigured.some((definition) => definition.id === 'winpanel-postgres')).toBe(true);
  });
});

describe('the engine-wide listener', () => {
  it('takes the widest choice any one database made', () => {
    expect(combineDatabaseNetworkPolicies([])).toMatchObject({ mode: 'loopback' });

    expect(
      combineDatabaseNetworkPolicies([
        { mode: 'loopback', remoteCidrs: [] },
        { mode: 'whitelist', remoteCidrs: ['203.0.113.42'] },
        { mode: 'whitelist', remoteCidrs: ['198.51.100.0/24', '203.0.113.42'] },
      ]),
    ).toEqual({ mode: 'whitelist', remoteCidrs: ['203.0.113.42', '198.51.100.0/24'] });

    expect(
      combineDatabaseNetworkPolicies([
        { mode: 'whitelist', remoteCidrs: ['203.0.113.42'] },
        { mode: 'any', remoteCidrs: [] },
      ]),
    ).toEqual({ mode: 'any', remoteCidrs: [] });
  });
});

describe('MariaDB accounts', () => {
  const record = (mode: 'loopback' | 'any' | 'whitelist', remoteCidrs: string[] = []) => ({
    name: 'wp_shop',
    username: 'wp_shop',
    network: { mode, remoteCidrs },
  });

  it('scopes the account to the addresses the owner listed', () => {
    // A netmask rather than a wildcard: the server itself refuses the login
    // from anywhere else, so a neighbour opening the port changes nothing.
    expect(mariaDbRemoteHosts({ mode: 'whitelist', remoteCidrs: ['203.0.113.42'] })).toEqual([
      '203.0.113.42',
    ]);
    expect(mariaDbRemoteHosts({ mode: 'whitelist', remoteCidrs: ['203.0.113.0/24'] })).toEqual([
      '203.0.113.0/255.255.255.0',
    ]);
    expect(mariaDbRemoteHosts({ mode: 'any', remoteCidrs: [] })).toEqual(['%']);
    expect(mariaDbRemoteHosts({ mode: 'loopback', remoteCidrs: [] })).toEqual([]);
    // The listener is IPv4, so an account there could never be used.
    expect(mariaDbRemoteHosts({ mode: 'whitelist', remoteCidrs: ['2001:db8::1'] })).toEqual([]);
  });

  it('drops a host that is no longer allowed and keeps loopback', () => {
    const statements = mariaDbAccountPlan(record('whitelist', ['203.0.113.42']), 'pw', [
      '127.0.0.1',
      '198.51.100.9',
    ]);

    expect(statements).toContain("DROP USER IF EXISTS 'wp_shop'@'198.51.100.9'");
    expect(statements.some((line) => line.includes("'wp_shop'@'127.0.0.1'"))).toBe(false);
    expect(statements).toContain("GRANT ALL PRIVILEGES ON `wp_shop`.* TO 'wp_shop'@'203.0.113.42'");
  });

  it('removes every remote host when the owner goes back to loopback', () => {
    expect(mariaDbAccountPlan(record('loopback'), 'pw', ['127.0.0.1', '%'])).toEqual([
      "DROP USER IF EXISTS 'wp_shop'@'%'",
    ]);
  });
});

describe('MongoDB logins', () => {
  it('restricts a login to its own sources once the port is open', () => {
    expect(mongoAuthRestrictions({ mode: 'whitelist', remoteCidrs: ['203.0.113.42'] }, true)).toEqual(
      [{ clientSource: ['127.0.0.1', '::1', '203.0.113.42'] }],
    );

    // A database that asked for nothing is pinned to this machine, so a
    // neighbour opening the port does not expose it.
    expect(mongoAuthRestrictions({ mode: 'loopback', remoteCidrs: [] }, true)).toEqual([
      { clientSource: ['127.0.0.1', '::1'] },
    ]);

    expect(mongoAuthRestrictions({ mode: 'any', remoteCidrs: [] }, true)).toEqual([]);
    // Port shut: a restriction left behind would outlive its reason.
    expect(mongoAuthRestrictions({ mode: 'loopback', remoteCidrs: [] }, false)).toEqual([]);
  });
});

describe('the stored policy', () => {
  it('survives a round trip through the record', () => {
    const id = givePostgresDatabase('u_freya_shop');
    setDatabaseNetwork(db, id, { mode: 'whitelist', remoteCidrs: ['203.0.113.0/24'] });

    expect(getDatabase(db, id)!.network).toEqual({
      mode: 'whitelist',
      remoteCidrs: ['203.0.113.0/24'],
    });
  });
});
