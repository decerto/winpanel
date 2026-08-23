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
import type { GameServerCatalogEntry, GameServerHeap } from '@winpanel/shared';
import type { SecretVault } from '../security/vault.js';
import { readSecret, writeSecret } from '../security/secret-store.js';
import type { GameServerCatalogue } from './catalogue-loader.js';
import { expandPlaceholders, type PlaceholderValues } from './placeholders.js';
import { writeSeedFiles } from './seed-files.js';

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
  catalogue: GameServerCatalogue;
  runCommand?: typeof runCommand;
  /** Injectable for tests; production checks the host's Java runtime. */
  runJava?: () => Promise<boolean>;
  /** Injectable for tests; production reads the host's free memory. */
  freeMemoryBytes?: () => number;
}

type ServerRow = typeof gameServers.$inferSelect;

function catalogEntry(
  catalogue: GameServerCatalogue,
  id: string,
): GameServerCatalogEntry | undefined {
  return catalogue.find(id);
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  return value;
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false,
  );
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

async function publicPorts(deps: GameServerInstallDependencies, serverId: string) {
  return deps.db.db
    .select()
    .from(gameServerPorts)
    .where(eq(gameServerPorts.gameServerId, serverId))
    .all();
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

/**
 * How much heap a JVM game should get on this machine.
 *
 * The upstream launchers ship a figure chosen for a dedicated box, which is a
 * guaranteed failure on a small VM. Sizing from the memory actually free at
 * install time is the difference between a service that starts and one that
 * dies before it prints a single log line.
 */
export function heapMegabytes(freeBytes: number, heap: GameServerHeap): number {
  const availableMb = Math.floor(freeBytes / (1024 * 1024)) - heap.reserveMb;
  return Math.max(heap.minMb, Math.min(heap.maxMb, availableMb));
}

/**
 * Joins a folder of jars into a classpath, relative to the install root.
 *
 * Relative rather than absolute because the games that need this run with
 * their install folder as the working directory, and their own launchers
 * write it the same way.
 */
async function buildClasspath(installPath: string, directory: string): Promise<string> {
  const absolute = path.join(installPath, directory);
  const jars = (await fs.readdir(absolute, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .map((entry) => path.posix.join(directory.replaceAll('\\', '/'), entry.name))
    .sort();
  if (jars.length === 0) {
    throw new Error(`The download did not contain any jars in ${directory}, so the server cannot start.`);
  }
  return jars.join(';');
}

/**
 * The data folder the game actually writes to.
 *
 * Most games are happy with the panel's own data folder. Some create their own
 * tree inside the install and ignore anything else, which is what
 * `dataDirectory` describes; it is resolved case-insensitively because the
 * folder may already exist from a previous run.
 */
async function resolveDataDirectory(server: ServerRow, entry: GameServerCatalogEntry): Promise<string> {
  if (!entry.dataDirectory) return server.dataPath;
  const direct = path.join(server.installPath, entry.dataDirectory);
  if (await exists(direct)) return direct;
  return (await findDirectory(server.installPath, entry.dataDirectory)) ?? direct;
}

/**
 * Generates every secret the entry declares, reusing any already stored.
 *
 * Rotating on reinstall would leave the vault disagreeing with the account the
 * game created on its first run, so an existing value always wins.
 */
function resolveSecrets(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  entry: GameServerCatalogEntry,
): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const declared of entry.secrets) {
    const key = `game-server:${server.id}:${declared.name}`;
    const existing = deps.vault ? readSecret(deps.db, deps.vault, key) : null;
    const value = existing ?? crypto.randomBytes(declared.bytes).toString('base64url');
    if (deps.vault && !existing) writeSecret(deps.db, deps.vault, key, value);
    secrets.set(declared.name, value);
  }
  return secrets;
}

async function resolveExecutable(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  entry: GameServerCatalogEntry,
): Promise<string> {
  if (entry.runtime === 'java') {
    const bundled = deps.binDir ? await findExecutable(path.join(deps.binDir, 'java'), ['java.exe']) : null;
    const javaExe = bundled ?? 'java.exe';
    const works = deps.runJava
      ? await deps.runJava()
      : (await (deps.runCommand ?? runCommand)({ exe: javaExe, args: ['-version'], timeoutMs: 10_000 })).exitCode === 0;
    if (!works) throw new Error(`${entry.name} was downloaded, but no working Java runtime was found.`);
    return javaExe;
  }

  // The walker matches on basename, so a nested path in the catalog still
  // finds the right binary inside the download.
  const wanted = path.basename(entry.launchExecutable ?? entry.executable);
  const found = await findExecutable(server.installPath, [wanted]);
  if (!found) throw new Error(`The download did not contain ${wanted}.`);
  return found;
}

function workingDirectoryFor(
  entry: GameServerCatalogEntry,
  server: ServerRow,
  dataDir: string,
  executable: string,
): string {
  if (entry.workingDirectory === 'data') return dataDir;
  if (entry.workingDirectory === 'executable') return path.dirname(executable);
  return server.installPath;
}

async function registerService(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  executable: string,
  args: readonly string[],
  workingDirectory: string,
  ctx: JobContext,
): Promise<string> {
  const serviceId = server.serviceId ?? `winpanel-game-${server.slug}`;
  const definition = {
    id: serviceId,
    displayName: `WinPanel ${server.displayName}`,
    description: `${catalogEntry(deps.catalogue, server.catalogId)?.name ?? 'Game'} managed by WinPanel.`,
    executable,
    args,
    workingDirectory,
    logPath: path.join(server.dataPath, 'logs'),
  };
  if (deps.services) {
    if (await deps.services.isInstalled(serviceId)) {
      // A reinstall is the repair path for a server registered with launch
      // arguments that have since been corrected, so refresh them rather than
      // leaving the broken ones in place.
      if ((await deps.services.reconfigure(definition)) === 'updated') {
        ctx.log('Updated the Windows service with the current launch arguments.');
      }
    } else {
      await deps.services.install(definition);
      ctx.log('Registered the Windows service. The server is stopped until you start it.');
    }
  }

  if (deps.firewall) {
    await applyGameServerFirewall(deps.firewall, server.slug, await publicPorts(deps, server.id));
    ctx.log('Applied the Windows Firewall rules for the public game ports.');
  }

  return serviceId;
}

/**
 * Everything between "the files are on disk" and "the service is registered".
 *
 * Deliberately knows nothing about any particular game: ports, secrets, heap,
 * config files, working directory and launch arguments all come from the
 * catalog entry. Supporting a new game is a JSON file, not a branch here.
 */
async function configureAndRegister(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  entry: GameServerCatalogEntry,
  installedVersion: string | null,
  ctx: JobContext,
): Promise<void> {
  const dataDir = await resolveDataDirectory(server, entry);
  await fs.mkdir(dataDir, { recursive: true });

  const ports = new Map<string, number>();
  for (const binding of await publicPorts(deps, server.id)) {
    ports.set(binding.name, binding.port);
    // Purpose is the key that means the same thing across games, so
    // `{port:game}` works whatever a config calls its bindings.
    if (!ports.has(binding.purpose)) ports.set(binding.purpose, binding.port);
  }

  const values: PlaceholderValues = {
    slug: server.slug,
    displayName: server.displayName,
    installPath: server.installPath,
    dataDir,
    version: installedVersion ?? server.version ?? '',
    ports,
    secrets: resolveSecrets(deps, server, entry),
    classpath: entry.classpathDirectory
      ? await buildClasspath(server.installPath, entry.classpathDirectory)
      : undefined,
    heapMb: entry.heap ? heapMegabytes((deps.freeMemoryBytes ?? os.freemem)(), entry.heap) : undefined,
  };
  if (values.heapMb !== undefined) {
    ctx.log(`Giving the server ${values.heapMb} MB of heap, sized from the memory this machine has free.`);
  }

  for (const outcome of await writeSeedFiles(entry.seedFiles, dataDir, values)) {
    if (outcome.written) ctx.log(`Wrote ${outcome.path}.`);
  }

  const executable = await resolveExecutable(deps, server, entry);
  const args = entry.launchArgs.map((argument) => expandPlaceholders(argument, values));
  const workingDirectory = workingDirectoryFor(entry, server, dataDir, executable);

  const serviceId = await registerService(
    deps,
    { ...server, dataPath: dataDir },
    executable,
    args,
    workingDirectory,
    ctx,
  );

  deps.db.db
    .update(gameServers)
    .set({
      dataPath: dataDir,
      serviceId,
      state: 'stopped',
      ...(installedVersion ? { version: installedVersion } : {}),
      updatedAt: new Date(),
    })
    .where(eq(gameServers.id, server.id))
    .run();
  ctx.progress(100);
  ctx.log(`${entry.name} is installed and stopped. It is ready to start.`);
}

async function acquireMinecraftJava(
  server: ServerRow,
  ctx: JobContext,
): Promise<string> {
  const manifest = await fetchJson<MinecraftManifest>(VERSION_MANIFEST_URL);
  const wanted = server.version ?? manifest.latest?.release;
  const version = manifest.versions?.find((entry) => entry.id === wanted);
  if (!version?.url || !version.id) throw new Error(`Minecraft Java version "${wanted ?? 'latest'}" is not available.`);

  const versionManifest = await fetchJson<MinecraftVersionManifest>(version.url);
  const download = versionManifest.downloads?.server;
  const url = assertString(download?.url, 'That Minecraft version has no server download.');
  const sha1 = assertString(download?.sha1, 'That Minecraft version has no published fingerprint.');

  await fs.mkdir(server.installPath, { recursive: true });
  ctx.progress(15);
  ctx.log(`Preparing Minecraft Java ${version.id}.`);

  await downloadSha1(url, path.join(server.installPath, 'server.jar'), sha1, ctx);
  ctx.throwIfCancelled();
  ctx.progress(70);
  return version.id;
}

async function acquireDownload(
  server: ServerRow,
  entry: GameServerCatalogEntry,
  ctx: JobContext,
): Promise<void> {
  if (!entry.downloadUrl) throw new Error('This provider has no official download configured.');

  const archivePath = path.join(server.installPath, '.download.zip');
  await fs.mkdir(server.installPath, { recursive: true });
  ctx.log(`Downloading the official ${entry.name}.`);
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
    ctx.log('This archive has no stable publisher hash; executable discovery will still be checked.', 'warn');
  }
  await extractZip(archivePath, server.installPath);
  await fs.rm(archivePath, { force: true });
  ctx.progress(70);
}

