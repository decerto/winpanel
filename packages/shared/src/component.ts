import { z } from 'zod';

/**
 * Components are the third-party pieces the panel installs after it is itself
 * running: Caddy, Stalwart, git, Node versions, .NET.
 *
 * The panel's own installer bundles everything it needs to start, so a broken
 * network can never prevent first boot. Components are fetched afterwards,
 * with a pinned version and a SHA-256 that is verified before anything is
 * executed.
 */

export const ComponentId = z.enum([
  'caddy',
  'stalwart',
  'git',
  'node',
  'java',
  'pnpm',
  'yarn',
  'bun',
  'dotnet',
  'vcredist',
  'php',
  'mariadb',
  /** PostgreSQL, for sites and apps that want a relational database. */
  'postgres',
  /** MongoDB, for the document-store half of the same job. */
  'mongodb',
  'composer',
  /** The single-file database browser, served only through the panel itself. */
  'adminer',
  /** Valve's self-updating tool for downloading allowlisted Steam servers. */
  'steamcmd',
]);
export type ComponentId = z.infer<typeof ComponentId>;

export const ComponentKind = z.enum([
  /** Extract an archive; no installer to run. Preferred for determinism. */
  'zip',
  /**
   * The download is the program itself, not a container for it. Caddy's
   * build service works this way, and it also serves the file compressed, so
   * neither the name nor the length describes what arrives.
   */
  'binary',
  /** Run a signed installer executable with silent flags. */
  'exe',
  /** Run a PowerShell script (used only for the official dotnet-install). */
  'script',
  /**
   * A single PHP archive (`.phar`) run with the installed PHP. Composer is
   * published this way and has no standalone program for Windows.
   */
  'php-script',
  /**
   * The download is a single JavaScript file run with Node. Yarn 1 is
   * published this way and has no standalone program for Windows.
   */
  'node-script',
]);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const ComponentDefinition = z.object({
  id: ComponentId,
  /** Plain-English name shown in the UI. */
  name: z.string().min(1),
  /** One sentence on what this is for, in plain English. */
  description: z.string().min(1),
  version: z.string().min(1),
  kind: ComponentKind,
  url: z.string().url(),
  /**
   * Lowercase hex SHA-256 of the download. Verified before the file is
   * extracted or executed. A mismatch aborts the install.
   *
  * Null only for downloads that are generated per-request or are mutable
  * publisher bootstrappers (Caddy and Valve's SteamCMD). Those are
  * additionally validated by their executable verification command.
   */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  /** Arguments for `exe`/`script` kinds. Never a shell string. */
  args: z.array(z.string()).default([]),
  /** Windows service registered by this component, if any. */
  serviceName: z.string().nullable().default(null),
  /** Command used to confirm the install worked, e.g. ['--version']. */
  verifyArgs: z.array(z.string()).default(['--version']),
  /** Substring expected in the verify output. */
  verifyExpect: z.string().nullable().default(null),
  /** Components that must be installed first. */
  requires: z.array(ComponentId).default([]),
});
export type ComponentDefinition = z.infer<typeof ComponentDefinition>;

export const ComponentInstallState = z.enum([
  'not-installed',
  'installing',
  'installed',
  'failed',
  'update-available',
]);
export type ComponentInstallState = z.infer<typeof ComponentInstallState>;

export const InstalledComponent = z.object({
  id: ComponentId,
  state: ComponentInstallState,
  installedVersion: z.string().nullable().default(null),
  availableVersion: z.string().nullable().default(null),
  installPath: z.string().nullable().default(null),
  serviceName: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  installedAt: z.coerce.date().nullable().default(null),
});
export type InstalledComponent = z.infer<typeof InstalledComponent>;

/** The manifest shipped with a release, listing every pinned component. */
export const ComponentManifest = z.object({
  manifestVersion: z.literal(1),
  generatedAt: z.coerce.date(),
  components: z.array(ComponentDefinition),
});
export type ComponentManifest = z.infer<typeof ComponentManifest>;
