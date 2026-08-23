import { z } from 'zod';

/** Providers WinPanel knows how to install and supervise on Windows. */
export const GameServerProviderId = z.enum([
  'minecraft-java',
  'minecraft-bedrock',
  'download',
  'steam',
]);
export type GameServerProviderId = z.infer<typeof GameServerProviderId>;

/**
 * A path inside the server's own folders.
 *
 * Config files are contributed by whoever writes the game's JSON, so a path
 * that escapes the server's directory would let a catalog file write anywhere
 * the agent can reach. Absolute paths and `..` segments are rejected here and
 * checked again when the file is written.
 */
export function isSafeRelativePath(value: string): boolean {
  if (/^[a-zA-Z]:/.test(value) || /^[\\/]/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '..' && segment.trim() !== '');
}

const SeedPath = z
  .string()
  .min(1)
  .max(300)
  .refine(isSafeRelativePath, 'must be a relative path inside the server folder');

export const GameServerState = z.enum([
  'uninstalled',
  'installing',
  'stopped',
  'starting',
  'running',
  'stopping',
  'updating',
  'reinstalling',
  'failed',
]);
export type GameServerState = z.infer<typeof GameServerState>;

export const GameServerPortProtocol = z.enum(['tcp', 'udp']);
export type GameServerPortProtocol = z.infer<typeof GameServerPortProtocol>;

export const GameServerPortPurpose = z.enum(['game', 'query', 'rcon', 'admin']);
export type GameServerPortPurpose = z.infer<typeof GameServerPortPurpose>;

export const GameServerPortVisibility = z.enum(['public', 'loopback']);
export type GameServerPortVisibility = z.infer<typeof GameServerPortVisibility>;

export const GameServerCatalogStatus = z.enum(['ready', 'planned']);
export type GameServerCatalogStatus = z.infer<typeof GameServerCatalogStatus>;

/**
 * How much of a console a game exposes.
 *
 * `logs` is a read-only tail of the service log; `rcon` adds sending commands
 * over Source RCON, which needs a port with `purpose: "rcon"` and a secret
 * named `rcon`. There is no option for typing into the process's own console:
 * a Windows service has no one at its keyboard.
 */
export const GameServerConsoleKind = z.enum(['logs', 'rcon', 'none']);
export type GameServerConsoleKind = z.infer<typeof GameServerConsoleKind>;

export const GameServerPort = z.object({
  name: z.string().min(1).max(64),
  protocol: GameServerPortProtocol,
  purpose: GameServerPortPurpose,
  visibility: GameServerPortVisibility,
  port: z.number().int().min(1024).max(49151),
});
export type GameServerPort = z.infer<typeof GameServerPort>;

/**
 * A value generated once per server and kept in the vault.
 *
 * Referenced from launch arguments and config files as `{secret:name}`, so a
 * game that needs an RCON or admin password gets one without the agent
 * knowing which game it is. Regenerating on reinstall would desynchronise the
 * vault from whatever the game already wrote down, so the value is reused.
 */
export const GameServerSecret = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'must be lowercase letters, digits and dashes'),
  bytes: z.number().int().min(8).max(64).default(18),
});
export type GameServerSecret = z.infer<typeof GameServerSecret>;

export const GameServerSeedFormat = z.enum(['properties', 'ini', 'json', 'text']);
export type GameServerSeedFormat = z.infer<typeof GameServerSeedFormat>;

/**
 * A configuration file the panel writes before the first start.
 *
 * This is how a game gets told which port it was allocated and what its
 * generated passwords are. Values go through the same placeholder expansion
 * as launch arguments.
 */
export const GameServerSeedFile = z.object({
  /** Relative to the server's data folder. */
  path: SeedPath,
  format: GameServerSeedFormat,
  /**
   * `create` writes the file only when it is absent, so hand edits survive a
   * reinstall. `merge` keeps every other line and rewrites only these keys,
   * which is what a port allocation needs to do to a file the game owns.
   */
  mode: z.enum(['create', 'merge']).default('create'),
  /** Used by `text` files; the other formats build their content from `values`. */
  content: z.string().max(20000).optional(),
  values: z
    .record(
      z.string().min(1).max(200),
      z.union([z.string().max(2000), z.number(), z.boolean()]),
    )
    .default({}),
  /** Some games only parse their own settings file when it uses CRLF. */
  eol: z.enum(['lf', 'crlf']).default('lf'),
});
export type GameServerSeedFile = z.infer<typeof GameServerSeedFile>;

/**
 * Heap sizing for games that run on a JVM.
 *
 * Sized from the memory actually free at install time rather than a fixed
 * figure, because the upstream launchers ship a number chosen for a dedicated
 * box and a small VM dies before printing a log line.
 */
export const GameServerHeap = z.object({
  minMb: z.number().int().min(128).max(65536).default(1024),
  maxMb: z.number().int().min(128).max(65536).default(4096),
  /** Left for Windows and everything else on the machine. */
  reserveMb: z.number().int().min(0).max(65536).default(1536),
});
export type GameServerHeap = z.infer<typeof GameServerHeap>;