async function acquireSteam(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  entry: GameServerCatalogEntry,
  ctx: JobContext,
): Promise<void> {
  if (!entry.steamAppId) throw new Error('This Steam provider has no dedicated-server App ID.');
  if (!deps.binDir) throw new Error('SteamCMD is not configured on this server.');

  const steamcmd = path.join(deps.binDir, 'steamcmd', 'steamcmd.exe');
  if (!(await exists(steamcmd))) {
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
}

/**
 * Confirms the download produced what the catalog said it would.
 *
 * For games whose real binary is elsewhere in the tree — a bundled JVM, or a
 * batch file the panel deliberately does not run — `executable` is the
 * completion marker rather than the thing that runs, so it is accepted
 * anywhere under the install root.
 */
async function assertDownloaded(server: ServerRow, entry: GameServerCatalogEntry): Promise<void> {
  if (await exists(path.join(server.installPath, entry.executable))) return;
  if (await findExecutable(server.installPath, [path.basename(entry.executable)])) return;
  throw new Error(`The download completed, but ${entry.executable} was not found.`);
}

/** Returns the version the provider actually resolved, when it picks one. */
async function acquire(
  deps: GameServerInstallDependencies,
  server: ServerRow,
  entry: GameServerCatalogEntry,
  ctx: JobContext,
): Promise<string | null> {
  if (entry.provider === 'minecraft-java') {
    return await acquireMinecraftJava(server, ctx);
  }
  if (entry.provider === 'steam') {
    await acquireSteam(deps, server, entry, ctx);
  } else {
    // `minecraft-bedrock` predates the generic name and behaves identically.
    await acquireDownload(server, entry, ctx);
  }
  await assertDownloaded(server, entry);
  return null;
}

export function createInstallGameServerHandler(deps: GameServerInstallDependencies) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const input = payload as InstallGameServerPayload;
    const server = deps.db.db.select().from(gameServers).where(eq(gameServers.id, input.gameServerId)).get();
    if (!server) throw new Error('That game server no longer exists.');
    const entry = catalogEntry(deps.catalogue, server.catalogId);
    if (!entry || entry.status !== 'ready') {
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
      const installedVersion = await acquire(deps, server, entry, ctx);
      await configureAndRegister(deps, server, entry, installedVersion, ctx);

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
