import { z } from 'zod';

/** Providers WinPanel knows how to install and supervise on Windows. */
export const GameServerProviderId = z.enum([
  'minecraft-java',
  'minecraft-bedrock',
  'steam',
]);
export type GameServerProviderId = z.infer<typeof GameServerProviderId>;

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

export const GameServerConsoleKind = z.enum(['stdin', 'rcon', 'none']);
export type GameServerConsoleKind = z.infer<typeof GameServerConsoleKind>;

export const GameServerPort = z.object({
  name: z.string().min(1).max(64),
  protocol: GameServerPortProtocol,
  purpose: GameServerPortPurpose,
  visibility: GameServerPortVisibility,
  port: z.number().int().min(1024).max(49151),
});
export type GameServerPort = z.infer<typeof GameServerPort>;

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
  /** Fixed arguments appended to the provider's launch arguments. */
  launchArgs: z.array(z.string().max(500)).default([]),
  /** Official mutable download, used by providers that do not publish hashes. */
  downloadUrl: z.string().url().optional(),
  downloadSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  console: GameServerConsoleKind.default('none'),
  /** Provider data folder to expose in the scoped Files view, relative to installPath. */
  dataDirectory: z.string().max(200).optional(),
});
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
