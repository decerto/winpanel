import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { gameServerPorts, gameServers } from '../src/db/schema.js';
import { GameServerService } from '../src/game-servers/game-server-service.js';
import { createInstallGameServerHandler, heapMegabytes } from '../src/game-servers/install-handler.js';
import { GameServerCatalogue } from '../src/game-servers/catalogue-loader.js';
import type { ServiceManager } from '../src/windows/service-manager.js';
import { SecretVault } from '../src/security/vault.js';
import { writeSecret, readSecret } from '../src/security/secret-store.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const CATALOGUE = path.join(import.meta.dirname, '..', '..', '..', 'game-servers', 'catalogue');

let tmpDir: string;
let handle: DatabaseHandle;
let service: GameServerService;
let vault: SecretVault;
let catalogue: GameServerCatalogue;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-game-install-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  catalogue = await GameServerCatalogue.load(CATALOGUE, path.join(tmpDir, 'catalogue-data'));
  service = new GameServerService(handle, path.join(tmpDir, 'servers'), catalogue);
  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  vi.restoreAllMocks();
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('JVM heap sizing', () => {
  // The numbers come from the catalog, not the code, so the test reads them
  // from the entry that declares them.
  const heapOf = (id: string) => {
    const heap = catalogue.find(id)?.heap;
    if (!heap) throw new Error(`${id} declares no heap`);
    return heap;
  };

  it('caps a dedicated machine at the configured maximum', () => {
    expect(heapMegabytes(16 * 1024 ** 3, heapOf('zomboid-dedicated'))).toBe(4096);
  });

  it('scales down a mid-range machine', () => {
    // 4 GB free, 1.5 GB reserved for Windows => 2.5 GB heap.
    expect(heapMegabytes(4 * 1024 ** 3, heapOf('zomboid-dedicated'))).toBe(2560);
  });

  it('never drops below the configured floor, even on a tiny VM', () => {
    expect(heapMegabytes(2 * 1024 ** 3, heapOf('zomboid-dedicated'))).toBe(1024);
    expect(heapMegabytes(512 * 1024 ** 2, heapOf('zomboid-dedicated'))).toBe(1024);
  });
});

