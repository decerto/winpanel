import { z } from 'zod';
import { RelativePath } from './paths.js';

/**
 * `winpanel.json` — the one config file a site has.
 *
 * IMPORTANT: this file is read from the user's git repository, so it is
 * UNTRUSTED INPUT. Every path is constrained to stay inside the checkout, and
 * `command` is an allowlist rather than a free string, so a hostile or
 * mistyped manifest cannot make the agent execute an arbitrary binary. Custom
 * build logic belongs in a package.json script, which the allowlisted package
 * manager then runs.
 *
 * (For the avoidance of doubt: this replaces what a `web.config` would have
 * been under IIS. IIS is not used anywhere in this system, and no `web.config`
 * is ever generated or read.)
 */

export const SCHEMA_VERSION = 1;

/**
 * Executables the agent is willing to launch for a build step. The agent
 * resolves each of these to an absolute path itself; the manifest can never
 * specify a path to a binary.
 */
export const StepCommand = z.enum(['npm', 'pnpm', 'yarn', 'bun', 'node', 'npx', 'dotnet', 'composer']);
export type StepCommand = z.infer<typeof StepCommand>;

export const PackageManager = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManager>;

export const Runtime = z.enum([
  /** A Node process the panel supervises. */
  'node',
  /** Files served directly by Caddy, no process. */
  'static',
  /** A .NET/Kestrel process the panel supervises. */
  'dotnet',
  /** An externally managed process; the panel only routes traffic to it. */
  'proxy',
  /**
   * PHP, executed by a small pool of php-cgi FastCGI workers the panel
   * supervises; Caddy talks to them with its built-in FastCGI transport.
   */
  'php',
]);
export type Runtime = z.infer<typeof Runtime>;

export const BuildStep = z.object({
  /** Shown in the deploy log, in plain English. e.g. "Install frontend packages". */
  name: z.string().min(1).max(120),
  /**
   * Folder this step runs in, relative to the repository root.
   * Empty string means the repository root.
   */
  cwd: RelativePath.default(''),
  command: StepCommand,
  args: z.array(z.string().max(256)).max(32).default([]),
  /** If true, a non-zero exit is logged but does not fail the deploy. */
  optional: z.boolean().default(false),
  /** Extra environment variables for this step only. Values are non-secret. */
  env: z.record(z.string(), z.string()).default({}),
});
export type BuildStep = z.infer<typeof BuildStep>;

export const AppSpec = z.object({
  /**
   * The folder that actually runs. For the common "frontend builds into
   * backend" layout this is `backend`, NOT the repository root.
   */
  cwd: RelativePath.default(''),
  /** Entry file relative to `cwd`, e.g. `server.js` or `.output/server/index.mjs`. */
  entry: RelativePath.optional(),
  /** Environment variable the app reads its port from. */
  portEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('PORT'),
  /** Path the panel polls to decide whether a new release is healthy. */
  healthCheckPath: z.string().startsWith('/').default('/'),
  /** How long to wait for the health check to pass before failing the deploy. */
  healthCheckTimeoutSeconds: z.number().int().min(5).max(600).default(90),
});
export type AppSpec = z.infer<typeof AppSpec>;

export const SiteManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  runtime: Runtime.default('node'),

  /** Node version, resolved through fnm. e.g. "22" or "22.14.0". */
  nodeVersion: z.string().max(32).optional(),
  packageManager: PackageManager.default('npm'),

  /**
   * `server`  — run the build steps on the server during deploy.
   * `prebuilt` — the repo/zip already contains built output; skip build steps
   *              and only install production dependencies.
   */
  buildLocation: z.enum(['server', 'prebuilt']).default('server'),

  /** Ordered build steps. Each may run in a different folder. */
  steps: z.array(BuildStep).max(20).default([]),

  app: AppSpec.default({}),

  /**
   * Only true when Caddy itself serves the SPA and must fall back to
   * index.html for client-side routes.
   *
   * Deliberately false when a Node app serves its own frontend and already has
   * a catch-all route — adding a Caddy fallback there would double-handle
   * requests and mask genuine API 404s.
   */
  spaFallback: z.boolean().default(false),

  /** Folder served directly by Caddy. Only meaningful for `runtime: 'static'`. */
  staticRoot: RelativePath.optional(),

  /**
   * The site's flavour, when it was created from one. `'wordpress'` drives
   * the badge and setup hints in the panel; it never changes how files are
   * served — WordPress is just a PHP site once installed.
   */
  preset: z.enum(['wordpress']).nullable().default(null),

  /**
   * Names of environment variables the app expects. Values are never stored
   * here — they live encrypted in the panel's vault.
   */
  envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(200).default([]),

  /** Drop build-only dependency folders after a successful build to save disk. */
  pruneAfterBuild: z.array(RelativePath).max(20).default([]),

  /**
   * Set when the app uses WebSockets. Blue/green deploys are then mandatory
   * (never round-robin), because socket.io requires sticky sessions.
   */
  websockets: z.boolean().default(false),
});
export type SiteManifest = z.infer<typeof SiteManifest>;

/** Parse a manifest read from a repository, with all defaults applied. */
export function parseManifest(input: unknown): SiteManifest {
  return SiteManifest.parse(input);
}

export const MANIFEST_FILENAME = 'winpanel.json';
