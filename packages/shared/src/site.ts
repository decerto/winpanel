import { z } from 'zod';
import { Runtime, SiteManifest } from './manifest.js';
import { isReservedDeviceName } from './paths.js';

/** URL-safe identifier used for folder names, service names, and Caddy `@id`s. */
export const Slug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers and hyphens.')
  // The slug becomes a folder name, and Windows has no folder called `con`.
  .refine((value) => !isReservedDeviceName(value), {
    message: 'That is a reserved Windows name. Choose another.',
  });
export type Slug = z.infer<typeof Slug>;

export const Hostname = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i,
    'Enter a valid web address, like example.com.',
  );
export type Hostname = z.infer<typeof Hostname>;

/**
 * Where a site's files come from.
 *
 * `git`    — cloned and built on every deploy, into `release/`.
 * `upload` — the user manages the files themselves, through the file manager
 *            or a zip upload. Nothing is ever overwritten by the panel.
 * `blank`  — same as `upload`, but the panel writes a starter page so the site
 *            answers immediately instead of returning a bare 404.
 *
 * The distinction that actually matters is `git` versus the rest: git sites
 * have a build pipeline, the others have a folder.
 */
export const SourceKind = z.enum(['git', 'upload', 'blank']);
export type SourceKind = z.infer<typeof SourceKind>;

export const GitSource = z.object({
  kind: z.literal('git'),
  /**
   * Either an https:// address or the SSH form a deploy key needs, which is
   * not a URL as far as the URL parser is concerned.
   * `apps/agent/src/sites/git-client.ts` is where this is really validated.
   */
  url: z.string().min(1).max(512),
  branch: z.string().min(1).max(120).default('main'),
  /** Subfolder within the repo, for repos containing several projects. */
  subdirectory: z.string().max(256).default(''),
});

export const UploadSource = z.object({
  kind: z.literal('upload'),
});

export const BlankSource = z.object({
  kind: z.literal('blank'),
});

export const SiteSource = z.discriminatedUnion('kind', [GitSource, UploadSource, BlankSource]);
export type SiteSource = z.infer<typeof SiteSource>;

/** True when the panel builds and releases this site rather than the user. */
export function isManagedBySource(source: Pick<SiteSource, 'kind'>): boolean {
  return source.kind === 'git';
}

/**
 * The folder a non-git site's files live in, relative to the site root.
 *
 * Deliberately outside `release/`, which the deploy pipeline replaces: files
 * the user put there by hand must never be deleted by a background task.
 * This is the equivalent of Plesk's `httpdocs`.
 */
export const PUBLIC_DIR = 'public';

/**
 * The folder a git site's built code lives in, relative to the site root.
 *
 * One folder, always the same path. A deploy builds elsewhere and swaps this
 * folder into place, so nothing that points here — a service, a Caddy root,
 * a path the user typed — ever has to be updated when the code changes.
 */
export const RELEASE_DIR = 'release';

/**
 * The folder whose contents survive every deploy, relative to the site root.
 *
 * A git site's files are the repository's, and `release/` is thrown away and
 * rebuilt each time — so there has to be somewhere for the things that are
 * *not* in the repository: uploads, customer PDFs, a verification file some
 * third party asked for. That is this folder, and it is served at
 * {@link SHARED_URL_PREFIX} so a file put here has an address without a
 * deploy, a code change, or any knowledge of where the site lives on disk.
 */
export const SHARED_DIR = 'shared';

/** The URL path {@link SHARED_DIR} is published at, on every domain of the site. */
export const SHARED_URL_PREFIX = '/shared';

/** Where a deploy assembles the next version before it goes live. */
export const STAGING_DIR = '.staging';

/** Holds the outgoing version just long enough to put it back if the new one fails. */
export const PREVIOUS_DIR = '.previous';

/**
 * Folders left behind by the timestamped layout sites used before
 * {@link RELEASE_DIR}. Nothing is served from them; the agent removes them on
 * start, and until it manages to they must not look like the live copy.
 */
export const LEGACY_RELEASE_DIRS = ['releases', 'current'] as const;

/**
 * True when a path inside a site is replaced by the next deploy, so anything
 * the user puts there is lost.
 */
export function isEphemeralSitePath(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  return [RELEASE_DIR, ...LEGACY_RELEASE_DIRS].some(
    (dir) => normalised === dir || normalised.startsWith(`${dir}/`),
  );
}

/**
 * The pair of ports reserved for a site. Only the active one is ever bound —
 * the spare exists so a port can be changed without colliding with the one
 * currently in use.
 */
export const PortPair = z.object({
  blue: z.number().int().min(1024).max(65535),
  green: z.number().int().min(1024).max(65535),
  active: z.enum(['blue', 'green']).default('blue'),
});
export type PortPair = z.infer<typeof PortPair>;

export const Site = z.object({
  id: z.string().uuid(),
  slug: Slug,
  /** Human-friendly name shown in the UI. */
  displayName: z.string().min(1).max(120),
  runtime: Runtime,
  /** The flavour the site was created from, if any (drives UI hints only). */
  preset: z.enum(['wordpress']).nullable().default(null),
  domains: z.array(Hostname).max(50).default([]),
  source: SiteSource,
  manifest: SiteManifest,
  ports: PortPair.nullable().default(null),
  /**
   * Public port that reaches this site without a domain, as
   * `http://<server-ip>:<previewPort>`. Null only for sites created before
   * preview ports existed, or when the band is exhausted.
   */
  previewPort: z.number().int().min(1024).max(65535).nullable().default(null),
  /** Names only; values live encrypted in the vault, keyed by site id. */
  envVarNames: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** Bytes. Enforced by the file manager and reported on the site page. */
  diskQuotaBytes: z.number().int().positive().default(20 * 1024 * 1024 * 1024),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Site = z.infer<typeof Site>;

export const DeploymentStatus = z.enum([
  'queued',
  'preparing',
  'building',
  'healthchecking',
  'switching',
  'succeeded',
  // The files arrived and built, but the site cannot run until the user says
  // which file starts it or which folder to serve. Not a failure: the code is
  // published, and the answer is only knowable by looking at the files.
  'needs-setup',
  'failed',
  'cancelled',
  'rolledback',
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const Deployment = z.object({
  id: z.string().uuid(),
  siteId: z.string().uuid(),
  /** Release folder name, a sortable timestamp. */
  releaseId: z.string().min(1),
  status: DeploymentStatus,
  /** Git commit SHA, when deployed from git. */
  commit: z.string().max(64).nullable().default(null),
  /** Which colour this release was started on. */
  targetColour: z.enum(['blue', 'green']),
  jobId: z.string().uuid().nullable().default(null),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
});
export type Deployment = z.infer<typeof Deployment>;
