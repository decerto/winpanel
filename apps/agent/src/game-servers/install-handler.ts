import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { JobContext } from '../jobs/queue.js';
import type { DatabaseHandle } from '../db/index.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { gameServerPorts, gameServers } from '../db/schema.js';
import { replaceFile } from '../files/replace-file.js';
import { runCommand } from '../process/run-command.js';
import { downloadVerified } from '../components/download.js';
import { extractZip, findExecutable } from '../components/archive.js';
import { FirewallManager } from '../bootstrap/windows-setup.js';
import { applyGameServerFirewall } from './firewall.js';
import type { GameServerCatalogEntry } from '@winpanel/shared';
import type { SecretVault } from '../security/vault.js';
import { readSecret, writeSecret } from '../security/secret-store.js';

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

interface MinecraftManifest {
  latest?: { release?: string };
  versions?: Array<{ id?: string; type?: string; url?: string }>;
}

interface MinecraftVersionManifest {
  downloads?: { server?: { url?: string; sha1?: string } };
}

export interface InstallGameServerPayload {
  gameServerId: string;
  reinstall?: boolean;
  /** Set for the update job, which stops a running server first and restarts it after. */
  update?: boolean;
}

export interface GameServerInstallDependencies {
  db: DatabaseHandle;
  binDir?: string;
  services?: ServiceManager;
  firewall?: FirewallManager;
  vault?: SecretVault;
  catalogue: readonly GameServerCatalogEntry[];
  runCommand?: typeof runCommand;
  /** Injectable for tests; production checks the host's Java runtime. */
  runJava?: () => Promise<boolean>;
  /** Injectable for tests; production reads the host's free memory. */
  freeMemoryBytes?: () => number;
}

function catalogEntry(
  catalogue: readonly GameServerCatalogEntry[],
  id: string,
): GameServerCatalogEntry | undefined {
  return catalogue.find((entry) => entry.id === id);
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`The provider metadata could not be downloaded (${response.status}).`);
  return (await response.json()) as T;
}

