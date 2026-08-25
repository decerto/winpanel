import fs from 'node:fs/promises';
import path from 'node:path';
import { databaseEngineInfo, type DatabaseEngine } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager, ServiceDefinition } from '../windows/service-manager.js';
import { FirewallManager, type FirewallRule } from '../bootstrap/windows-setup.js';
import { findExecutable } from '../components/archive.js';
import { engineBinDir, engineDataDir, ENGINE_SERVER_EXE, ENGINE_SERVICE } from './types.js';
import {
  combineDatabaseNetworkPolicies,
  DATABASE_FIREWALL_ENGINES,
  DEFAULT_DATABASE_NETWORK_POLICY,
  databaseFirewallRemoteIp,
  databaseFirewallRuleName,
  databaseServerArgs,
  includeDatabaseServerAddress,
  isRemoteDatabaseNetworkPolicy,
  normaliseDatabaseNetworkPolicy,
  type DatabaseNetworkPolicy,
} from './network.js';
import { listAllDatabases, setDatabaseNetwork, type DatabaseSummary } from './store.js';
import { syncMariaDbRemoteAccounts } from './mariadb.js';
import { syncMongoAccessRestrictions } from './mongodb.js';

const POSTGRES_SERVICE_ACCOUNT = 'NT AUTHORITY\\NetworkService';
const HBA_START = '# BEGIN WINPANEL DATABASE NETWORK ACCESS';
const HBA_END = '# END WINPANEL DATABASE NETWORK ACCESS';

/** Every database on one engine, which is what its listener has to satisfy. */
export function databasesOnEngine(db: DatabaseHandle, engine: DatabaseEngine): DatabaseSummary[] {
  return listAllDatabases(db).filter((record) => record.engine === engine);
}

/**
 * What one engine's listener and firewall have to be right now.
 *
 * Derived rather than stored: the databases are the only place the choice was
 * ever made, so there is no second copy of it to fall out of step.
 */
export function engineNetworkPolicy(
  db: DatabaseHandle,
  engine: DatabaseEngine,
): DatabaseNetworkPolicy {
  return combineDatabaseNetworkPolicies(
    databasesOnEngine(db, engine).map((record) => record.network),
  );
}

function databaseFirewallRule(
  engine: DatabaseEngine,
  policy: DatabaseNetworkPolicy,
): FirewallRule | null {
  if (!isRemoteDatabaseNetworkPolicy(policy)) return null;

  const info = databaseEngineInfo(engine);
  return {
    name: databaseFirewallRuleName(engine),
    port: info.port,
    protocol: 'TCP',
    action: 'allow',
    remoteIp: databaseFirewallRemoteIp(policy),
    purpose:
      policy.mode === 'any'
        ? `Lets devices reach ${info.label} from any network address.`
        : `Lets only the approved network addresses reach ${info.label}.`,
  };
}

function postgresSource(cidr: string): string {
  if (cidr.includes('/')) return cidr;
  return `${cidr}${cidr.includes(':') ? '/128' : '/32'}`;
}

/**
 * One `host` line per database that asked for remote access, naming that
 * database and that role alone.
 *
 * A blanket `host all all` line would hand every customer's database to
 * whichever source any one of them listed, which is the whole thing this
 * exists to prevent.
 */
function postgresHbaBlock(records: readonly DatabaseSummary[]): string[] {
  const lines = records.flatMap((record) => {
    const sources =
      record.network.mode === 'any'
        ? ['0.0.0.0/0', '::/0']
        : record.network.mode === 'whitelist'
          ? record.network.remoteCidrs.map(postgresSource)
          : [];

    return sources.map((source) => `host ${record.name} ${record.username} ${source} scram-sha-256`);
  });

  return lines.length === 0 ? [] : [HBA_START, ...lines, HBA_END];
}

function stripPostgresHbaBlock(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => line.trim() === HBA_START);
  const end = lines.findIndex((line, index) => index > start && line.trim() === HBA_END);
  if (start < 0 && end < 0) return [...lines];
  if (start < 0 || end < start) throw new Error('PostgreSQL has an incomplete WinPanel access block.');
  return [...lines.slice(0, start), ...lines.slice(end + 1)];
}

async function updatePostgresHba(
  dataDir: string,
  records: readonly DatabaseSummary[],
): Promise<void> {
  const file = path.join(engineDataDir(dataDir, 'postgres'), 'pg_hba.conf');
  const previous = await fs.readFile(file, 'utf8');
  const eol = previous.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingEol = previous.endsWith('\n');
  const content = hadTrailingEol ? previous.slice(0, -eol.length) : previous;

  const lines = stripPostgresHbaBlock(content.split(/\r?\n/));
  const block = postgresHbaBlock(records);
  if (block.length > 0) lines.push('', ...block);

  const next = `${lines.join(eol)}${hadTrailingEol ? eol : ''}`;
  if (next !== previous) await fs.writeFile(file, next, 'utf8');
}