/** Where the service runs from. */
export const GameServerWorkingDirectory = z.enum(['install', 'data', 'executable']);
export type GameServerWorkingDirectory = z.infer<typeof GameServerWorkingDirectory>;

/**
 * Where the installed Workshop item ids are written back.
 *
 * Downloading a mod is only half the job: the game has to be told to load it,
 * and every game spells that differently. Naming the file and its two keys in
 * the catalog means the panel can keep the list correct after every add and
 * remove without knowing which game it is.
 */
export const GameServerWorkshopConfig = z.object({
  /** Relative to the server's data folder. */
  path: SeedPath,
  /** Key listing the published file ids, e.g. `WorkshopItems`. */
  itemsKey: z.string().min(1).max(64).optional(),
  /** Key listing the mod ids found inside the downloaded items, e.g. `Mods`. */
  modsKey: z.string().min(1).max(64).optional(),
  separator: z.string().min(1).max(4).default(';'),
  eol: z.enum(['lf', 'crlf']).default('lf'),
});
export type GameServerWorkshopConfig = z.infer<typeof GameServerWorkshopConfig>;

/**
 * Steam Workshop support for a game.
 *
 * The download runs on the server with the panel's own SteamCMD, so a customer
 * adds a mod by pasting its link and never needs a Steam account of their own.
 * `anonymous` says whether Valve serves this app's Workshop without a login;
 * when it does not, the panel falls back to the operator's configured account,
 * which is the same one that installed the server files.
 */
export const GameServerWorkshop = z.object({
  /** The app whose Workshop holds the items — the game, not the server tool. */
  appId: z.number().int().positive(),
  /** Overrides the Steam Workshop page the "Browse" button opens. */
  browseUrl: z.string().url().startsWith('https://').optional(),
  anonymous: z.boolean().default(true),
  /**
   * Mod folders found inside a downloaded item are copied here, relative to
   * the data folder. Left out, the item stays where SteamCMD put it and only
   * the config keys are updated.
   */
  modsDirectory: SeedPath.optional(),
  /** The file that marks a mod folder inside an item, and the key naming it. */
  modManifestFile: z.string().min(1).max(120).default('mod.info'),
  modManifestKey: z.string().min(1).max(64).default('id'),
  config: GameServerWorkshopConfig.optional(),
});
export type GameServerWorkshop = z.infer<typeof GameServerWorkshop>;

/** How far a Workshop item has got. */
export const GameServerWorkshopItemState = z.enum(['pending', 'installed', 'failed']);
export type GameServerWorkshopItemState = z.infer<typeof GameServerWorkshopItemState>;

/**
 * Turns whatever someone pasted into a published file id.
 *
 * People arrive with a browser URL, a `steam://` link from the client, or the
 * bare number, and asking them to work out which part is the id is the kind of
 * small indignity that makes a panel feel unfinished.
 */
export function parseWorkshopReference(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^\d{1,20}$/.test(text)) return text;

  const fromQuery = /[?&]id=(\d{1,20})\b/.exec(text);
  if (fromQuery?.[1]) return fromQuery[1];

  const fromPath = /(?:CommunityFilePage|filedetails)\/(\d{1,20})\b/i.exec(text);
  if (fromPath?.[1]) return fromPath[1];

  return null;
}

/** Every `{...}` token a config uses, across its arguments and seeded files. */
function tokensUsed(entry: {
  launchArgs?: string[];
  seedFiles?: Array<{ path: string; content?: string; values?: Record<string, unknown> }>;
}): string[] {
  const text = [
    ...(entry.launchArgs ?? []),
    ...(entry.seedFiles ?? []).flatMap((file) => [
      file.path,
      file.content ?? '',
      ...Object.values(file.values ?? {}).map((value) => String(value)),
    ]),
  ].join('\n');
  return [...text.matchAll(/\{[A-Za-z0-9_:-]+\}/g)].map((match) => match[0]);
}

/**
 * Rejects a config whose placeholders cannot possibly resolve.
 *
 * Checked here rather than at install time because the alternative is what it
 * used to be: a seven-gigabyte download, and then a failure because the file
 * asked for a heap size it never declared. A config that cannot work should
 * not reach the library at all, and its author should be told which line is
 * wrong.
 */
function assertPlaceholdersResolvable(
  entry: {
    ports: Array<{ name: string; purpose: string }>;
    secrets?: Array<{ name: string }>;
    heap?: unknown;
    classpathDirectory?: string;
    launchArgs?: string[];
    seedFiles?: Array<{ path: string; content?: string; values?: Record<string, unknown> }>;
  },
  ctx: z.RefinementCtx,
): void {
  const portKeys = new Set(entry.ports.flatMap((port) => [port.name, port.purpose]));
  const secretNames = new Set((entry.secrets ?? []).map((secret) => secret.name));

  for (const token of new Set(tokensUsed(entry))) {
    const problem = (message: string) => ctx.addIssue({ code: 'custom', message });

    if (token === '{heapMb}' && entry.heap === undefined) {
      problem('uses {heapMb} but declares no "heap", so there is no size to use');
    } else if (token === '{classpath}' && entry.classpathDirectory === undefined) {
      problem('uses {classpath} but declares no "classpathDirectory", so there are no jars to join');
    } else if (token === '{gamePort}' && !portKeys.has('game')) {
      problem('uses {gamePort} but declares no port named or purposed "game"');
    } else {
      const port = /^\{port:([A-Za-z0-9_-]+)\}$/.exec(token);
      if (port?.[1] && !portKeys.has(port[1])) {
        problem(`uses {port:${port[1]}} but declares no port with that name or purpose`);
      }
      const secret = /^\{secret:([A-Za-z0-9_-]+)\}$/.exec(token);
      if (secret?.[1] && !secretNames.has(secret[1])) {
        problem(`uses {secret:${secret[1]}} but declares no secret with that name`);
      }
    }
  }
}

