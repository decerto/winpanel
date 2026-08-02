import { z } from 'zod';
import { Runtime, SiteManifest } from './manifest.js';

/** URL-safe identifier used for folder names, service names, and Caddy `@id`s. */
export const Slug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers and hyphens.');
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

export const SourceKind = z.enum(['git', 'upload']);
export type SourceKind = z.infer<typeof SourceKind>;

export const GitSource = z.object({
  kind: z.literal('git'),
  url: z.string().url(),
  branch: z.string().min(1).max(120).default('main'),
  /** Subfolder within the repo, for repos containing several projects. */
  subdirectory: z.string().max(256).default(''),
});

export const UploadSource = z.object({
  kind: z.literal('upload'),
});

export const SiteSource = z.discriminatedUnion('kind', [GitSource, UploadSource]);
export type SiteSource = z.infer<typeof SiteSource>;

/**
 * Blue/green port pair. Only ever one active at a time — we swap the Caddy
 * upstream between them rather than load balancing, because socket.io needs
 * sticky sessions and round-robin would break it.
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
  domains: z.array(Hostname).max(50).default([]),
  source: SiteSource,
  manifest: SiteManifest,
  ports: PortPair.nullable().default(null),
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