export interface DatabaseNetworkServiceOptions {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
  firewall?: FirewallManager;
  binDir: string;
  dataDir: string;
  logDir: string;
  /** The server address that local applications also use when remote mode is on. */
  panelAddress?: string | null;
}

export class DatabaseNetworkService {
  constructor(private readonly options: DatabaseNetworkServiceOptions) {}

  /** The listener and firewall an engine currently needs. */
  policyFor(engine: DatabaseEngine): DatabaseNetworkPolicy {
    return includeDatabaseServerAddress(
      engineNetworkPolicy(this.options.db, engine),
      this.options.panelAddress ?? null,
    );
  }

  private includePanelAddress(policy: DatabaseNetworkPolicy): DatabaseNetworkPolicy {
    return includeDatabaseServerAddress(policy, this.options.panelAddress ?? null);
  }

  /**
   * Records one database's own choice and brings the machine in line with it.
   *
   * The row is written first and put back on failure, because everything else
   * — the bind address, the firewall rule, the logins — is worked out from the
   * rows rather than tracked separately.
   */
  async setForDatabase(
    record: DatabaseSummary,
    requested: DatabaseNetworkPolicy,
  ): Promise<DatabaseNetworkPolicy> {
    const policy = this.includePanelAddress(
      normaliseDatabaseNetworkPolicy(requested.mode, requested.remoteCidrs),
    );
    const previous = record.network;

    setDatabaseNetwork(this.options.db, record.id, policy);

    try {
      await this.syncEngine(record.engine);
      return policy;
    } catch (error) {
      setDatabaseNetwork(this.options.db, record.id, previous);
      await this.syncEngine(record.engine).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Makes the machine match what the databases on one engine ask for.
   *
   * Order matters. PostgreSQL reads its rules as the server starts, so they are
   * written before the listener is reconfigured; the two engines whose logins
   * are changed over a connection are done afterwards, once it is back up.
   */
  async syncEngine(engine: DatabaseEngine): Promise<void> {
    const records = databasesOnEngine(this.options.db, engine).map((record) => ({
      ...record,
      network: this.includePanelAddress(record.network),
    }));
    const serviceId = ENGINE_SERVICE[engine];
    const installed = await this.options.services.isInstalled(serviceId);

    const wanted = combineDatabaseNetworkPolicies(records.map((record) => record.network));
    const effective = installed ? wanted : { ...DEFAULT_DATABASE_NETWORK_POLICY };
    const remote = isRemoteDatabaseNetworkPolicy(effective);

    if (installed && engine === 'postgres') {
      await updatePostgresHba(this.options.dataDir, remote ? records : []);
    }

    await this.applyFirewall(engine, effective);
    if (installed) await this.reconfigure(engine, effective);

    if (!installed) return;
    if ((await this.options.services.getState(serviceId)) !== 'running') return;

    const context = { db: this.options.db, vault: this.options.vault, binDir: this.options.binDir };
    if (engine === 'mariadb') await syncMariaDbRemoteAccounts(context, records);
    if (engine === 'mongodb') await syncMongoAccessRestrictions(context, records, remote);
  }

  /** Brings every engine in line, at start-up and after a service changes state. */
  async reconcileInstalled(): Promise<void> {
    const failures: string[] = [];

    for (const engine of DATABASE_FIREWALL_ENGINES) {
      try {
        await this.syncEngine(engine);
      } catch (error) {
        // One engine's leftover service must not strand the other two.
        failures.push(`${databaseEngineInfo(engine).label}: ${(error as Error).message}`);
      }
    }

    if (failures.length > 0) throw new Error(failures.join('; '));
  }

  private async applyFirewall(engine: DatabaseEngine, policy: DatabaseNetworkPolicy): Promise<void> {
    if (!this.options.firewall) return;

    const rule = databaseFirewallRule(engine, policy);
    if (!rule) {
      await this.options.firewall.remove(databaseFirewallRuleName(engine));
      return;
    }

    await this.options.firewall.apply(rule);
  }

  private async reconfigure(engine: DatabaseEngine, policy: DatabaseNetworkPolicy): Promise<void> {
    const executable = await findExecutable(engineBinDir(this.options.binDir, engine), ENGINE_SERVER_EXE[engine]);
    if (!executable) throw new Error(`${databaseEngineInfo(engine).product} server executable was not found.`);

    const definition: ServiceDefinition = {
      id: ENGINE_SERVICE[engine],
      displayName: `WinPanel ${databaseEngineInfo(engine).label}`,
      description: databaseEngineInfo(engine).description,
      executable,
      args: databaseServerArgs(engine, engineDataDir(this.options.dataDir, engine), policy),
      workingDirectory: path.dirname(executable),
      logPath: path.join(this.options.logDir, engine),
      ...(engine === 'postgres'
        ? { account: { username: POSTGRES_SERVICE_ACCOUNT, password: '' } }
        : {}),
    };

    await this.options.services.reconfigure(definition);
  }
}
