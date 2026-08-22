import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFirewallArgs } from '../src/bootstrap/windows-setup.js';
import { gameServerFirewallRules } from '../src/game-servers/firewall.js';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { GameServerService } from '../src/game-servers/game-server-service.js';
import { loadGameServerCatalogue } from '../src/game-servers/catalogue-loader.js';
import { canInstallServer } from '../src/api/routers/game-servers.js';
import type { RequestContext } from '../src/api/trpc.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const CATALOGUE = path.join(import.meta.dirname, '..', '..', '..', 'game-servers', 'catalogue');
let tmpDir: string;
let handle: DatabaseHandle;
let catalogue: Awaited<ReturnType<typeof loadGameServerCatalogue>>['entries'];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-game-security-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  catalogue = (await loadGameServerCatalogue(CATALOGUE, path.join(tmpDir, 'catalogue-data'))).entries;
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('game-server catalogue safety', () => {
  it('uses a fixed Steam App ID and executable for Palworld', async () => {
    const entry = catalogue.find((item) => item.id === 'palworld-dedicated');
    expect(entry?.steamAppId).toBe(2394010);
    expect(entry?.executable).toBe('PalServer.exe');
    expect(entry?.ports.map((port) => [port.protocol, port.port])).toEqual([
      ['udp', 8211],
      ['udp', 27015],
      ['tcp', 25575],
    ]);
  });

  it('does not let a customer trigger an ownership-gated Steam install', async () => {
    const service = new GameServerService(handle, path.join(tmpDir, 'servers'), catalogue);
    const nomad = await service.create(
      { displayName: 'Nomad', catalogId: 'nomad-dedicated', eulaAccepted: true },
      null,
    );
    const minecraft = await service.create(
      { displayName: 'Minecraft', catalogId: 'minecraft-java-vanilla', eulaAccepted: true },
      null,
    );
    const customer = { user: { role: 'user' }, app: { gameServers: service } } as RequestContext;
    const administrator = { user: { role: 'admin' }, app: { gameServers: service } } as RequestContext;

    expect(canInstallServer(customer, nomad)).toBe(false);
    expect(canInstallServer(customer, minecraft)).toBe(true);
    expect(canInstallServer(administrator, nomad)).toBe(true);
  });
});

describe('game-server firewall rules', () => {
  it('opens public bindings and leaves loopback bindings private', () => {
    const rules = gameServerFirewallRules('palworld', [
      { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 8211 },
      { name: 'rcon', protocol: 'tcp', purpose: 'rcon', visibility: 'loopback', port: 25575 },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ protocol: 'UDP', port: 8211, action: 'allow' });
    expect(buildFirewallArgs(rules[0]!)).toContain('localport=8211');
    expect(rules[0]?.name).toContain('palworld');
  });
});

describe('game-server deletion', () => {
  it('removes the instance directory and database row', async () => {
    const service = new GameServerService(handle, path.join(tmpDir, 'servers'), catalogue);
    const server = await service.create(
      { displayName: 'Disposable', catalogId: 'minecraft-java-vanilla', eulaAccepted: true },
      null,
    );

    await fs.writeFile(path.join(server.dataPath, 'world.txt'), 'data');
    await service.remove(server.slug);

    expect(service.get(server.slug)).toBeUndefined();
    await expect(fs.access(path.dirname(server.installPath))).rejects.toThrow();
  });
});