async function downloadSha1(url: string, destination: string, expectedSha1: string, ctx: JobContext): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`The game server download failed (${response.status}).`);
  if (!response.body) throw new Error('The game server download returned no content.');

  const temporary = `${destination}.part-${crypto.randomBytes(6).toString('hex')}`;
  const hash = crypto.createHash('sha1');
  let received = 0;
  const source = Readable.fromWeb(response.body as never);
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        callback(new Error('The game server download is too large.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(source, hashing, createWriteStream(temporary));
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== expectedSha1.toLowerCase()) {
      throw new Error('The downloaded game server did not match Mojang\'s published fingerprint.');
    }
    await replaceFile(temporary, destination);
    ctx.log(`Downloaded and verified ${path.basename(destination)}.`);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** Adds or replaces a flat key=value entry without disturbing other settings. */
export function setMinecraftProperty(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  return `${next.filter((line, index) => line !== '' || index < next.length - 1).join('\n').replace(/\n*$/, '')}\n`;
}

async function installMinecraftJava(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  ctx: JobContext,
): Promise<void> {
  const manifest = await fetchJson<MinecraftManifest>(VERSION_MANIFEST_URL);
  const wanted = server.version ?? manifest.latest?.release;
  const version = manifest.versions?.find((entry) => entry.id === wanted);
  if (!version?.url) throw new Error(`Minecraft Java version "${wanted ?? 'latest'}" is not available.`);

  const versionManifest = await fetchJson<MinecraftVersionManifest>(version.url);
  const download = versionManifest.downloads?.server;
  const url = assertString(download?.url, 'That Minecraft version has no server download.');
  const sha1 = assertString(download?.sha1, 'That Minecraft version has no published fingerprint.');

  await fs.mkdir(server.installPath, { recursive: true });
  await fs.mkdir(server.dataPath, { recursive: true });
  ctx.progress(15);
  ctx.log(`Preparing Minecraft Java ${version.id}.`);

  await downloadSha1(url, path.join(server.installPath, 'server.jar'), sha1, ctx);
  ctx.throwIfCancelled();

  const eulaPath = path.join(server.dataPath, 'eula.txt');
  await fs.writeFile(eulaPath, '# Accepted through WinPanel\neula=true\n', 'utf8');

  const port = deps.db.db
    .select({ port: gameServerPorts.port })
    .from(gameServerPorts)
    .where(eq(gameServerPorts.gameServerId, server.id))
    .get()?.port;
  if (!port) throw new Error('The Minecraft server does not have a game port allocated.');

  const propertiesPath = path.join(server.dataPath, 'server.properties');
  const existing = await fs.readFile(propertiesPath, 'utf8').catch(() => '');
  await fs.writeFile(propertiesPath, setMinecraftProperty(existing, 'server-port', String(port)), 'utf8');

  if (deps.vault) {
    const rconPort = (await publicPorts(deps, server.id)).find((binding) => binding.purpose === 'rcon')?.port;
    if (rconPort) {
      const rconPassword = crypto.randomBytes(24).toString('base64url');
      writeSecret(deps.db, deps.vault, `game-server:${server.id}:rcon`, rconPassword);
      let configured = setMinecraftProperty(existing, 'server-port', String(port));
      configured = setMinecraftProperty(configured, 'enable-rcon', 'true');
      configured = setMinecraftProperty(configured, 'rcon.port', String(rconPort));
      configured = setMinecraftProperty(configured, 'rcon.password', rconPassword);
      await fs.writeFile(propertiesPath, configured, 'utf8');
    }
  }

  const javaExecutable = deps.binDir
    ? await findExecutable(path.join(deps.binDir, 'java'), ['java.exe'])
    : null;
  const javaExe = javaExecutable ?? 'java.exe';
  const javaWorks = deps.runJava
    ? await deps.runJava()
    : (await (deps.runCommand ?? runCommand)({ exe: javaExe, args: ['-version'], timeoutMs: 10_000 })).exitCode === 0;
  if (!javaWorks) {
    throw new Error('Minecraft Java was downloaded, but no working Java runtime was found.');
  }

  const serviceId = server.serviceId ?? `winpanel-game-${server.slug}`;
  if (deps.services && !(await deps.services.isInstalled(serviceId))) {
    await deps.services.install({
      id: serviceId,
      displayName: `WinPanel ${server.displayName}`,
      description: 'Minecraft Java game server managed by WinPanel.',
      executable: javaExe,
      args: ['-jar', path.join(server.installPath, 'server.jar'), 'nogui'],
      workingDirectory: server.dataPath,
      logPath: path.join(server.dataPath, 'logs'),
    });
    ctx.log('Registered the Windows service. The server is stopped until you start it.');
  }

  deps.db.db
    .update(gameServers)
    .set({ version: version.id, serviceId, state: 'stopped', updatedAt: new Date() })
    .where(eq(gameServers.id, server.id))
    .run();
  if (deps.firewall) {
    await applyGameServerFirewall(deps.firewall, server.slug, await publicPorts(deps, server.id));
    ctx.log('Applied the Windows Firewall rule for the public game port.');
  }
  ctx.progress(100);
  ctx.log(`Minecraft Java ${version.id} is installed and stopped. It is ready to start.`);
}

async function publicPorts(deps: GameServerInstallDependencies, serverId: string) {
  return deps.db.db
    .select()
    .from(gameServerPorts)
    .where(eq(gameServerPorts.gameServerId, serverId))
    .all();
}

async function registerService(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  executable: string,
  args: readonly string[],
  workingDirectory: string,
  ctx: JobContext,
): Promise<string> {
  const serviceId = server.serviceId ?? `winpanel-game-${server.slug}`;
  if (deps.services && !(await deps.services.isInstalled(serviceId))) {
    await deps.services.install({
      id: serviceId,
      displayName: `WinPanel ${server.displayName}`,
      description: `${catalogEntry(deps.catalogue, server.catalogId)?.name ?? 'Game'} managed by WinPanel.`,
      executable,
      args,
      workingDirectory,
      logPath: path.join(server.dataPath, 'logs'),
    });
    ctx.log('Registered the Windows service. The server is stopped until you start it.');
  }

  if (deps.firewall) {
    await applyGameServerFirewall(deps.firewall, server.slug, await publicPorts(deps, server.id));
    ctx.log('Applied the Windows Firewall rules for the public game ports.');
  }

  return serviceId;
}

async function installBedrock(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  ctx: JobContext,
): Promise<void> {
  const entry = catalogEntry(deps.catalogue, server.catalogId);
  if (!entry?.downloadUrl) throw new Error('This Bedrock provider has no official download configured.');

  const archivePath = path.join(server.installPath, '.bedrock-download.zip');
  await fs.mkdir(server.installPath, { recursive: true });
  await fs.mkdir(server.dataPath, { recursive: true });
  ctx.log('Downloading the official Minecraft Bedrock Dedicated Server.');
  const download = await downloadVerified({
    url: entry.downloadUrl,
    destination: archivePath,
    sha256: entry.downloadSha256 ?? null,
    timeoutMs: 15 * 60 * 1000,
    onProgress: (received, total) => {
      if (total) ctx.progress(10 + Math.min(55, Math.round((received / total) * 55)));
    },
  });
  if (!download.verified) {
    ctx.log('The official Bedrock archive has no stable publisher hash; executable discovery will still be checked.', 'warn');
  }
  await extractZip(archivePath, server.installPath);
  await fs.rm(archivePath, { force: true });

  const executable = await findExecutable(server.installPath, [entry.executable]);
  if (!executable) throw new Error('The Bedrock download did not contain bedrock_server.exe.');

  const properties = path.join(server.installPath, 'server.properties');
  const existing = await fs.readFile(properties, 'utf8').catch(() => '');
  const port = (await publicPorts(deps, server.id)).find((binding) => binding.purpose === 'game')?.port;
  await fs.writeFile(properties, setMinecraftProperty(existing, 'server-port', String(port ?? 19132)), 'utf8');

  const serviceId = await registerService(deps, server, executable, entry.launchArgs, server.installPath, ctx);
  deps.db.db.update(gameServers).set({ serviceId, state: 'stopped', updatedAt: new Date() }).where(eq(gameServers.id, server.id)).run();
  ctx.progress(100);
  ctx.log('Minecraft Bedrock is installed and stopped. It is ready to start.');
}

async function installSteam(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  ctx: JobContext,
): Promise<void> {
  const entry = catalogEntry(deps.catalogue, server.catalogId);
  if (!entry?.steamAppId) throw new Error('This Steam provider has no dedicated-server App ID.');
  if (!deps.binDir) throw new Error('SteamCMD is not configured on this server.');

  const steamcmd = path.join(deps.binDir, 'steamcmd', 'steamcmd.exe');
  if (!(await fs.access(steamcmd).then(() => true, () => false))) {
    throw new Error('SteamCMD is not installed. Install it from Settings before installing this server.');
  }

  await fs.mkdir(server.installPath, { recursive: true });
  ctx.log(`Downloading Steam app ${entry.steamAppId} through SteamCMD.`);
  const steamUsername = deps.vault ? readSecret(deps.db, deps.vault, 'gameServers.steam.username') : null;
  const steamPassword = deps.vault ? readSecret(deps.db, deps.vault, 'gameServers.steam.password') : null;
  if (entry.steamRequiresOwnership && (!steamUsername || !steamPassword)) {
    throw new Error(
      `${entry.name} requires a Steam account that owns the game. ` +
        'Configure the Steam account in Settings before installing it; anonymous SteamCMD downloads are not available for this app.',
    );
  }
  const login = steamUsername && steamPassword
    ? ['+login', steamUsername, steamPassword]
    : ['+login', 'anonymous'];
  if (steamUsername) {
    ctx.log(`Signing in to Steam as ${steamUsername}. If the account uses Steam Guard, approve the sign-in in the Steam mobile app when it appears.`);
  }
  // A selected beta branch rides the same app_update command, so "update"
  // and "install" are one code path that always pulls the latest build of
  // whatever branch the server is on.
  const branch = server.branch?.trim();
  const branchArgs = branch ? ['-beta', branch] : [];
  if (branch) ctx.log(`Using the "${branch}" Steam branch.`);
  let guardPromptSeen = false;
  const result = await (deps.runCommand ?? runCommand)({
    exe: steamcmd,
    cwd: path.dirname(steamcmd),
    args: [
      '+force_install_dir', server.installPath,
      ...login,
      '+app_update', String(entry.steamAppId), ...branchArgs, 'validate',
      '+quit',
    ],
    timeoutMs: 60 * 60 * 1000,
    onOutput: (line) => {
      if (/error|failed/i.test(line)) ctx.log(line, 'warn');
      else if (line.trim()) ctx.log(line);

      if (!guardPromptSeen && /steam guard|verification code|waiting for confirmation|confirm the login/i.test(line)) {
        guardPromptSeen = true;
        ctx.log(
          'This account uses Steam Guard. Approve this sign-in in the Steam mobile app on your phone; ' +
            'this install continues as soon as Steam confirms it.',
          'warn',
        );
      }
    },
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || /no subscription|failed to install app/i.test(combinedOutput)) {
    if (result.timedOut || /steam guard|verification code|waiting for confirmation/i.test(combinedOutput)) {
      throw new Error(
        'Steam Guard stopped the sign-in before the download could start. ' +
          'Approve the login in the Steam mobile app and press Install again. ' +
          'If Steam asks for a typed code instead of mobile approval, sign in once on the server itself ' +
          'by running steamcmd.exe in the WinPanel bin folder — after that, installs continue without prompting.',
      );
    }
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ');
    const ownership = /no subscription/i.test(combinedOutput)
      ? ` Steam declined App ${entry.steamAppId}; the configured Steam account must own ${entry.name}.`
      : '';
    throw new Error(`SteamCMD could not install the dedicated-server files.${ownership}${detail ? ` ${detail}` : ''}`);
  }
  ctx.progress(70);

  const executable = await findExecutable(server.installPath, [entry.executable]);
  if (!executable) throw new Error(`SteamCMD completed, but ${entry.executable} was not found.`);
  const gamePort = (await publicPorts(deps, server.id)).find((binding) => binding.purpose === 'game')?.port;
  const resolvedPort = String(gamePort ?? 8211);
  let args = entry.launchArgs.map((argument) => argument.replaceAll('{gamePort}', resolvedPort));
  if (!entry.launchArgs.some((argument) => argument.includes('{gamePort}'))) {
    args.push('-port', resolvedPort);
  }
  let managedServer = server;
  if (entry.dataDirectory && entry.id === 'nomad-dedicated') {
    // Nomad creates this tree on first launch. Create it before registering
    // the service so the Files view has a stable root immediately after the
    // Steam download, and so the first launch receives the allocated port.
    const providerData =
      (await findDirectory(server.installPath, entry.dataDirectory)) ??
      path.join(server.installPath, entry.dataDirectory);
    await fs.mkdir(path.join(providerData, 'Config'), { recursive: true });
    const configPath = path.join(providerData, 'Config', 'config.json');
    if (!(await fs.access(configPath).then(() => true, () => false))) {
      const config = {
        serverPort: Number(resolvedPort),
        maxPlayers: 30,
        password: '',
        serverName: 'Nomad Server',
        maxPing: 1000,
        motdTimer: 300,
        kits: false,
        RegularLoot: 150,
        MediumLoot: 40,
        HighLoot: 30,
        IndustrialLoot: 30,
        HealthLoot: 30,
        FoodLoot: 150,
        FireLoot: 30,
        SupplyDropTimer: 5400,
        MiningNodes: 200,
        BarrelSpawns: 80,
        PalletSpawns: 50,
        Zombies: 60,
        Deers: 40,
        Bots: 20,
      };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      ctx.log(`Created ${path.join(entry.dataDirectory, 'Config', 'config.json')}.`);
    }
    managedServer = { ...server, dataPath: providerData };
    ctx.log(`Using ${path.join(entry.dataDirectory, 'Config', 'config.json')} as the server data workspace.`);
  }
  const serviceId = await registerService(deps, managedServer, executable, args, path.dirname(executable), ctx);
  deps.db.db.update(gameServers).set({ dataPath: managedServer.dataPath, serviceId, state: 'stopped', updatedAt: new Date() }).where(eq(gameServers.id, server.id)).run();
  ctx.progress(100);
  ctx.log(`${entry.name} is installed and stopped. It is ready to start.`);
}

/**
 * Project Zomboid's Steam download includes the launcher batch files and the
 * bundled JRE, but the real server process is `jre64/bin/java.exe` against
 * the bundled jar set. The batch file's admin-password prompt happens on the
 * console, which nobody can answer through WinSW — so the first run supplies
 * it on stdin instead.
 */
async function zomboidClasspath(installPath: string): Promise<string> {
  const javaDir = path.join(installPath, 'java');
  const jars = (await fs.readdir(javaDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .map((entry) => path.posix.join('java', entry.name))
    .sort();
  if (jars.length === 0) {
    throw new Error(
      'The Project Zomboid download did not contain its java/*.jar libraries, so the server cannot start.',
    );
  }
  return jars.join(';');
}

async function seedZomboidProfile(
  server: typeof gameServers.$inferSelect,
  gamePort: number,
  ctx: JobContext,
): Promise<string> {
  const profileDir = path.join(server.installPath, 'zomboid-profile');
  await fs.mkdir(profileDir, { recursive: true });

  const iniPath = path.join(profileDir, `${server.slug}.ini`);
  if (!(await fs.access(iniPath).then(() => true, () => false))) {
    await fs.writeFile(
      iniPath,
      [
        `UDPPort=${gamePort}`,
        `SteamServerName=${server.displayName}`,
        'PublicServer=true',
        'PlayerRespawnWithSelf=false',
        'FastForwardMultiplier=40',
        '',
      ].join('\r\n'),
      'utf8',
    );
    ctx.log(`Created the server profile ${server.slug}.ini with the allocated port.`);
  }
  return profileDir;
}

/**
 * How much heap a Zomboid server should get on this machine.
 *
 * The upstream batch file ships a 4 GB default, which is sensible for a
 * dedicated box and a guaranteed failure on a small VM. Sizing from the
 * memory actually free at install time — minus headroom for Windows itself —
 * is the difference between a service that starts and one that dies before
 * it prints a single log line.
 */
export function zomboidHeapMegabytes(freeBytes: number): number {
  const FLOOR_MB = 1024;
  const CAP_MB = 4096;
  const RESERVE_MB = 1536;
  const availableMb = Math.floor(freeBytes / (1024 * 1024)) - RESERVE_MB;
  return Math.max(FLOOR_MB, Math.min(CAP_MB, availableMb));
}

async function installZomboid(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  entry: GameServerCatalogEntry,
  ctx: JobContext,
): Promise<void> {
  const gamePort = (await publicPorts(deps, server.id)).find((binding) => binding.purpose === 'game')?.port;
  if (!gamePort) throw new Error('The Project Zomboid server does not have a game port allocated.');

  const profileDir = await seedZomboidProfile(server, gamePort, ctx);
  const classpath = await zomboidClasspath(server.installPath);
  // launchExecutable is a relative path in the catalog; the walker matches
  // basenames, and java.exe is unique inside this package.
  const wantedExecutable = path.basename(entry.launchExecutable ?? entry.executable);
  const launchExecutable = await findExecutable(server.installPath, [wantedExecutable]);
  if (!launchExecutable) {
    throw new Error('The Project Zomboid download did not contain its bundled java.exe.');
  }

  const adminPassword = crypto.randomBytes(18).toString('base64url');
  if (deps.vault) {
    writeSecret(deps.db, deps.vault, `game-server:${server.id}:admin-password`, adminPassword);
  }

  const heapMb = zomboidHeapMegabytes((deps.freeMemoryBytes ?? os.freemem)());
  const args = entry.launchArgs.map((argument) =>
    argument
      .replaceAll('{gamePort}', String(gamePort))
      .replaceAll('{slug}', server.slug)
      .replaceAll('{classpath}', classpath)
      .replaceAll('{heapMb}', String(heapMb)),
  );
  ctx.log(`Giving the server ${heapMb} MB of heap, sized from the memory this machine has free.`);

  const managedServer = { ...server, dataPath: profileDir };
  const serviceId = await registerService(deps, managedServer, launchExecutable, args, server.installPath, ctx);

  // First launch asks for an admin password on its console; nobody can type
  // into a WinSW child. Feed it the generated one so the server reaches a
  // state the panel can control, and record the fact in the job log without
  // printing the password.
  ctx.log('First start will create the admin account with a panel-generated password.');
  deps.db.db
    .update(gameServers)
    .set({ dataPath: profileDir, serviceId, state: 'stopped', updatedAt: new Date() })
    .where(eq(gameServers.id, server.id))
    .run();
  ctx.progress(100);
  ctx.log(`${entry.name} is installed and stopped. The world and settings live in its Files view.`);
}

/**
 * Downloads Zomboid through the shared anonymous Steam path, then applies its
 * dedicated launch adapter instead of the generic fixed-App-ID service wiring.
 *
 * Split out rather than folded into installSteam: the generic path treats
 * every Steam game as executable-plus-args, while Zomboid's real runtime is
 * its bundled JRE with a classpath, a profile folder, and a console prompt.
 */
async function installSteamZomboid(
  deps: GameServerInstallDependencies,
  server: typeof gameServers.$inferSelect,
  entry: GameServerCatalogEntry,
  ctx: JobContext,
): Promise<void> {
  if (!entry.steamAppId) throw new Error('This Steam provider has no dedicated-server App ID.');
  if (!deps.binDir) throw new Error('SteamCMD is not configured on this server.');

  const steamcmd = path.join(deps.binDir, 'steamcmd', 'steamcmd.exe');
  if (!(await fs.access(steamcmd).then(() => true, () => false))) {
    throw new Error('SteamCMD is not installed. Install it from Settings before installing this server.');
  }

  await fs.mkdir(server.installPath, { recursive: true });
  ctx.log(`Downloading Steam app ${entry.steamAppId} through SteamCMD.`);
  const branch = server.branch?.trim();
  if (branch) ctx.log(`Using the "${branch}" Steam branch.`);
  const result = await (deps.runCommand ?? runCommand)({
    exe: steamcmd,
    cwd: path.dirname(steamcmd),
    args: [
      '+force_install_dir', server.installPath,
      '+login', 'anonymous',
      '+app_update', String(entry.steamAppId), ...(branch ? ['-beta', branch] : []), 'validate',
      '+quit',
    ],
    timeoutMs: 60 * 60 * 1000,
    onOutput: (line) => {
      if (/error|failed/i.test(line)) ctx.log(line, 'warn');
      else if (line.trim()) ctx.log(line);
    },
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || /failed to install app/i.test(combinedOutput)) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`SteamCMD could not install the dedicated-server files.${detail ? ` ${detail}` : ''}`);
  }
  ctx.progress(70);

  // StartServer64.bat is a batch file, and the executable walker only knows
  // .exe. Its presence is the completion marker; the service runs the JRE.
  const marker = path.join(server.installPath, entry.executable);
  if (!(await fs.access(marker).then(() => true, () => false))) {
    throw new Error(`SteamCMD completed, but ${entry.executable} was not found.`);
  }

  await installZomboid(deps, server, entry, ctx);
}

async function findDirectory(root: string, name: string, depth = 4): Promise<string | null> {
  if (depth < 0) return null;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name.toLowerCase() === name.toLowerCase()) return full;
    const nested = await findDirectory(full, name, depth - 1);
    if (nested) return nested;
  }
  return null;
}

export function createInstallGameServerHandler(deps: GameServerInstallDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const input = payload as InstallGameServerPayload;
    const server = deps.db.db.select().from(gameServers).where(eq(gameServers.id, input.gameServerId)).get();
    if (!server) throw new Error('That game server no longer exists.');
    if (catalogEntry(deps.catalogue, server.catalogId)?.status !== 'ready') {
      throw new Error('This game is still being tested and cannot be installed yet.');
    }

    const wasRunning = server.state === 'running';
    if ((input.reinstall || input.update) && server.serviceId && deps.services && wasRunning) {
      ctx.log('The server is running, so it is stopping before its files change. It starts again when the update finishes.');
      await deps.services.stop(server.serviceId);
    }

    const state = input.reinstall ? 'reinstalling' : input.update ? 'updating' : 'installing';
    deps.db.db.update(gameServers).set({ state, updatedAt: new Date() }).where(eq(gameServers.id, server.id)).run();

    try {
      if (server.catalogId === 'minecraft-java-vanilla') {
        await installMinecraftJava(deps, server, ctx);
      } else if (server.catalogId === 'minecraft-bedrock-vanilla') {
        await installBedrock(deps, server, ctx);
      } else if (server.catalogId === 'zomboid-dedicated') {
        const entry = catalogEntry(deps.catalogue, server.catalogId);
        if (!entry) throw new Error('This game server provider is not installable yet.');
        await installSteamZomboid(deps, server, entry, ctx);
      } else if (catalogEntry(deps.catalogue, server.catalogId)?.provider === 'steam') {
        await installSteam(deps, server, ctx);
      } else {
        throw new Error('This game server provider is not installable yet.');
      }

      if ((input.reinstall || input.update) && wasRunning && server.serviceId && deps.services) {
        ctx.log('Starting the server with the updated files.');
        await deps.services.start(server.serviceId);
        deps.db.db.update(gameServers).set({ state: 'running', updatedAt: new Date() }).where(eq(gameServers.id, server.id)).run();
      }
      return;
    } catch (error) {
      deps.db.db
        .update(gameServers)
        .set({ state: 'failed', updatedAt: new Date() })
        .where(eq(gameServers.id, server.id))
        .run();
      throw error;
    }
  };
}