describe('Minecraft Java installation', () => {
  it('verifies Mojang metadata, writes the EULA and uses the allocated port', async () => {
    const server = await service.create(
      { displayName: 'Java', catalogId: 'minecraft-java-vanilla', eulaAccepted: true },
      null,
    );
    const jar = Buffer.from('minecraft-server-fixture');
    const sha1 = crypto.createHash('sha1').update(jar).digest('hex');

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('version_manifest_v2')) {
        return new Response(
          JSON.stringify({
            latest: { release: '1.21.1' },
            versions: [{ id: '1.21.1', url: 'https://fixture/version.json' }],
          }),
          { status: 200 },
        );
      }
      if (url === 'https://fixture/version.json') {
        return new Response(JSON.stringify({ downloads: { server: { url: 'https://fixture/server.jar', sha1 } } }), {
          status: 200,
        });
      }
      return new Response(jar, { status: 200 });
    }));

    const handler = createInstallGameServerHandler({ db: handle, catalogue, runJava: async () => true });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    const updated = service.get(server.slug);
    expect(updated?.state).toBe('stopped');
    expect(updated?.version).toBe('1.21.1');
    expect(await fs.readFile(path.join(server.installPath, 'server.jar'))).toEqual(jar);
    expect(await fs.readFile(path.join(server.dataPath, 'eula.txt'), 'utf8')).toContain('eula=true');
    expect(await fs.readFile(path.join(server.dataPath, 'server.properties'), 'utf8')).toContain(
      `server-port=${25565}`,
    );
  });

  it('registers a stopped WinSW service for the installed JAR', async () => {
    const server = await service.create(
      { displayName: 'Service Java', catalogId: 'minecraft-java-vanilla', eulaAccepted: true },
      null,
    );
    const jar = Buffer.from('minecraft-server-service-fixture');
    const sha1 = crypto.createHash('sha1').update(jar).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('version_manifest_v2')) {
        return new Response(JSON.stringify({ latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', url: 'https://fixture/version.json' }] }), { status: 200 });
      }
      if (url.endsWith('version.json')) {
        return new Response(JSON.stringify({ downloads: { server: { url: 'https://fixture/server.jar', sha1 } } }), { status: 200 });
      }
      return new Response(jar, { status: 200 });
    }));

    const installed: Array<{ id: string; executable: string; args?: readonly string[]; workingDirectory?: string }> = [];
    const services = {
      isInstalled: async () => false,
      install: async (definition: (typeof installed)[number]) => installed.push(definition),
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      services,
      runJava: async () => true,
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe(`winpanel-game-${server.slug}`);
    expect(installed[0]?.executable).toBe('java.exe');
    expect(installed[0]?.args).toEqual(['-jar', path.join(server.installPath, 'server.jar'), 'nogui']);
    expect(installed[0]?.workingDirectory).toBe(server.dataPath);
  });

  it('passes only the catalog Steam App ID to SteamCMD', async () => {
    const server = await service.create(
      { displayName: 'Palworld', catalogId: 'palworld-dedicated', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'PalServer.exe'), 'fixture');

    const commands: Array<{ exe: string; args: readonly string[] }> = [];
    const installed: Array<{ id: string; executable: string; args?: readonly string[] }> = [];
    const services = {
      isInstalled: async () => false,
      install: async (definition: (typeof installed)[number]) => installed.push(definition),
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      runCommand: async (options) => {
        commands.push({ exe: options.exe, args: options.args });
        return {
          exitCode: 0,
          stdout: 'Success! App 2394010 fully installed.',
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual([
      '+force_install_dir', server.installPath,
      '+login', 'anonymous',
      '+app_update', '2394010', 'validate',
      '+quit',
    ]);
    expect(installed[0]?.executable).toContain('PalServer.exe');
    expect(installed[0]?.args).toEqual(['-port=8211']);
  });

  it('pulls the selected Steam branch on install and update', async () => {
    const server = await service.create(
      { displayName: 'Branchy', catalogId: 'zomboid-dedicated', eulaAccepted: true },
      null,
    );
    // The user picked the branch in the panel; the handler must honor it.
    handle.db.update(gameServers).set({ branch: 'legacy41' })
      .where(eq(gameServers.id, server.id)).run();
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    await fs.mkdir(path.join(server.installPath, 'jre64', 'bin'), { recursive: true });
    await fs.writeFile(path.join(server.installPath, 'jre64', 'bin', 'java.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'StartServer64.bat'), 'fixture');
    await fs.mkdir(path.join(server.installPath, 'java'), { recursive: true });
    await fs.writeFile(path.join(server.installPath, 'java', 'zombie.jar'), 'fixture');

    const commands: Array<{ args: readonly string[] }> = [];
    const services = {
      isInstalled: async () => false,
      install: async () => undefined,
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      vault,
      runCommand: async (options) => {
        commands.push({ args: options.args });
        return {
          exitCode: 0,
          stdout: "Success! App '380870' fully installed.",
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    expect(commands[0]?.args).toEqual([
      '+force_install_dir', server.installPath,
      '+login', 'anonymous',
      '+app_update', '380870', '-beta', 'legacy41', 'validate',
      '+quit',
    ]);
  });

  it('stops a running server, updates its files, and starts it again', async () => {
    const server = await service.create(
      { displayName: 'Palworld Live', catalogId: 'palworld-dedicated', eulaAccepted: true },
      null,
    );
    // Installed and running, the state the update button was pressed from.
    handle.db.update(gameServers).set({
      serviceId: 'winpanel-game-live',
      state: 'running',
    }).where(eq(gameServers.id, server.id)).run();
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'PalServer.exe'), 'fixture');

    const calls: string[] = [];
    const services = {
      isInstalled: async () => true,
      install: async () => undefined,
      reconfigure: async () => 'unchanged' as const,
      stop: async () => calls.push('stop'),
      start: async () => calls.push('start'),
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      runCommand: async () => ({
        exitCode: 0,
        stdout: "Success! App '2394010' fully installed.",
        stderr: '',
        timedOut: false,
        durationMs: 1,
        truncated: false,
      }),
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id, update: true }, context);

    expect(calls).toEqual(['stop', 'start']);
    expect(service.get(server.slug)?.state).toBe('running');
  });

  it('explains a Steam Guard stop instead of leaving the job hanging', async () => {
    const server = await service.create(
      { displayName: 'Nomad Guard', catalogId: 'nomad-dedicated', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    writeSecret(handle, vault, 'gameServers.steam.username', 'guarded-account');
    writeSecret(handle, vault, 'gameServers.steam.password', 'fixture-password');

    const logged: string[] = [];
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      vault,
      runCommand: async (options) => {
        options.onOutput?.('This account is protected by a Steam Guard mobile authenticator.', 'stdout');
        options.onOutput?.('Waiting for confirmation...', 'stdout');
        return {
          exitCode: 1,
          stdout: 'This account is protected by a Steam Guard mobile authenticator.\nWaiting for confirmation...',
          stderr: '',
          timedOut: true,
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: (message: string) => logged.push(message),
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await expect(handler({ gameServerId: server.id }, context)).rejects.toThrow(/Steam Guard/);
    expect(logged.some((line) => line.includes('Steam mobile app'))).toBe(true);
  });

  /*
   * The person watching this install is renting a server, not running one.
   * The account signing in to Steam belongs to whoever owns the panel, and it
   * is the same account for every customer on the machine — so it appears in
   * neither the log they can read nor the error they are shown.
   */
  it('keeps the operator\'s Steam account out of a log the customer can read', async () => {
    const server = await service.create(
      { displayName: 'Nomad Private', catalogId: 'nomad-dedicated', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    writeSecret(handle, vault, 'gameServers.steam.username', 'winpanel_host');
    writeSecret(handle, vault, 'gameServers.steam.password', 'operator-password');

    const logged: string[] = [];
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      vault,
      runCommand: async (options) => {
        options.onOutput?.("Logging in user 'winpanel_host' to Steam Public...", 'stdout');
        options.onOutput?.('winpanel_host logged in OK', 'stdout');
        const output =
          "Logging in user 'winpanel_host' to Steam Public...\n" +
          "ERROR! Failed to install app '378370' (No subscription) for user 'winpanel_host'";
        return {
          exitCode: 1,
          stdout: output,
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: (message: string) => logged.push(message),
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    const failure = await handler({ gameServerId: server.id }, context).catch((error: Error) => error);

    const everything = [...logged, (failure as Error).message].join('\n');
    expect(everything).not.toMatch(/winpanel_host/i);
    expect(everything).not.toContain('operator-password');
    // Still says what went wrong, which is the whole point of showing a log.
    expect(everything).toContain('No subscription');
  });

  it('expands Nomad launch arguments from its batch-file contract', async () => {
    const server = await service.create(
      { displayName: 'Nomad', catalogId: 'nomad-dedicated', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'Nomad.exe'), 'fixture');
    writeSecret(handle, vault, 'gameServers.steam.username', 'owned-account');
    writeSecret(handle, vault, 'gameServers.steam.password', 'fixture-password');

    const installed: Array<{ executable: string; args?: readonly string[] }> = [];
    const services = {
      isInstalled: async () => false,
      install: async (definition: (typeof installed)[number]) => installed.push(definition),
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      vault,
      runCommand: async () => ({
        exitCode: 0,
        stdout: 'Nomad fixture installed',
        stderr: '',
        timedOut: false,
        durationMs: 1,
        truncated: false,
      }),
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    const gamePort = handle.db
      .select({ port: gameServerPorts.port })
      .from(gameServerPorts)
      .all()[0]?.port;
    expect(installed[0]?.args).toEqual([
      '-port', String(gamePort),
      '-batchmode',
      '-nographics',
    ]);
    const configPath = path.join(server.installPath, 'Nomad Server', 'Config', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      serverPort: number;
      maxPlayers: number;
      Bots: number;
      serverName: string;
    };
    expect(config).toMatchObject({ serverPort: gamePort, maxPlayers: 30, Bots: 20, serverName: 'Nomad' });
    expect(handle.db.select().from(gameServerPorts).all()).toHaveLength(1);
  });

  it('installs a game the panel has never heard of, from a config file alone', async () => {
    // The whole promise of the catalog: someone adds JSON for a Steam game and
    // it installs, seeds its settings and registers a service with no code
    // change anywhere. If this test needs a source edit to pass, the promise
    // has been broken.
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'community-game.json'),
      JSON.stringify({
        id: 'community-game',
        provider: 'steam',
        name: 'Community Game',
        description: 'Contributed without touching TypeScript.',
        genre: 'Survival',
        requiresEula: true,
        steamAppId: 999999,
        executable: 'CommunityServer.exe',
        workingDirectory: 'executable',
        secrets: [{ name: 'rcon' }],
        launchArgs: ['-port', '{port:game}', '-rconpassword', '{secret:rcon}'],
        seedFiles: [
          {
            path: 'settings.ini',
            format: 'ini',
            eol: 'crlf',
            values: { Port: '{port:game}', ServerName: '{displayName}', RconPassword: '{secret:rcon}' },
          },
        ],
        ports: [
          { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 27500 },
        ],
      }),
    );
    await catalogue.reload();

    const server = await service.create(
      { displayName: 'Community', catalogId: 'community-game', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    await fs.mkdir(path.join(binDir, 'steamcmd'), { recursive: true });
    await fs.writeFile(path.join(binDir, 'steamcmd', 'steamcmd.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'CommunityServer.exe'), 'fixture');

    const installed: Array<{ executable: string; args?: readonly string[]; workingDirectory?: string }> = [];
    const services = {
      isInstalled: async () => false,
      install: async (definition: (typeof installed)[number]) => installed.push(definition),
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      vault,
      runCommand: async () => ({
        exitCode: 0,
        stdout: "Success! App '999999' fully installed.",
        stderr: '',
        timedOut: false,
        durationMs: 1,
        truncated: false,
      }),
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    const gamePort = handle.db.select().from(gameServerPorts).all()[0]?.port;
    expect(service.get(server.slug)?.state).toBe('stopped');
    expect(installed[0]?.executable).toContain('CommunityServer.exe');
    expect(installed[0]?.workingDirectory).toBe(server.installPath);

    const rcon = readSecret(handle, vault, `game-server:${server.id}:rcon`);
    expect(rcon).toBeTruthy();
    expect(installed[0]?.args).toEqual(['-port', String(gamePort), '-rconpassword', rcon]);

    const ini = await fs.readFile(path.join(server.dataPath, 'settings.ini'), 'utf8');
    expect(ini).toBe(`Port=${gamePort}\r\nServerName=Community\r\nRconPassword=${rcon}\r\n`);
  });

  it('installs Project Zomboid anonymously with its bundled JRE and managed profile', async () => {
    const server = await service.create(
      { displayName: 'PZ', catalogId: 'zomboid-dedicated', eulaAccepted: true },
      null,
    );
    const binDir = path.join(tmpDir, 'bin');
    const steamDir = path.join(binDir, 'steamcmd');
    await fs.mkdir(steamDir, { recursive: true });
    await fs.writeFile(path.join(steamDir, 'steamcmd.exe'), 'fixture');
    await fs.mkdir(path.join(server.installPath, 'jre64', 'bin'), { recursive: true });
    await fs.writeFile(path.join(server.installPath, 'jre64', 'bin', 'java.exe'), 'fixture');
    await fs.writeFile(path.join(server.installPath, 'StartServer64.bat'), 'fixture');
    await fs.mkdir(path.join(server.installPath, 'java'), { recursive: true });
    await fs.writeFile(path.join(server.installPath, 'java', 'zombie.jar'), 'fixture');

    const commands: Array<{ args: readonly string[] }> = [];
    const installed: Array<{ executable: string; args?: readonly string[]; workingDirectory?: string }> = [];
    const services = {
      isInstalled: async () => false,
      install: async (definition: (typeof installed)[number]) => installed.push(definition),
      reconfigure: async () => 'unchanged' as const,
    } as unknown as ServiceManager;
    const handler = createInstallGameServerHandler({
      db: handle,
      catalogue,
      binDir,
      services,
      vault,
      freeMemoryBytes: () => 4 * 1024 ** 3,
      runCommand: async (options) => {
        commands.push({ args: options.args });
        return {
          exitCode: 0,
          stdout: "Success! App '380870' fully installed.",
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const context = {
      jobId: crypto.randomUUID(),
      log: () => undefined,
      progress: () => undefined,
      isCancelled: () => false,
      throwIfCancelled: () => undefined,
    };

    await handler({ gameServerId: server.id }, context);

    expect(commands[0]?.args).toEqual([
      '+force_install_dir', server.installPath,
      '+login', 'anonymous',
      '+app_update', '380870', 'validate',
      '+quit',
    ]);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.executable).toContain(path.join('jre64', 'bin', 'java.exe'));
    expect(installed[0]?.args).toContain('-servername');
    expect(installed[0]?.args).toContain(server.slug);
    expect(installed[0]?.args?.some((arg) => arg === 'zombie.network.GameServer')).toBe(true);
    expect(installed[0]?.args?.some((arg) => String(arg).includes('java/zombie.jar'))).toBe(true);
    expect(installed[0]?.args).toContain('-Xms2560m');
    expect(installed[0]?.args).toContain('-Xmx2560m');
    expect(installed[0]?.workingDirectory).toBe(server.installPath);

    const profileDir = path.join(server.installPath, 'zomboid-profile');
    const bindings = handle.db.select().from(gameServerPorts).all();
    const gamePort = bindings.find((binding) => binding.purpose === 'game')?.port;
    const directPort = bindings.find((binding) => binding.purpose === 'query')?.port;
    expect(installed[0]?.args).toContain(`-cachedir=${profileDir}`);
    expect(installed[0]?.args).toContain('-adminpassword');
    expect(installed[0]?.args).toContain(String(gamePort));
    expect(installed[0]?.args).toContain(String(directPort));

    const iniPath = path.join(profileDir, 'Server', `${server.slug}.ini`);
    const ini = await fs.readFile(iniPath, 'utf8');
    expect(ini).toContain(`DefaultPort=${gamePort}`);
    expect(ini).toContain(`UDPPort=${directPort}`);
    expect(ini).toContain('Public=true');
    expect(ini).toContain('PublicName=PZ');
    expect(service.get(server.slug)?.dataPath).toBe(profileDir);
  });
});