export const GameServerCatalogEntry = z.object({
  id: z.string().min(1).max(80),
  provider: GameServerProviderId,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  status: GameServerCatalogStatus.default('ready'),
  genre: z.string().min(1).max(80),
  /** A local visual theme key, not a remote image URL. */
  art: z.enum(['forest', 'neon', 'ember', 'ocean', 'desert', 'violet', 'steel']).default('steel'),
  requiresEula: z.boolean(),
  ports: z.array(GameServerPort).min(1),
  /** Steam dedicated-server application id, for allowlisted Steam providers. */
  steamAppId: z.number().int().positive().optional(),
  /** Steam game application id used only for library artwork. */
  steamArtAppId: z.number().int().positive().optional(),
  /**
   * Official cover artwork for games that are not on Steam.
   *
   * The panel proxies it through its own authenticated route, so the browser
   * never talks to the origin directly and the image is cached server-side.
   */
  artUrl: z.string().url().startsWith('https://').optional(),
  /**
   * The main configuration file, relative to the server's data folder.
   *
   * When set, the server page shows a button that opens this file straight
   * into the editor, so the common edit does not need a browse through the
   * file manager. `{slug}` is expanded to the server's slug. Leave it out
   * when the provider has no single obvious settings file — the button is
   * simply not shown.
   */
  configFile: z.string().min(1).max(300).optional(),
  steamRequiresOwnership: z.boolean().default(false),
  /** Provider-owned executable expected after installation. */
  executable: z.string().min(1).max(120),
  /** When the service should run a different binary than the one found first. */
  launchExecutable: z.string().min(1).max(200).optional(),
  /**
   * `java` resolves the panel's own Java runtime instead of a binary inside
   * the download, for games that ship a jar and expect a JVM to be present.
   */
  runtime: z.enum(['native', 'java']).default('native'),
  /** Fixed arguments appended to the provider's launch arguments. */
  launchArgs: z.array(z.string().max(500)).default([]),
  /** Official mutable download, used by providers that do not publish hashes. */
  downloadUrl: z.string().url().optional(),
  downloadSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  console: GameServerConsoleKind.default('none'),
  /** Provider data folder to expose in the scoped Files view, relative to installPath. */
  dataDirectory: z.string().max(200).optional(),
  workingDirectory: GameServerWorkingDirectory.default('install'),
  /** Passwords the panel generates, vaults, and expands as `{secret:name}`. */
  secrets: z.array(GameServerSecret).max(8).default([]),
  /** Configuration written before the first start, so the game sees its ports. */
  seedFiles: z.array(GameServerSeedFile).max(12).default([]),
  heap: GameServerHeap.optional(),
  /**
   * Steam Workshop support. Present means the server page gets a Workshop tab
   * that can search, add and remove items; absent means the game has none.
   */
  workshop: GameServerWorkshop.optional(),
  /**
   * Folder of jars joined into `{classpath}`, relative to installPath. For
   * games launched through their own bundled JVM rather than a start script.
   */
  classpathDirectory: SeedPath.optional(),
}).superRefine(assertPlaceholdersResolvable);
export type GameServerCatalogEntry = z.infer<typeof GameServerCatalogEntry>;

export const GameServer = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  ownerUserId: z.string().uuid().nullable(),
  catalogId: z.string().min(1).max(80),
  version: z.string().max(80).nullable(),
  branch: z.string().max(80).nullable().optional(),
  state: GameServerState,
  installPath: z.string().min(1),
  dataPath: z.string().min(1),
  diskQuotaBytes: z.number().int().positive(),
  eulaAccepted: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type GameServer = z.infer<typeof GameServer>;

/** Customer game-server creation policy. Empty providers means any catalog entry. */
export const GameServerAccountPolicy = z.object({
  gameServerLimit: z.number().int().min(0).max(1000).nullable().default(null),
  gameServerProviders: z.array(z.string().min(1).max(80)).max(100).default([]),
});
export type GameServerAccountPolicy = z.infer<typeof GameServerAccountPolicy>;

export const GameServerCreateRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  catalogId: z.string().min(1).max(80),
  version: z.string().trim().max(80).optional(),
  eulaAccepted: z.boolean(),
});
export type GameServerCreateRequest = z.infer<typeof GameServerCreateRequest>;
