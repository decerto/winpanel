import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { SiteManifest, SiteSource, Slug, type DatabaseEngine } from '@winpanel/shared';
import { createDatabase, type DatabaseHandle, schema } from '../db/index.js';
import { backupUploads, jobs, settings, sites } from '../db/schema.js';
import { listAllDatabases, listDatabasesForSite, type DatabaseSummary } from '../databases/store.js';
import { readDatabasePassword } from '../databases/secrets.js';
import { adapterFor } from '../databases/registry.js';
import { engineBinDir, engineDataDir } from '../databases/types.js';
import { assertSafeDbName } from '../databases/names.js';
import { withMongo } from '../databases/mongodb.js';
import { findExecutable } from '../components/archive.js';
import { runCommand, runDetached } from '../process/run-command.js';
import type { JobContext, JobQueue } from '../jobs/queue.js';
import type { GameServerService } from '../game-servers/game-server-service.js';
import {
  detectNodeVersion,
  detectPackageManager,
  installArgs,
} from '../detect/detector.js';
import {
  discardPrevious,
  prepareStaging,
  promoteStaging,
  releaseFoldersFor,
  restorePrevious,
  waitForHealthy,
  withPnpmDefaults,
  type ReleaseFolders,
  type ToolPaths,
} from '../sites/deploy-pipeline.js';
import { waitForPhpPool } from '../sites/php.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { siteServiceId } from '../windows/panel-services.js';
import {
  listPanelServices,
  sortForStartup,
  startSupportingServices,
  stopSupportingServices,
  type PanelService,
} from '../windows/panel-services.js';
import { createServiceRecovery } from '../windows/watched-services.js';

export const BackupFrequency = z.enum(['daily', 'weekly', 'monthly']);
export type BackupFrequency = z.infer<typeof BackupFrequency>;

export const BackupPayload = z.object({
  scope: z.enum(['site', 'panel']),
  operation: z.enum(['create', 'restore']).default('create'),
  siteId: z.string().uuid().optional(),
  backupId: z.string().uuid().optional(),
  uploadedBackupId: z.string().uuid().optional(),
  requestedByUserId: z.string().uuid().optional(),
  frequency: BackupFrequency.optional(),
  periodKey: z.string().max(32).optional(),
  includeGameServers: z.boolean().default(false),
  includeDependencies: z.boolean().default(false),
  installDependencies: z.boolean().optional(),
});
export type BackupPayload = z.infer<typeof BackupPayload>;

export const BackupSchedule = z.object({
  daily: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
  includeGameServers: z.boolean().default(false),
  includeDependencies: z.boolean().default(false),
});
export type BackupSchedule = z.infer<typeof BackupSchedule>;

const DEFAULT_SCHEDULE: BackupSchedule = {
  daily: true,
  weekly: false,
  monthly: false,
  includeGameServers: false,
  includeDependencies: false,
};
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Attempts a period gets before the scheduler stops retrying it.
 *
 * A snapshot that fails because a disk filled up or a website folder was
 * renamed used to consume the whole day: the period was marked as handled the
 * moment a job existed, whatever became of it. Retrying a few times spaced by
 * the check interval covers the transient causes without looping forever on a
 * permanent one.
 */
export const SCHEDULE_ATTEMPT_LIMIT = 3;

/** Minimum time between successful automatic snapshots of each frequency. */
export const BACKUP_FREQUENCY_INTERVAL_MS: Record<BackupFrequency, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 0,
};

export interface BackupArchive {
  id: string;
  scope: 'site' | 'panel';
  sizeBytes: number;
  createdAt: Date;
}

export class BackupArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

export interface BackupDatabaseManifest {
  engine: DatabaseEngine;
  name: string;
  file: string;
  format: 'SQL' | 'newline-delimited JSON';
}

export interface WebsiteBackupMetadata {
  format: 'winpanel-website-backup';
  version: 1 | 2;
  createdAt: string;
  includeDependencies: boolean;
  website: { slug: string; displayName: string; domains: string[] };
  databases: BackupDatabaseManifest[];
}

export interface PanelBackupMetadata {
  format: 'winpanel-panel-backup';
  version: number;
  createdAt: string;
  panelEntries: string[];
  panelDatabase: string | null;
  websites: Array<{
    slug: string;
    path: string;
    sourceKind?: SiteSource['kind'];
    manifest?: ReturnType<typeof SiteManifest.parse>;
  }>;
  databases: Array<{
    engine: DatabaseEngine;
    name: string;
    siteId: string | null;
    siteSlug: string | null;
    storage: string;
  }>;
  includeGameServers: boolean;
  includeDependencies: boolean;
}

export interface PanelArchiveLayout {
  websitesRoot: string;
  gameServersRoot: string;
  databaseStorage: Record<DatabaseEngine, string>;
  protectedRootNames?: readonly string[];
}

const DEFAULT_PANEL_ARCHIVE_LAYOUT: PanelArchiveLayout = {
  websitesRoot: 'sites',
  gameServersRoot: 'game-servers',
  databaseStorage: {
    mariadb: 'data/database',
    postgres: 'data/postgres',
    mongodb: 'data/mongodb',
  },
};

function defaultPanelArchiveLayout(): PanelArchiveLayout {
  return DEFAULT_PANEL_ARCHIVE_LAYOUT;
}

export type BackupArchiveInspection =
  | {
      scope: 'site';
      includeDependencies: boolean;
      website: WebsiteBackupMetadata['website'];
      databases: BackupDatabaseManifest[];
      metadata: WebsiteBackupMetadata;
    }
  | {
      scope: 'panel';
      includeDependencies: boolean;
      metadata: PanelBackupMetadata;
    };

export interface BackupServiceOptions {
  db: DatabaseHandle;
  vault: import('../security/vault.js').SecretVault;
  root: string;
  dataDir: string;
  sitesRoot: string;
  gameServersRoot: string;
  binDir: string;
  backupDir: string;
  services?: Pick<ServiceManager, 'getState' | 'isInstalled' | 'start' | 'stop'>;
  panelServices?: {
    list: () => Promise<PanelService[]>;
    stop: typeof stopSupportingServices;
    start: typeof startSupportingServices;
  };
  runDetached?: typeof runDetached;
  tools?: ToolPaths;
  gameServers?: Pick<GameServerService, 'list' | 'catalogEntryFor'>;
  markIntentionallyStopped?: (id: string) => void;
  markIntentionallyStarted?: (id: string) => void;
}

function archivePath(backupDir: string, scope: 'site' | 'panel', id: string): string {
  if (!BACKUP_ID.test(id)) throw new Error('That backup identifier is not valid.');
  const folder = scope === 'site' ? 'websites' : 'panel';
  const extension = scope === 'site' ? 'zip' : 'tar.gz';
  return path.join(backupDir, folder, `${id}.${extension}`);
}

export function stagedBackupFilePath(
  backupDir: string,
  scope: 'site' | 'panel',
  id: string,
): string {
  if (!BACKUP_ID.test(id)) throw new Error('That backup identifier is not valid.');
  const extension = scope === 'site' ? 'zip' : 'tar.gz';
  return path.join(backupDir, '.uploads', `${id}.${extension}`);
}

export function backupFilePath(
  backupDir: string,
  scope: 'site' | 'panel',
  id: string,
): string {
  return archivePath(backupDir, scope, id);
}

export function panelArchiveLayout(
  options: Pick<BackupServiceOptions, 'root' | 'dataDir' | 'sitesRoot' | 'gameServersRoot' | 'backupDir'>,
): PanelArchiveLayout {
  return {
    websitesRoot: path.basename(options.sitesRoot),
    gameServersRoot: path.basename(options.gameServersRoot),
    protectedRootNames: [
      path.basename(options.sitesRoot),
      path.basename(options.gameServersRoot),
      path.basename(options.backupDir),
    ],
    databaseStorage: {
      mariadb: path.relative(options.root, engineDataDir(options.dataDir, 'mariadb')).replaceAll('\\', '/'),
      postgres: path.relative(options.root, engineDataDir(options.dataDir, 'postgres')).replaceAll('\\', '/'),
      mongodb: path.relative(options.root, engineDataDir(options.dataDir, 'mongodb')).replaceAll('\\', '/'),
    },
  };
}

const PANEL_RESTORE_RESULT_FOLDER = '.restore-results';

export function panelRestoreResultPath(backupDir: string, jobId: string): string {
  if (!BACKUP_ID.test(jobId)) throw new Error('That restore identifier is not valid.');
  return path.join(backupDir, PANEL_RESTORE_RESULT_FOLDER, `${jobId}.json`);
}

/** Applies completion markers written by the detached Windows restore script. */
export async function reconcilePanelRestoreResults(
  db: DatabaseHandle,
  backupDir: string,
): Promise<number> {
  const directory = path.join(backupDir, PANEL_RESTORE_RESULT_FOLDER);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let reconciled = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const jobId = entry.name.slice(0, -'.json'.length);
    if (!BACKUP_ID.test(jobId)) continue;

    const result = await fs
      .readFile(path.join(directory, entry.name), 'utf8')
      .then((contents) => JSON.parse(contents) as { status?: unknown; error?: unknown })
      .catch(() => null);
    if (result?.status !== 'succeeded' && result?.status !== 'failed') continue;

    const job = db.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const payload = BackupPayload.safeParse(job?.payload);
    if (
      job?.status === 'running' &&
      job.kind === 'backup' &&
      payload.success &&
      payload.data.scope === 'panel' &&
      payload.data.operation === 'restore'
    ) {
      db.db
        .update(jobs)
        .set({
          status: result.status,
          errorMessage: result.status === 'failed' && typeof result.error === 'string' ? result.error : null,
          finishedAt: new Date(),
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
        .run();
      reconciled += 1;
    }

    await fs.rm(path.join(directory, entry.name), { force: true });
  }

  return reconciled;
}

async function exists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(() => true, () => false);
}

function archiveEntry(filePath: string): { parent: string; name: string } {
  return { parent: path.dirname(filePath), name: path.basename(filePath) };
}

const MAX_ESTIMATED_ARCHIVE_ENTRIES = 100_000;

/**
 * Build caches, which the next deploy rebuilds from scratch.
 *
 * These are pure cost in a snapshot: they are large, they consist of enormous
 * numbers of small files, and they are the folders a running build is most
 * likely to be rewriting while the backup reads them.
 */
const EXCLUDED_FROM_BACKUP = [
  'node_modules/.cache',
  'node_modules/.vite',
  '.next/cache',
  '.nuxt/cache',
  '.angular/cache',
  '.parcel-cache',
  '.turbo',
];

/**
 * Installed dependencies. Excluded unless asked for: they are the bulk of the
 * files in a Node website, and a deployment reinstalls them from the lockfile.
 */
const DEPENDENCY_DIRECTORIES = ['node_modules'];

async function estimateArchiveEntries(entries: readonly string[]): Promise<number | undefined> {
  let total = 0;
  const pending: Array<{ filePath: string; directory: boolean }> = [];

  try {
    for (const entry of entries) {
      const stat = await fs.lstat(entry);
      pending.push({ filePath: entry, directory: stat.isDirectory() });
    }

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;

      total += 1;
      if (total > MAX_ESTIMATED_ARCHIVE_ENTRIES) return undefined;
      if (!current.directory) continue;

      const directory = await fs.opendir(current.filePath);
      try {
        for await (const child of directory) {
          if (total + pending.length + 1 > MAX_ESTIMATED_ARCHIVE_ENTRIES) return undefined;
          pending.push({
            filePath: path.join(current.filePath, child.name),
            directory: child.isDirectory() && !child.isSymbolicLink(),
          });
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    }

    return total;
  } catch {
    return undefined;
  }
}

async function listPanelRootEntries(options: BackupServiceOptions): Promise<string[]> {
  if (!(await exists(options.root))) throw new Error('The panel installation folder does not exist.');

  const excluded = new Set(
    [options.backupDir, options.sitesRoot, options.gameServersRoot].map((entry) => path.resolve(entry)),
  );
  const entries = await fs.readdir(options.root, { withFileTypes: true });
  return entries
    .map((entry) => path.join(options.root, entry.name))
    .filter((entry) => !excluded.has(path.resolve(entry)));
}

function reportSkipped(outcome: ArchiveOutcome, ctx: JobContext): void {
  if (outcome.skippedCount === 0) return;

  const examples = outcome.skipped.join(', ');
  ctx.log(
    `${outcome.skippedCount} item${outcome.skippedCount === 1 ? '' : 's'} changed while the backup was ` +
      `running and ${outcome.skippedCount === 1 ? 'was' : 'were'} left out: ${examples}` +
      `${outcome.skippedCount > outcome.skipped.length ? ', …' : ''}. Everything else was captured.`,
    'warn',
  );
}

function panelEntryNames(metadata: unknown): string[] {
  const candidate = (metadata as { panelEntries?: unknown } | null)?.panelEntries;
  if (Array.isArray(candidate)) {
    const names = candidate.filter(
      (entry): entry is string =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry !== '.' &&
        entry !== '..' &&
        path.basename(entry) === entry,
    );
    if (names.length === candidate.length) return names;
  }

  return ['bin', 'data', 'caddy', 'panel', 'logs'];
}

export interface ArchiveOutcome {
  /** Examples of paths that changed underneath the archive tool. */
  readonly skipped: readonly string[];
  readonly skippedCount: number;
}

/**
 * A file the archive tool stepped over, having recorded everything else.
 *
 * Backups run while the machine is serving, so a build, a log rotation or a
 * package manager can remove a file between the directory being read and that
 * file being opened. bsdtar reports it, carries on, and exits non-zero at the
 * end via "Error exit delayed from previous errors" — the archive it produced
 * is complete apart from that one path.
 */
const SKIPPED_ENTRY =
  /^tar(?:\.exe)?:\s*(.*?):\s*(?:cannot stat|could ?n[o']?t visit directory|cannot open|cannot read)/i;

/** The same thing one level up: a whole folder replaced by a deploy mid-run. */
const SKIPPED_DIRECTORY = /^tar(?:\.exe)?:\s*could not chdir to\s*'?([^']*)'?/i;

/**
 * A failure that ended the run, leaving a truncated or absent archive.
 *
 * This has to be told apart from the case above by the message, because bsdtar
 * exits 1 for both: refusing to open the output and skipping one file inside a
 * million-file tree are the same exit code.
 */
const FATAL_ARCHIVE_ERROR = /failed to open|no space left|write error|cannot write|disk full/i;

/** Long enough for a large installation; the previous hour was not. */
const ARCHIVE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_UNPACKED_BYTES = 512 * 1024 ** 3;
const MAX_ARCHIVE_LISTING_BYTES = 64 * 1024 * 1024;

export interface ArchiveOptions {
  readonly onProgress?: (percent: number) => void;
  /** Keep node_modules. Much slower, and only needed to restore without a redeploy. */
  readonly includeDependencies?: boolean;
  readonly signal?: AbortSignal;
}

export async function createArchive(
  output: string,
  entries: readonly string[],
  format: 'zip' | 'tar.gz',
  { onProgress, includeDependencies = false, signal }: ArchiveOptions = {},
): Promise<ArchiveOutcome> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const present = entries.filter((entry) => entry.length > 0);
  if (present.length === 0) throw new Error('There is no data available to back up.');

  const estimatedEntries = onProgress ? await estimateArchiveEntries(present) : undefined;
  let archivedEntries = 0;
  let lastProgress = 0;
  let fatal = false;
  let skippedCount = 0;
  const skipped: string[] = [];
  const diagnostics: string[] = [];
  const reportProgress = () => {
    const percent =
      estimatedEntries && estimatedEntries > 0
        ? Math.min(99, Math.round((archivedEntries / estimatedEntries) * 99))
        : Math.min(95, 5 + Math.floor(Math.log2(archivedEntries + 1) * 5));
    if (percent > lastProgress) {
      lastProgress = percent;
      onProgress?.(percent);
    }
  };

  const result = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: [
      '-a',
      '-c',
      '-v',
      '-f',
      output,
      // Only gzip takes this, and naming a module the format does not have is
      // itself an error, so a website .zip must not be given it.
      ...(format === 'tar.gz' ? ['--options', 'gzip:compression-level=1'] : []),
      ...[...EXCLUDED_FROM_BACKUP, ...(includeDependencies ? [] : DEPENDENCY_DIRECTORIES)].flatMap(
        (pattern) => ['--exclude', pattern],
      ),
      ...present.flatMap((entry) => {
        const part = archiveEntry(entry);
        return ['-C', part.parent, part.name];
      }),
    ],
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    signal,
    onOutput: (line, stream) => {
      const text = line.trim();
      if (!text) return;

      if (stream === 'stdout' || /^a\s/.test(text)) {
        archivedEntries += 1;
        reportProgress();
        return;
      }

      const skip = SKIPPED_ENTRY.exec(text) ?? SKIPPED_DIRECTORY.exec(text);
      if (skip) {
        skippedCount += 1;
        if (skipped.length < 5) skipped.push(skip[1]?.trim() || text);
        return;
      }

      if (FATAL_ARCHIVE_ERROR.test(text)) fatal = true;
      diagnostics.push(text);
      if (diagnostics.length > 20) diagnostics.shift();
    },
  });

  // An archive holding everything that still existed is the point of the
  // exercise; throwing away an hour of work over one vanished file is not.
  const usable = !result.timedOut && !fatal && archivedEntries > 0 && (await exists(output));
  if (!usable) {
    await fs.rm(output, { force: true }).catch(() => undefined);
    const detail = diagnostics.join('\n') || result.stderr.trim() || result.stdout.trim();
    const status = result.timedOut
      ? 'The archive tool ran out of time.'
      : `The archive tool exited with code ${result.exitCode}.`;
    throw new Error(
      `The ${format} archive could not be created. ${status} ${detail || 'The archive tool returned no details.'}`,
    );
  }

  onProgress?.(100);
  return { skipped, skippedCount };
}

const DATABASE_ENGINE = z.enum(['mariadb', 'postgres', 'mongodb']);
const BACKUP_DATABASE_MANIFEST = z.object({
  engine: DATABASE_ENGINE,
  name: z.string().min(1),
  file: z.string().min(1),
  format: z.string().min(1),
});
const WEBSITE_BACKUP_METADATA = z.object({
  format: z.literal('winpanel-website-backup'),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().min(1),
  includeDependencies: z.boolean().optional(),
  website: z.object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
    domains: z.array(z.string()).default([]),
  }),
  databases: z.array(BACKUP_DATABASE_MANIFEST).default([]),
});
const PANEL_BACKUP_METADATA = z.object({
  format: z.literal('winpanel-panel-backup'),
  version: z.number().int().min(1).max(2),
  createdAt: z.string().min(1),
  panelEntries: z.array(z.string()).optional(),
  panelDatabase: z.string().optional(),
  websites: z
    .array(
      z.object({
        slug: z.string().min(1),
        path: z.string().min(1),
        sourceKind: z.enum(['git', 'upload', 'blank']).optional(),
        manifest: z.unknown().optional(),
      }),
    )
    .default([]),
  databases: z
    .array(
      z.object({
        engine: DATABASE_ENGINE,
        name: z.string().min(1),
        siteId: z.string().uuid().nullable().optional().default(null),
        siteSlug: z.string().nullable().optional().default(null),
        storage: z.string().min(1),
      }),
    )
    .default([]),
  includeGameServers: z.boolean().default(false),
  includeDependencies: z.boolean().default(false),
});

function archiveRelativePath(root: string, value: string, label: string): string {
  const normalised = value.replaceAll('\\', '/');
  const parts = normalised.split('/');
  if (
    normalised.length === 0 ||
    normalised.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalised) ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new BackupArchiveError(`The backup contains an unsafe ${label} path.`);
  }

  const resolved = path.resolve(root, ...parts);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The backup contains an unsafe ${label} path.`);
  }
  return resolved;
}

async function requireArchiveFile(root: string, relative: string, label: string): Promise<void> {
  const target = archiveRelativePath(root, relative, label);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) throw new Error(`The backup is missing its ${label} file.`);
}

async function requireArchiveDirectory(root: string, relative: string, label: string): Promise<void> {
  const target = archiveRelativePath(root, relative, label);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`The backup is missing its ${label} folder.`);
}

function metadataError(scope: 'site' | 'panel' | 'website'): BackupArchiveError {
  return new BackupArchiveError(`That file is not a valid WinPanel ${scope} backup.`);
}

async function normaliseWebsiteMetadata(
  root: string,
  value: unknown,
): Promise<WebsiteBackupMetadata> {
  const parsed = WEBSITE_BACKUP_METADATA.safeParse(value);
  if (!parsed.success) throw metadataError('website');

  if (!Slug.safeParse(parsed.data.website.slug).success) throw metadataError('website');
  if (parsed.data.version === 2 && parsed.data.includeDependencies === undefined) {
    throw metadataError('website');
  }

  const includeDependencies = parsed.data.version === 1 ? false : parsed.data.includeDependencies!;
  const files = new Set<string>();
  const names = new Set<string>();
  const databases: BackupDatabaseManifest[] = [];

  for (const entry of parsed.data.databases) {
    try {
      assertSafeDbName(entry.name);
    } catch {
      throw metadataError('website');
    }

    const expectedFormat = entry.engine === 'mongodb' ? 'newline-delimited JSON' : 'SQL';
    if (entry.format !== expectedFormat) throw metadataError('website');

    const relative = entry.file.replaceAll('\\', '/');
    const parts = relative.split('/');
    if (parts.length !== 2 || parts[0] !== 'databases' || parts[1] === '') {
      throw metadataError('website');
    }
    const absolute = archiveRelativePath(root, relative, 'database');
    if (files.has(absolute) || names.has(entry.name)) throw metadataError('website');
    files.add(absolute);
    names.add(entry.name);
    await requireArchiveFile(root, relative, 'database export');
    databases.push({
      engine: entry.engine,
      name: entry.name,
      file: relative,
      format: expectedFormat,
    });
  }

  await requireArchiveDirectory(root, parsed.data.website.slug, 'website');
  return {
    format: 'winpanel-website-backup',
    version: parsed.data.version,
    createdAt: parsed.data.createdAt,
    includeDependencies,
    website: parsed.data.website,
    databases,
  };
}

async function normalisePanelMetadata(
  root: string,
  value: unknown,
  layout: PanelArchiveLayout = defaultPanelArchiveLayout(),
): Promise<PanelBackupMetadata> {
  const parsed = PANEL_BACKUP_METADATA.safeParse(value);
  if (!parsed.success) throw metadataError('panel');
  if (parsed.data.version === 2 && parsed.data.panelEntries === undefined) {
    throw metadataError('panel');
  }

  const panelEntries = parsed.data.panelEntries ?? panelEntryNames(parsed.data);
  if (
    panelEntries.length !== new Set(panelEntries).size ||
    panelEntries.some(
      (entry) =>
        entry.length === 0 ||
        entry === '.' ||
        entry === '..' ||
        entry.includes('/') ||
        entry.includes('\\'),
    )
  ) {
    throw metadataError('panel');
  }
  const protectedRootNames = new Set(layout.protectedRootNames ?? []);
  if (panelEntries.some((entry) => protectedRootNames.has(entry))) {
    throw metadataError('panel');
  }

  for (const entry of panelEntries) {
    const stat = await fs.stat(archiveRelativePath(root, entry, 'panel')).catch(() => null);
    if (!stat) throw metadataError('panel');
  }

  let panelDatabase: string | null = null;
  if (parsed.data.panelDatabase !== undefined) {
    const relative = parsed.data.panelDatabase.replaceAll('\\', '/');
    if (relative !== 'panel-database/panel.db') throw metadataError('panel');
    await requireArchiveFile(root, relative, 'panel database');
    panelDatabase = relative;
  }
  if (parsed.data.version === 2 && panelDatabase === null) throw metadataError('panel');

  const websites = parsed.data.websites.map((website) => {
    if (!Slug.safeParse(website.slug).success) throw metadataError('panel');
    const relative = website.path.replaceAll('\\', '/');
    if (relative !== `${layout.websitesRoot}/${website.slug}`) throw metadataError('panel');
    const target = archiveRelativePath(root, relative, 'website');
    const manifest = website.manifest === undefined ? undefined : SiteManifest.safeParse(website.manifest);
    if (manifest && !manifest.success) throw metadataError('panel');
    return {
      slug: website.slug,
      path: relative,
      sourceKind: website.sourceKind,
      manifest: manifest?.data,
      target,
    };
  });

  if (
    websites.length !== new Set(websites.map((website) => website.slug)).size ||
    websites.length !== new Set(websites.map((website) => website.path)).size
  ) {
    throw metadataError('panel');
  }
  for (const website of websites) {
    const stat = await fs.stat(website.target).catch(() => null);
    if (!stat?.isDirectory()) throw metadataError('panel');
  }

  const databases = parsed.data.databases.map((database) => {
    try {
      assertSafeDbName(database.name);
    } catch {
      throw metadataError('panel');
    }
    if (database.storage.replaceAll('\\', '/') !== layout.databaseStorage[database.engine]) {
      throw metadataError('panel');
    }
    const target = archiveRelativePath(root, database.storage, 'database storage');
    return {
      engine: database.engine,
      name: database.name,
      siteId: database.siteId ?? null,
      siteSlug: database.siteSlug ?? null,
      storage: database.storage.replaceAll('\\', '/'),
      target,
    };
  });

  if (
    databases.length !==
    new Set(databases.map((database) => `${database.engine}:${database.name}`)).size
  ) {
    throw metadataError('panel');
  }
  for (const database of databases) {
    const stat = await fs.stat(database.target).catch(() => null);
    if (!stat?.isDirectory()) throw metadataError('panel');
  }

  const websiteRoot = path.join(root, layout.websitesRoot);
  const websiteRootStat = await fs.stat(websiteRoot).catch(() => null);
  if (parsed.data.websites.length > 0 && !websiteRootStat?.isDirectory()) {
    throw metadataError('panel');
  }

  if (parsed.data.includeGameServers) {
    const gameServersRoot = path.join(root, layout.gameServersRoot);
    const gameServersStat = await fs.stat(gameServersRoot).catch(() => null);
    if (!gameServersStat?.isDirectory()) throw metadataError('panel');
  }

  return {
    format: 'winpanel-panel-backup',
    version: parsed.data.version,
    createdAt: parsed.data.createdAt,
    panelEntries,
    panelDatabase,
    websites: websites.map(({ target: _target, ...website }) => website),
    databases: databases.map(({ target: _target, ...database }) => database),
    includeGameServers: parsed.data.includeGameServers,
    includeDependencies: parsed.data.includeDependencies,
  };
}

/*
 * The code below deliberately restores only the site's live code folder. The
 * database row, secrets, domains and service configuration belong to the
 * current site and are not data an archive can replace.
 */
async function restoreArchiveFor(
  payload: BackupPayload,
  options: BackupServiceOptions,
  scope: 'site' | 'panel',
): Promise<{ archive: string; stagedUploadId: string | null }> {
  if (payload.uploadedBackupId) {
    if (!payload.requestedByUserId) {
      throw new Error('The uploaded backup restore has no requesting account.');
    }
    const upload = options.db.db
      .select()
      .from(backupUploads)
      .where(
        and(
          eq(backupUploads.id, payload.uploadedBackupId),
          eq(backupUploads.scope, scope),
          eq(backupUploads.ownerUserId, payload.requestedByUserId),
          gt(backupUploads.expiresAt, new Date()),
        ),
      )
      .get();
    if (!upload) throw new Error('That uploaded backup has expired or is no longer available.');

    const archive = stagedBackupFilePath(options.backupDir, scope, upload.id);
    if (!(await exists(archive))) throw new Error('That uploaded backup is no longer available.');
    if (scope === 'site' && payload.siteId !== upload.siteId) {
      throw new Error('That uploaded backup is not attached to this website.');
    }
    return { archive, stagedUploadId: upload.id };
  }

  if (!payload.backupId) throw new Error('The restore request has no backup attached to it.');
  const job = options.db.db.select().from(jobs).where(eq(jobs.id, payload.backupId)).get();
  const source = BackupPayload.safeParse(job?.payload);
  if (
    !job ||
    job.kind !== 'backup' ||
    job.status !== 'succeeded' ||
    !source.success ||
    source.data.operation !== 'create' ||
    source.data.scope !== scope ||
    (scope === 'site' && source.data.siteId !== payload.siteId) ||
    (scope === 'panel' && job.siteId !== null)
  ) {
    throw new Error('That backup is no longer available.');
  }
  const archive = archivePath(options.backupDir, scope, payload.backupId);
  if (!(await exists(archive))) throw new Error('That backup is no longer available.');
  return { archive, stagedUploadId: null };
}

async function discardStagedUpload(options: BackupServiceOptions, uploadId: string | null): Promise<void> {
  if (!uploadId) return;
  await fs.rm(stagedBackupFilePath(options.backupDir, 'site', uploadId), { force: true });
  await fs.rm(stagedBackupFilePath(options.backupDir, 'panel', uploadId), { force: true });
  options.db.db.delete(backupUploads).where(eq(backupUploads.id, uploadId)).run();
}

async function directoryOrNull(target: string): Promise<string | null> {
  const stat = await fs.stat(target).catch(() => null);
  return stat?.isDirectory() ? target : null;
}

async function restoredCodeFolder(
  extractedRoot: string,
  slug: string,
  targetKind: string,
): Promise<string> {
  return restoredCodeFolderAt(path.join(extractedRoot, slug), targetKind);
}

async function restoredCodeFolderAt(sourceRoot: string, targetKind: string): Promise<string> {
  const preferred = targetKind === 'git' ? ['release', 'public'] : ['public', 'release'];
  for (const name of preferred) {
    const candidate = await directoryOrNull(path.join(sourceRoot, name));
    if (candidate) return candidate;
  }
  throw new Error('The website backup does not contain a public or release folder.');
}

async function installRestoredDependencies(
  codeRoot: string,
  manifest: ReturnType<typeof SiteManifest.parse>,
  archiveIncluded: boolean,
  installRequested: boolean | undefined,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  if (manifest.runtime !== 'node') {
    ctx.log(`Skipping Node dependency installation for this ${manifest.runtime} website.`);
    return;
  }

  const appDir = path.join(codeRoot, manifest.app.cwd);
  const packageJson = path.join(appDir, 'package.json');
  if (!(await exists(packageJson))) {
    ctx.log('The restored application has no package.json, so there are no Node dependencies to install.');
    return;
  }

  const dependencyFolder = path.join(appDir, 'node_modules');
  const dependencyFiles = ['.pnp.cjs', '.pnp.js'];
  const dependenciesPresent =
    (await exists(dependencyFolder)) || (await Promise.all(dependencyFiles.map((file) => exists(path.join(appDir, file))))).some(Boolean);

  if (archiveIncluded && dependenciesPresent) {
    ctx.log('The backup includes the application dependencies, so installation is not needed.');
    return;
  }

  if (!installRequested) {
    ctx.log(
      archiveIncluded
        ? 'The backup says dependencies were included, but no dependency folder was found. Installation was skipped.'
        : 'Dependencies were omitted from this backup. Installation was skipped because restore was told not to install them.',
      'warn',
    );
    return;
  }
  if (!options.tools) throw new Error('The panel cannot install dependencies during restore.');

  const manager =
    (await detectPackageManager(appDir)) ??
    (await detectPackageManager(codeRoot)) ??
    manifest.packageManager;
  const nodeVersion =
    manifest.nodeVersion ?? (await detectNodeVersion(appDir)) ?? (await detectNodeVersion(codeRoot)) ?? undefined;
  const tool = await options.tools.resolve(manager, nodeVersion);
  const invocation = {
    exe: tool.exe,
    args: [...tool.args, ...withPnpmDefaults(manager, installArgs(manager, false))],
  };

  ctx.log(
    `Installing dependencies with ${manager}${nodeVersion ? ` on Node ${nodeVersion}` : ''}...`,
    'info',
    'dependencies',
  );
  const result = await runCommand({
    ...invocation,
    cwd: appDir,
    env: { CI: '1', NODE_ENV: 'development' },
    timeoutMs: 20 * 60 * 1000,
    signal: ctx.signal,
    onOutput: (line) => {
      if (line.trim()) ctx.log(line, 'debug', 'dependencies');
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Dependency installation with ${manager} failed. ` +
        (result.stderr.trim() || result.stdout.trim() || 'The package manager returned no details.'),
    );
  }
  ctx.log(`Dependencies installed with ${manager}.`, 'info', 'dependencies');
}

type RestorablePanelWebsite = PanelBackupMetadata['websites'][number] & {
  sourceKind: SiteSource['kind'];
  manifest: ReturnType<typeof SiteManifest.parse>;
};

interface PanelSiteConfiguration {
  sourceKind: SiteSource['kind'];
  manifest: ReturnType<typeof SiteManifest.parse>;
}

function siteConfigurationMap(
  rows: Array<{ slug: string; runtime: string; source: unknown; manifest: unknown }>,
): Map<string, PanelSiteConfiguration> {
  const configurations = new Map<string, PanelSiteConfiguration>();
  for (const row of rows) {
    const source = SiteSource.safeParse(row.source);
    const manifestValue =
      row.manifest !== null && typeof row.manifest === 'object' && !Array.isArray(row.manifest)
        ? row.manifest
        : {};
    const manifest = SiteManifest.safeParse({ ...manifestValue, runtime: row.runtime });
    if (source.success && manifest.success) {
      configurations.set(row.slug, { sourceKind: source.data.kind, manifest: manifest.data });
    }
  }
  return configurations;
}

function readPanelArchiveSiteConfigurations(snapshot: string): Map<string, PanelSiteConfiguration> {
  let snapshotDb: DatabaseHandle | undefined;
  try {
    snapshotDb = createDatabase(snapshot);
    return siteConfigurationMap(
      snapshotDb.db
        .select({
          slug: schema.sites.slug,
          runtime: schema.sites.runtime,
          source: schema.sites.source,
          manifest: schema.sites.manifest,
        })
        .from(schema.sites)
        .all(),
    );
  } catch {
    return new Map();
  } finally {
    snapshotDb?.close();
  }
}

async function restorablePanelWebsites(
  metadata: PanelBackupMetadata,
  workDir: string,
  options: BackupServiceOptions,
): Promise<RestorablePanelWebsite[]> {
  const archived = metadata.panelDatabase
    ? readPanelArchiveSiteConfigurations(path.join(workDir, metadata.panelDatabase))
    : new Map<string, PanelSiteConfiguration>();
  const current = siteConfigurationMap(
    options.db.db
      .select({
        slug: schema.sites.slug,
        runtime: schema.sites.runtime,
        source: schema.sites.source,
        manifest: schema.sites.manifest,
      })
      .from(schema.sites)
      .all(),
  );

  return metadata.websites.map((website) => {
    const fallback = archived.get(website.slug) ?? current.get(website.slug);
    const sourceKind = website.sourceKind ?? fallback?.sourceKind;
    const manifest = website.manifest ?? fallback?.manifest;
    if (!sourceKind || !manifest) {
      throw new Error(
        `The panel backup does not contain enough information to install dependencies for ${website.slug}. ` +
          'Restore without dependency installation, or create a new panel backup.',
      );
    }
    return { ...website, sourceKind, manifest };
  });
}

async function installPanelDependencies(
  payload: BackupPayload,
  metadata: PanelBackupMetadata,
  workDir: string,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  if (!payload.installDependencies) {
    ctx.log(
      metadata.includeDependencies
        ? 'The panel backup includes website dependencies, so no dependency installation was requested.'
        : 'Website dependencies were omitted from the panel backup, so dependency installation was skipped.',
      'info',
      'dependencies',
    );
    return;
  }

  const websites = await restorablePanelWebsites(metadata, workDir, options);
  for (const website of websites) {
    ctx.throwIfCancelled();
    const siteRoot = archiveRelativePath(workDir, website.path, 'website');
    const codeRoot = await restoredCodeFolderAt(siteRoot, website.sourceKind);
    await installRestoredDependencies(
      codeRoot,
      website.manifest,
      metadata.includeDependencies,
      payload.installDependencies,
      options,
      ctx,
    );
  }
}

async function restoreSiteDatabases(
  metadata: WebsiteBackupMetadata,
  siteId: string,
  extractedRoot: string,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  const records = listDatabasesForSite(options.db, siteId);
  for (const entry of metadata.databases) {
    const record = records.find((candidate) => candidate.engine === entry.engine && candidate.name === entry.name);
    if (!record) {
      ctx.log(
        `Skipped the ${entry.engine} database ${entry.name}: it is not attached to this website now.`,
        'warn',
        'database',
      );
      continue;
    }

    const source = archiveRelativePath(extractedRoot, entry.file, 'database export');
    ctx.log(`Restoring the ${entry.engine} database ${entry.name}...`, 'info', 'database');
    await adapterFor(entry.engine).importDump(
      { db: options.db, vault: options.vault, binDir: options.binDir, signal: ctx.signal },
      { name: record.name, username: record.username, siteId: record.siteId },
      source,
    );
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(source, destination, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

async function restoreSiteService(
  site: typeof sites.$inferSelect,
  manifest: ReturnType<typeof SiteManifest.parse>,
  options: BackupServiceOptions,
  ctx: JobContext,
  wasRunning: boolean,
): Promise<void> {
  if (!wasRunning || manifest.runtime === 'static' || manifest.runtime === 'proxy') return;
  if (!options.services) {
    ctx.log('The website files were restored. Its service was not restarted because service control is unavailable.', 'warn');
    return;
  }

  const serviceId = siteServiceId(site.slug, site.activeColour);
  if (!(await options.services.isInstalled(serviceId))) {
    ctx.log(
      'The website files were restored, but no service is registered for this site. Deploy it once to start the application.',
      'warn',
    );
    return;
  }

  await options.services.start(serviceId);
  const port = site.activeColour === 'blue' ? site.portBlue : site.portGreen;
  if (port === null) throw new Error('The restored website has no application port assigned.');

  if (manifest.runtime === 'php') {
    await waitForPhpPool({
      basePort: port,
      timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
      log: (message) => ctx.log(message, 'info', 'health check'),
    });
  } else {
    await waitForHealthy({
      port,
      path: manifest.app.healthCheckPath,
      timeoutSeconds: manifest.app.healthCheckTimeoutSeconds,
      ctx,
    });
  }
}

async function restoreSiteArchive(
  payload: BackupPayload,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  if (!payload.siteId) throw new Error('The website restore has no website attached to it.');
  const site = options.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
  if (!site) throw new Error('That website no longer exists.');

  const { archive, stagedUploadId } = await restoreArchiveFor(payload, options, 'site');
  const workDir = path.join(options.backupDir, '.restore', ctx.jobId);
  let promoted = false;
  let movedPublic = false;
  let wasRunning = false;
  const manifest = SiteManifest.parse(site.manifest);
  const source = site.source as { kind?: string };
  const siteDir = path.join(options.sitesRoot, site.slug);
  const folders: ReleaseFolders = releaseFoldersFor(siteDir);
  const serviceId = siteServiceId(site.slug, site.activeColour);

  try {
    await fs.rm(workDir, { recursive: true, force: true });
    await extractArchive(archive, workDir, ctx.signal);
    await validateExtractedTree(workDir);
    const inspection = await inspectExtractedBackup(workDir, 'site');
    if (inspection.scope !== 'site') throw new Error('That file is not a valid website backup.');
    if (inspection.website.slug !== site.slug) {
      throw new Error('That website backup belongs to a different website.');
    }

    const codeFolder = await restoredCodeFolder(workDir, site.slug, source.kind ?? 'upload');
    const restoredCode = path.join(workDir, 'restored-code');
    await fs.cp(codeFolder, restoredCode, { recursive: true, force: true });
    await installRestoredDependencies(
      restoredCode,
      manifest,
      inspection.includeDependencies,
      payload.installDependencies,
      options,
      ctx,
    );

    const state = options.services ? await options.services.getState(serviceId) : 'not-installed';
    wasRunning = state === 'running' || state === 'starting';
    if (wasRunning) await options.services?.stop(serviceId);

    await restoreSiteDatabases(inspection.metadata, site.id, workDir, options, ctx);
    ctx.throwIfCancelled();

    if ((source.kind ?? 'upload') === 'git') {
      await prepareStaging(folders);
      await fs.cp(restoredCode, folders.staging, { recursive: true, force: true });
      await promoteStaging(folders);
      promoted = true;
    } else {
      const previousPublic = path.join(workDir, 'previous-public');
      if (await directoryOrNull(path.join(siteDir, 'public'))) {
        await moveDirectory(path.join(siteDir, 'public'), previousPublic);
        movedPublic = true;
      }
      await moveDirectory(restoredCode, path.join(siteDir, 'public'));
    }

    await restoreSiteService(site, manifest, options, ctx, wasRunning);
    if ((source.kind ?? 'upload') === 'git') await discardPrevious(folders);
    ctx.progress(100);
    ctx.log('The website files and matching databases were restored.');
  } catch (error) {
    if (promoted) {
      await options.services?.stop(serviceId).catch(() => undefined);
      if (await restorePrevious(folders).catch(() => false)) {
        await restoreSiteService(site, manifest, options, ctx, wasRunning).catch(() => undefined);
      }
    } else if (movedPublic) {
      await options.services?.stop(serviceId).catch(() => undefined);
      await moveDirectory(path.join(workDir, 'previous-public'), path.join(siteDir, 'public')).catch(() => undefined);
      await restoreSiteService(site, manifest, options, ctx, wasRunning).catch(() => undefined);
    } else if (wasRunning) {
      await restoreSiteService(site, manifest, options, ctx, true).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
    await discardStagedUpload(options, stagedUploadId);
  }
}

export async function inspectExtractedBackup(
  root: string,
  scope: 'site' | 'panel',
  layout?: PanelArchiveLayout,
): Promise<BackupArchiveInspection> {
  const metadataName = scope === 'site' ? 'winpanel-backup.json' : 'winpanel-panel-backup.json';
  const metadataPath = path.join(root, metadataName);
  const raw = await fs
    .readFile(metadataPath, 'utf8')
    .then((contents) => JSON.parse(contents) as unknown)
    .catch(() => {
      throw metadataError(scope);
    });

  if (scope === 'site') {
    const metadata = await normaliseWebsiteMetadata(root, raw);
    return {
      scope,
      includeDependencies: metadata.includeDependencies,
      website: metadata.website,
      databases: metadata.databases,
      metadata,
    };
  }

  const metadata = await normalisePanelMetadata(root, raw, layout);
  return { scope, includeDependencies: metadata.includeDependencies, metadata };
}

export async function inspectBackupArchive(
  archive: string,
  scope: 'site' | 'panel',
  destination: string,
  layout?: PanelArchiveLayout,
): Promise<BackupArchiveInspection> {
  await fs.rm(destination, { recursive: true, force: true });
  try {
    await extractArchive(archive, destination);
    await validateExtractedTree(destination);
    return await inspectExtractedBackup(destination, scope, layout);
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
}

async function extractArchive(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const listing = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-t', '-v', '-f', archive],
    timeoutMs: 60 * 60 * 1000,
    maxOutputBytes: MAX_ARCHIVE_LISTING_BYTES,
    signal,
  });
  if (listing.exitCode !== 0 || listing.truncated) {
    throw new BackupArchiveError(
      `The backup could not be inspected. ${
        listing.truncated
          ? 'Its file listing is too large to inspect safely.'
          : listing.stderr.trim() || 'The archive tool returned no details.'
      }`,
    );
  }

  const months = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  const entries = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new BackupArchiveError('The backup contains too many files to restore safely.');
  }

  let unpackedBytes = 0;
  for (const entry of entries) {
    const type = entry[0];
    if (type && ['b', 'c', 'h', 'l', 'p', 's'].includes(type.toLowerCase())) {
      throw new BackupArchiveError('The backup contains an unsupported link or device entry.');
    }

    const columns = entry.split(/\s+/);
  const monthIndex = columns.findIndex((column) => months.has(column));
  const isoIndex = columns.findIndex((column) => /^\d{4}-\d{2}-\d{2}$/.test(column));
  const dateIndex = monthIndex >= 0 ? monthIndex : isoIndex;
  const dateWidth = monthIndex >= 0 ? 3 : 2;
  const entryPath = dateIndex >= 0 ? columns.slice(dateIndex + dateWidth).join(' ') : '';
    if (!entryPath) {
      throw new BackupArchiveError('The backup contains an unreadable file entry.');
    }

    const size = dateIndex > 1
      ? Number.parseInt(columns.slice(1, dateIndex).findLast((column) => /^\d+$/.test(column)) ?? '', 10)
      : Number.NaN;
    if (Number.isFinite(size)) {
      unpackedBytes += size;
      if (unpackedBytes > MAX_ARCHIVE_UNPACKED_BYTES) {
        throw new BackupArchiveError('The backup expands beyond the safe restore size.');
      }
    }

    const normalised = entryPath.replaceAll('\\', '/');
    if (
      normalised.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalised) ||
      normalised === '..' ||
      normalised.startsWith('../') ||
      normalised.includes('/../')
    ) {
      throw new BackupArchiveError('The backup contains an unsafe file path and was not restored.');
    }
  }

  await fs.mkdir(destination, { recursive: true });
  const result = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-xf', archive, '-C', destination],
    timeoutMs: 60 * 60 * 1000,
    signal,
  });

  if (result.exitCode !== 0) {
    throw new BackupArchiveError(
      `The backup could not be opened. ${result.stderr.trim() || 'The archive tool returned no details.'}`,
    );
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  const rootPath = await fs.realpath(root);
  const visit = async (current: string): Promise<void> => {
    const relative = path.relative(rootPath, await fs.realpath(current));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new BackupArchiveError('The backup contains a file that points outside its archive.');
    }

    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new BackupArchiveError('The backup contains a symbolic link and was not restored.');
    }
    if (!stat.isDirectory()) return;

    for (const entry of await fs.readdir(current)) {
      await visit(path.join(current, entry));
    }
  };

  await visit(root);
}

function databaseFileName(record: DatabaseSummary): string {
  return `${record.engine}-${record.name}.dump`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function dumpSqlDatabase(
  record: DatabaseSummary,
  password: string,
  binDir: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const engineDir = engineBinDir(binDir, record.engine);
  const executable =
    record.engine === 'mariadb'
      ? await findExecutable(engineDir, ['mariadb-dump.exe', 'mysqldump.exe'])
      : await findExecutable(engineDir, ['pg_dump.exe']);

  if (!executable) {
    throw new Error(`The ${record.engine} export tool is not installed.`);
  }

  const result = await runCommand({
    exe: executable,
    args:
      record.engine === 'mariadb'
        ? [
            '--host=127.0.0.1',
            '--port=3306',
            `--user=${record.username}`,
            '--single-transaction',
            '--routines',
            '--triggers',
            `--result-file=${destination}`,
            '--databases',
            record.name,
          ]
        : [
            '--host=127.0.0.1',
            '--port=5432',
            `--username=${record.username}`,
            '--format=plain',
            '--no-owner',
            `--file=${destination}`,
            record.name,
          ],
    env: record.engine === 'mariadb' ? { MYSQL_PWD: password } : { PGPASSWORD: password },
    timeoutMs: 60 * 60 * 1000,
    signal,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${record.engine} could not export ${record.name}. ${result.stderr.trim() || 'The database tool returned no details.'}`,
    );
  }
}

async function dumpMongoDatabase(
  record: DatabaseSummary,
  password: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await withMongo(
    { username: record.username, password, authSource: record.name, signal },
    async (client) => {
      const database = client.db(record.name);
      const handle = await fs.open(destination, 'w');

      try {
        await handle.writeFile(
          `${JSON.stringify({ format: 'winpanel-mongodb-json', database: record.name })}\n`,
        );
        const collections = await database.listCollections({}, { nameOnly: true }).toArray();

        for (const collection of collections) {
          const cursor = database.collection(collection.name).find({});
          for await (const document of cursor) {
            await handle.writeFile(
              `${JSON.stringify({ collection: collection.name, document })}\n`,
            );
          }
        }
      } finally {
        await handle.close();
      }
    },
  );
}

async function dumpDatabases(
  records: readonly DatabaseSummary[],
  options: BackupServiceOptions,
  destination: string,
  ctx: JobContext,
): Promise<Array<{ engine: string; name: string; file: string; format: string }>> {
  const manifest: Array<{ engine: string; name: string; file: string; format: string }> = [];
  await fs.mkdir(destination, { recursive: true });

  for (const [index, record] of records.entries()) {
    ctx.throwIfCancelled();
    const password = readDatabasePassword(
      options.db,
      options.vault,
      record.engine,
      record.name,
      record.siteId,
    );
    if (!password) throw new Error(`The password for ${record.name} is not available to export it.`);

    const file = databaseFileName(record);
    const output = path.join(destination, file);
    if (record.engine === 'mongodb') {
      await dumpMongoDatabase(record, password, output, ctx.signal);
    } else {
      await dumpSqlDatabase(record, password, options.binDir, output, ctx.signal);
    }

    manifest.push({
      engine: record.engine,
      name: record.name,
      file: `databases/${file}`,
      format: record.engine === 'mongodb' ? 'newline-delimited JSON' : 'SQL',
    });
    ctx.progress(15 + ((index + 1) / Math.max(records.length, 1)) * 45);
  }

  return manifest;
}

async function createSiteArchive(
  payload: BackupPayload,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  if (!payload.siteId) throw new Error('The website backup has no website attached to it.');

  const site = options.db.db.select().from(sites).where(eq(sites.id, payload.siteId)).get();
  if (!site) throw new Error('That website no longer exists.');

  const siteRoot = path.join(options.sitesRoot, site.slug);
  if (!(await exists(siteRoot))) throw new Error('The website folder does not exist.');

  const workDir = path.join(options.backupDir, '.working', ctx.jobId);
  const databaseDir = path.join(workDir, 'databases');
  const metadata = path.join(workDir, 'winpanel-backup.json');
  const output = archivePath(options.backupDir, 'site', ctx.jobId);

  await fs.rm(workDir, { recursive: true, force: true });
  try {
    await fs.mkdir(databaseDir, { recursive: true });
    const records = listDatabasesForSite(options.db, site.id);
    ctx.log(`Packing ${records.length} website database${records.length === 1 ? '' : 's'}.`);
    const databaseDumps = await dumpDatabases(records, options, databaseDir, ctx);

    await fs.writeFile(
      metadata,
      JSON.stringify(
        {
          format: 'winpanel-website-backup',
          version: 2,
          createdAt: new Date().toISOString(),
          includeDependencies: payload.includeDependencies,
          website: { slug: site.slug, displayName: site.displayName, domains: site.domains },
          databases: databaseDumps,
        },
        null,
        2,
      ),
      'utf8',
    );

    ctx.log(
      payload.includeDependencies
        ? 'Compressing the website files, dependencies and database exports. Including dependencies takes considerably longer.'
        : 'Compressing the website files and database exports. Dependency folders are left out.',
    );
    const archived = await createArchive(output, [siteRoot, metadata, databaseDir], 'zip', {
      includeDependencies: payload.includeDependencies,
      signal: ctx.signal,
      onProgress: (percent) => {
        ctx.progress(60 + percent * 0.39);
      },
    });
    reportSkipped(archived, ctx);
    ctx.log('The website archive is ready to download.');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function createPanelArchive(
  options: BackupServiceOptions,
  ctx: JobContext,
  includeGameServers: boolean,
  includeDependencies: boolean,
): Promise<void> {
  const workDir = path.join(options.backupDir, '.working', ctx.jobId);
  const metadata = path.join(workDir, 'winpanel-panel-backup.json');
  const output = archivePath(options.backupDir, 'panel', ctx.jobId);
  const siteRecords = options.db.db
    .select({ slug: sites.slug, runtime: sites.runtime, source: sites.source, manifest: sites.manifest })
    .from(sites)
    .all();
  const sitePresence = await Promise.all(
    siteRecords.map(async (site) => ({ site, present: await exists(path.join(options.sitesRoot, site.slug)) })),
  );
  const missingSites = sitePresence
    .filter(({ present }) => !present)
    .map(({ site }) => site.slug);
  if (missingSites.length > 0) {
    throw new Error(`These websites are missing from disk: ${missingSites.join(', ')}.`);
  }

  const databaseRecords = listAllDatabases(options.db);
  const databaseRoots = [
    ...new Set(databaseRecords.map((record) => engineDataDir(options.dataDir, record.engine))),
  ];
  const databaseRootPresence = await Promise.all(
    databaseRoots.map(async (databaseRoot) => ({ databaseRoot, present: await exists(databaseRoot) })),
  );
  const missingDatabaseRoots = databaseRootPresence
    .filter(({ present }) => !present)
    .map(({ databaseRoot }) => databaseRoot);
  if (missingDatabaseRoots.length > 0) {
    throw new Error('A database storage folder is missing, so the panel backup was not created.');
  }

  await fs.rm(workDir, { recursive: true, force: true });
  try {
    await fs.mkdir(workDir, { recursive: true });
    ctx.log('Preparing the panel snapshot. Websites and services stay online.');
    ctx.progress(5);

    const panelEntries = await listPanelRootEntries(options);
    const panelDatabaseSnapshot = path.join(workDir, 'panel-database', 'panel.db');
    await fs.mkdir(path.dirname(panelDatabaseSnapshot), { recursive: true });
    // SQLite's own backup API, so the copy is consistent while the panel
    // keeps writing to the live database throughout.
    await options.db.sqlite.backup(panelDatabaseSnapshot);
    ctx.progress(10);

    const websiteManifest = siteRecords.map((site) => {
      const source = SiteSource.safeParse(site.source);
      const manifest = SiteManifest.safeParse({
        ...(site.manifest !== null && typeof site.manifest === 'object' && !Array.isArray(site.manifest)
          ? site.manifest
          : {}),
        runtime: site.runtime,
      });
      if (!source.success || !manifest.success) {
        throw new Error(`The panel has invalid configuration for website ${site.slug}.`);
      }

      return {
        slug: site.slug,
        path: `${path.basename(options.sitesRoot)}/${site.slug}`,
        sourceKind: source.data.kind,
        manifest: manifest.data,
      };
    });
    const databaseManifest = databaseRecords.map((record) => ({
      engine: record.engine,
      name: record.name,
      siteId: record.siteId,
      siteSlug: record.siteSlug,
      storage: path.relative(options.root, engineDataDir(options.dataDir, record.engine)),
    }));

    await fs.writeFile(
      metadata,
      JSON.stringify(
        {
          format: 'winpanel-panel-backup',
          version: 2,
          createdAt: new Date().toISOString(),
          panelEntries: panelEntries.map((entry) => path.basename(entry)),
          panelDatabase: 'panel-database/panel.db',
          websites: websiteManifest,
          databases: databaseManifest,
          includeGameServers,
          includeDependencies,
          roots: {
            panel: options.root,
            websites: options.sitesRoot,
            gameServers: options.gameServersRoot,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const entries = [
      ...panelEntries,
      ...(await exists(options.sitesRoot) ? [options.sitesRoot] : []),
      ...(includeGameServers && (await exists(options.gameServersRoot))
        ? [options.gameServersRoot]
        : []),
      path.dirname(panelDatabaseSnapshot),
      metadata,
    ];

    ctx.log(
      `Compressing the panel, ${websiteManifest.length} website${websiteManifest.length === 1 ? '' : 's'}, ` +
        `${databaseManifest.length} database${databaseManifest.length === 1 ? '' : 's'}` +
        `${includeGameServers ? ' and game servers' : ''}.` +
        `${includeDependencies ? ' Dependencies are included, which takes considerably longer.' : ''}`,
    );
    const archived = await createArchive(output, entries, 'tar.gz', {
      includeDependencies,
      signal: ctx.signal,
      onProgress: (percent) => {
        ctx.progress(10 + percent * 0.9);
      },
    });
    reportSkipped(archived, ctx);
    ctx.log('The local panel backup is ready.');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function restoreScript(
  workDir: string,
  options: BackupServiceOptions,
  jobId: string,
  serviceIds: readonly string[],
  panelEntries: readonly string[],
  protectedRootPaths: readonly string[],
  includeGameServers: boolean,
): string {
  const servicesJson = JSON.stringify(serviceIds);
  return `$ErrorActionPreference = 'Stop'
$work = ${powershellLiteral(workDir)}
$root = ${powershellLiteral(options.root)}
$backup = ${powershellLiteral(options.backupDir)}
$data = ${powershellLiteral(options.dataDir)}
$resultPath = ${powershellLiteral(panelRestoreResultPath(options.backupDir, jobId))}
$panelEntries = ConvertFrom-Json @'
${JSON.stringify(panelEntries)}
'@
$protectedRootPaths = ConvertFrom-Json @'
${JSON.stringify(protectedRootPaths)}
'@
$agent = 'winpanel-agent'
$targets = ConvertFrom-Json @'
${JSON.stringify([
  { source: path.join(workDir, path.basename(options.sitesRoot)), target: options.sitesRoot },
  ...(includeGameServers
    ? [{ source: path.join(workDir, path.basename(options.gameServersRoot)), target: options.gameServersRoot }]
    : []),
])}
'@
$services = ConvertFrom-Json @'
${servicesJson}
'@
$log = Join-Path $work 'restore.log'

function Write-RestoreResult([string] $status, [string] $errorMessage) {
  $resultDirectory = Split-Path -Parent $resultPath
  New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
  $temporary = "$resultPath.part"
  $result = @{ status = $status; error = $errorMessage } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $result, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $resultPath -Force
}

try {
  & sc.exe stop $agent *> $null
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $state = (& sc.exe query $agent 2>$null | Select-String 'STATE\s*:\s*(\d+)').Matches.Groups[1].Value
    if ($state -eq '1') { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($state -ne '1') { throw 'The panel service did not stop before the restore deadline.' }

  $backupPath = [IO.Path]::GetFullPath($backup)
  foreach ($entry in @(Get-ChildItem -LiteralPath $root -Force)) {
    $entryPath = [IO.Path]::GetFullPath($entry.FullName)
    if ($entryPath -eq $backupPath -or $protectedRootPaths -contains $entryPath) { continue }
    if ($panelEntries -notcontains $entry.Name) {
      Remove-Item -LiteralPath $entry.FullName -Recurse -Force
    }
  }

  foreach ($name in $panelEntries) {
    $source = Join-Path $work $name
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $target = Join-Path $root $name
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }

  foreach ($target in $targets) {
    Remove-Item -LiteralPath $target.target -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $target.source)) { continue }
    Copy-Item -LiteralPath $target.source -Destination $target.target -Recurse -Force
  }

  $panelDatabase = Join-Path $data 'panel.db'
  $panelDatabaseSnapshot = Join-Path $work 'panel-database\panel.db'
  if (Test-Path -LiteralPath $panelDatabaseSnapshot) {
    Remove-Item -LiteralPath ($panelDatabase + '-wal') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($panelDatabase + '-shm') -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $panelDatabaseSnapshot -Destination $panelDatabase -Force
  }

  foreach ($service in $services) { & sc.exe start $service *> $null }
  Write-RestoreResult 'succeeded' $null
  & sc.exe start $agent *> $null
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $message = "[$([DateTime]::UtcNow.ToString('o'))] $($_.Exception.Message)"
  Set-Content -LiteralPath $log -Value $message -Encoding UTF8
  foreach ($service in $services) { & sc.exe start $service *> $null }
  Write-RestoreResult 'failed' $message
  & sc.exe start $agent *> $null
  exit 1
}
`;
}

function servicesToResumeAfterRestore(
  services: readonly PanelService[],
  gameServers?: Pick<GameServerService, 'list'>,
): PanelService[] {
  const states = new Map(
    gameServers?.list()
      .filter((server) => server.serviceId)
      .map((server) => [server.serviceId!.toLowerCase(), server.state]),
  );

  return services.filter((service) => {
    if (service.kind !== 'game-server') return true;
    return (states.get(service.id.toLowerCase()) ?? service.state) === 'running';
  });
}

async function restorePanelArchive(
  payload: BackupPayload,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  const { archive, stagedUploadId } = await restoreArchiveFor(payload, options, 'panel');

  const workDir = path.join(options.backupDir, '.restore', ctx.jobId);
  const panelServices = options.panelServices ?? {
    list: listPanelServices,
    stop: stopSupportingServices,
    start: startSupportingServices,
  };
  const services = await panelServices.list();
  const resumableServices = servicesToResumeAfterRestore(services, options.gameServers);
  const recovery = createServiceRecovery(options.db, options.gameServers);
  let stopped = false;
  let deferred = false;

  try {
    await fs.rm(workDir, { recursive: true, force: true });
    await extractArchive(archive, workDir, ctx.signal);
    await validateExtractedTree(workDir);
    const inspection = await inspectExtractedBackup(workDir, 'panel', panelArchiveLayout(options));
    if (inspection.scope !== 'panel') throw new Error('That file is not a valid panel backup.');
    const metadata = inspection.metadata;

    await installPanelDependencies(payload, metadata, workDir, options, ctx);
    ctx.throwIfCancelled();

    const stoppedReport = await panelServices.stop(services, {
      unblock: recovery.unblock,
      markIntentionallyStopped: options.markIntentionallyStopped,
    });
    if (stoppedReport.failed.length > 0) {
      throw new Error(
        `Could not stop ${stoppedReport.failed[0]?.label ?? 'a panel service'} before restoring.`,
      );
    }
    stopped = true;

    if (process.platform === 'win32') {
      const serviceIds = sortForStartup(resumableServices)
        .filter((service) => service.kind !== 'panel')
        .map((service) => service.id);
      const scriptPath = path.join(workDir, 'restore.ps1');
      await fs.writeFile(
        scriptPath,
        restoreScript(
          workDir,
          options,
          ctx.jobId,
          serviceIds,
          panelEntryNames(metadata),
          [options.backupDir, options.sitesRoot, options.gameServersRoot].map((entry) => path.resolve(entry)),
          metadata.includeGameServers,
        ),
        'utf8',
      );
      ctx.progress(100);
      ctx.log('The restore is staged. The panel will restart while the saved state is applied.');
      (options.runDetached ?? runDetached)({
        exe: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      });
      await discardStagedUpload(options, stagedUploadId);
      ctx.defer?.();
      deferred = true;
      return;
    }

    const entries = panelEntryNames(metadata);
    const backupRoot = path.resolve(options.backupDir);
    const protectedRoots = new Set(
      [options.backupDir, options.sitesRoot, options.gameServersRoot].map((entry) => path.resolve(entry)),
    );
    for (const entry of await fs.readdir(options.root, { withFileTypes: true })) {
      const target = path.join(options.root, entry.name);
      if (path.resolve(target) === backupRoot || protectedRoots.has(path.resolve(target)) || entries.includes(entry.name)) continue;
      await fs.rm(target, { recursive: true, force: true });
    }

    for (const [index, name] of entries.entries()) {
      const source = path.join(workDir, name);
      const target = path.join(options.root, name);
      if (!(await exists(source))) continue;
      await fs.rm(target, { recursive: true, force: true });
      await fs.cp(source, target, { recursive: true, force: true });
      ctx.progress(20 + ((index + 1) / Math.max(entries.length, 1)) * 60);
    }

    const restoreRoots: Array<[string, string]> = [[options.sitesRoot, options.sitesRoot]];
    if (metadata.includeGameServers) {
      restoreRoots.push([options.gameServersRoot, options.gameServersRoot]);
    }
    for (const [sourceRoot, targetRoot] of restoreRoots) {
      const source = path.join(workDir, path.basename(sourceRoot));
      await fs.rm(targetRoot, { recursive: true, force: true });
      if (!(await exists(source))) continue;
      await fs.cp(source, targetRoot, { recursive: true, force: true });
    }

    const panelDatabaseSnapshot = path.join(workDir, 'panel-database', 'panel.db');
    if (await exists(panelDatabaseSnapshot)) {
      const panelDatabase = path.join(options.dataDir, 'panel.db');
      await fs.rm(`${panelDatabase}-wal`, { force: true });
      await fs.rm(`${panelDatabase}-shm`, { force: true });
      await fs.mkdir(path.dirname(panelDatabase), { recursive: true });
      await fs.copyFile(panelDatabaseSnapshot, panelDatabase);
    }

    ctx.progress(100);
    ctx.log('The panel state was restored. Restarting the panel to reopen its database.');
  } finally {
    if (!deferred) {
      await fs.rm(workDir, { recursive: true, force: true });
      await discardStagedUpload(options, stagedUploadId);
      if (stopped) {
        await panelServices.start(resumableServices, {
          unblock: recovery.unblock,
          markIntentionallyStarted: options.markIntentionallyStarted,
        });
      }
    }
  }

}

export function createBackupHandler(options: BackupServiceOptions) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const parsed = BackupPayload.parse(payload);
    if (parsed.operation === 'restore') {
      if (parsed.scope === 'panel') {
        await restorePanelArchive(parsed, options, ctx);
      } else {
        await restoreSiteArchive(parsed, options, ctx);
      }
      return;
    }

    if (parsed.scope === 'site') {
      await createSiteArchive(parsed, options, ctx);
      return;
    }

    await createPanelArchive(options, ctx, parsed.includeGameServers, parsed.includeDependencies);

    if (parsed.frequency) {
      const removed = await pruneFrequencyBackups(
        options.db,
        options.backupDir,
        parsed.frequency,
        ctx.jobId,
      );
      if (removed > 0) {
        ctx.log(
          `Removed ${removed} superseded ${parsed.frequency} snapshot${removed === 1 ? '' : 's'}. ` +
            `Each schedule keeps only its most recent snapshot.`,
        );
      }
    }
  };
}

function localPeriodKey(date: Date, frequency: BackupFrequency): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  if (frequency === 'monthly') return `${year}-${month}`;
  if (frequency === 'daily') return `${year}-${month}-${String(date.getDate()).padStart(2, '0')}`;

  const monday = new Date(year, date.getMonth(), date.getDate());
  const day = monday.getDay() || 7;
  monday.setDate(monday.getDate() - day + 1);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

export function readBackupSchedule(db: DatabaseHandle): BackupSchedule {
  const row = db.db.select().from(settings).where(eq(settings.key, 'backup.schedule')).get();
  const parsed = BackupSchedule.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_SCHEDULE;
}

export function writeBackupSchedule(db: DatabaseHandle, schedule: BackupSchedule): void {
  db.db
    .insert(settings)
    .values({ key: 'backup.schedule', value: schedule, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: schedule, updatedAt: new Date() },
    })
    .run();
}

/** The moment the next period begins, which is when the scheduler acts again. */
export function startOfNextPeriod(from: Date, frequency: BackupFrequency): Date {
  const year = from.getFullYear();
  const month = from.getMonth();
  const date = from.getDate();

  if (frequency === 'monthly') return new Date(year, month + 1, 1, 0, 0, 0, 0);
  if (frequency === 'daily') return new Date(year, month, date + 1, 0, 0, 0, 0);

  // Weeks begin on Monday, matching the key `localPeriodKey` builds.
  return new Date(year, month, date + (8 - (from.getDay() || 7)), 0, 0, 0, 0);
}

/** The earliest moment another successful snapshot of this frequency may run. */
export function nextScheduledBackupAt(lastRunAt: Date, frequency: BackupFrequency): Date {
  if (frequency !== 'monthly') {
    return new Date(lastRunAt.getTime() + BACKUP_FREQUENCY_INTERVAL_MS[frequency]);
  }

  // A month is a calendar month rather than an arbitrary thirty-day period.
  // Clamp the day so a snapshot taken on the 31st still gets a future run in
  // February instead of rolling into March.
  const next = new Date(lastRunAt);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

interface ScheduledAttempt {
  readonly jobId: string;
  readonly status: string;
  readonly periodKey: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly errorMessage: string | null;
}

/** Every automatic panel snapshot of one frequency, newest first. */
function scheduledAttempts(db: DatabaseHandle, frequency: BackupFrequency): ScheduledAttempt[] {
  return db.db
    .select()
    .from(jobs)
    .where(eq(jobs.kind, 'backup'))
    .all()
    .flatMap((job) => {
      const payload = BackupPayload.safeParse(job.payload);
      if (
        !payload.success ||
        payload.data.scope !== 'panel' ||
        payload.data.operation !== 'create' ||
        payload.data.frequency !== frequency
      ) {
        return [];
      }

      return [
        {
          jobId: job.id,
          status: job.status,
          periodKey: payload.data.periodKey ?? null,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
          errorMessage: job.errorMessage,
        },
      ];
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * True when this period needs nothing further from the scheduler.
 *
 * A failed attempt no longer settles the period. Treating one as "done" is why
 * a schedule could go days without producing anything while looking enabled:
 * the first failure of the day quietly stood in for the snapshot.
 */
function periodIsSettled(attempts: readonly ScheduledAttempt[], periodKey: string): boolean {
  const forPeriod = attempts.filter((attempt) => attempt.periodKey === periodKey);
  return (
    forPeriod.some(
      (attempt) =>
        attempt.status === 'pending' ||
        attempt.status === 'running' ||
        attempt.status === 'succeeded',
    ) ||
    forPeriod.filter((attempt) => attempt.status === 'failed').length >= SCHEDULE_ATTEMPT_LIMIT
  );
}

export interface BackupScheduleSlot {
  readonly frequency: BackupFrequency;
  readonly enabled: boolean;
  /** The day, week or month the scheduler is currently working on. */
  readonly periodKey: string;
  /** Enabled, and this period has no snapshot yet, so the next check starts one. */
  readonly dueNow: boolean;
  /** When the next automatic snapshot is expected. Null when switched off. */
  readonly nextRunAt: Date | null;
  readonly attemptsThisPeriod: number;
  readonly attemptLimit: number;
  /** Every attempt this period failed, and no more will be made until the next. */
  readonly givenUpThisPeriod: boolean;
  readonly lastRun: {
    readonly jobId: string;
    readonly status: string;
    readonly at: Date;
    readonly error: string | null;
  } | null;
  readonly lastSuccessAt: Date | null;
  /** The snapshot this slot holds, which the next successful run replaces. */
  readonly currentBackupId: string | null;
}

export interface BackupScheduleReport {
  readonly schedule: BackupSchedule;
  readonly slots: readonly BackupScheduleSlot[];
  /** How often the scheduler looks for work, so the panel can say so. */
  readonly checkIntervalMs: number;
}

/**
 * What the scheduler is about to do, and what came of the last time it ran.
 *
 * Derived from the job history rather than a separate bookkeeping table, so it
 * cannot drift away from the snapshots that actually exist.
 */
export function describeBackupSchedule(db: DatabaseHandle, now = new Date()): BackupScheduleReport {
  const schedule = readBackupSchedule(db);

  const slots = BackupFrequency.options.map((frequency): BackupScheduleSlot => {
    const attempts = scheduledAttempts(db, frequency);
    const periodKey = localPeriodKey(now, frequency);
    const thisPeriod = attempts.filter((attempt) => attempt.periodKey === periodKey);
    const settled = periodIsSettled(attempts, periodKey);
    const enabled = schedule[frequency];
    const succeeded = attempts.find((attempt) => attempt.status === 'succeeded');
    const last = attempts[0];
    const lastSuccessAt = succeeded ? (succeeded.finishedAt ?? succeeded.createdAt) : null;
    const nextIntervalAt = lastSuccessAt
      ? nextScheduledBackupAt(lastSuccessAt, frequency)
      : null;

    return {
      frequency,
      enabled,
      periodKey,
      dueNow:
        enabled &&
        !settled &&
        (nextIntervalAt === null || now.getTime() >= nextIntervalAt.getTime()),
      nextRunAt: !enabled
        ? null
        : settled
          ? new Date(
              Math.max(
                startOfNextPeriod(now, frequency).getTime(),
                nextIntervalAt?.getTime() ?? 0,
              ),
            )
          : nextIntervalAt && nextIntervalAt > now
            ? nextIntervalAt
            : now,
      attemptsThisPeriod: thisPeriod.length,
      attemptLimit: SCHEDULE_ATTEMPT_LIMIT,
      givenUpThisPeriod:
        enabled &&
        thisPeriod.filter((attempt) => attempt.status === 'failed').length >=
          SCHEDULE_ATTEMPT_LIMIT &&
        !thisPeriod.some(
          (attempt) =>
            attempt.status === 'pending' ||
            attempt.status === 'running' ||
            attempt.status === 'succeeded',
        ),
      lastRun: last
        ? {
            jobId: last.jobId,
            status: last.status,
            at: last.finishedAt ?? last.createdAt,
            error: last.errorMessage,
          }
        : null,
      lastSuccessAt,
      currentBackupId: succeeded?.jobId ?? null,
    };
  });

  return { schedule, slots, checkIntervalMs: SCHEDULER_INTERVAL_MS };
}

/** Removes one archive. Returns false when it had already gone. */
export async function deleteBackupArchive(
  backupDir: string,
  scope: 'site' | 'panel',
  id: string,
): Promise<boolean> {
  const file = archivePath(backupDir, scope, id);
  if (!(await exists(file))) return false;
  await fs.rm(file, { force: true });
  return true;
}

/**
 * Keeps one snapshot per frequency.
 *
 * Each schedule owns a slot: today's daily snapshot replaces yesterday's, this
 * week's replaces last week's. Without it a machine taking nightly snapshots of
 * itself eventually fills its own disk, which is a worse place to be than
 * having no snapshot at all. The job rows stay, so the run is still in the
 * activity history; only the archive on disk goes.
 */
export async function pruneFrequencyBackups(
  db: DatabaseHandle,
  backupDir: string,
  frequency: BackupFrequency,
  keepJobId: string,
): Promise<number> {
  let removed = 0;

  for (const attempt of scheduledAttempts(db, frequency)) {
    if (attempt.jobId === keepJobId) continue;
    if (attempt.status === 'pending' || attempt.status === 'running') continue;
    if (await deleteBackupArchive(backupDir, 'panel', attempt.jobId)) removed += 1;
  }

  return removed;
}

export class BackupScheduler {
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly jobs: JobQueue,
  ) {}

  start(): void {
    if (this.#timer) return;
    void this.checkNow();
    this.#timer = setInterval(() => void this.checkNow(), SCHEDULER_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async checkNow(now = new Date()): Promise<void> {
    const schedule = readBackupSchedule(this.db);
    for (const frequency of BackupFrequency.options) {
      if (!schedule[frequency]) continue;
      const periodKey = localPeriodKey(now, frequency);
      const attempts = scheduledAttempts(this.db, frequency);
      if (periodIsSettled(attempts, periodKey)) continue;

      const lastSuccess = attempts.find((attempt) => attempt.status === 'succeeded');
      if (
        lastSuccess &&
        now < nextScheduledBackupAt(lastSuccess.finishedAt ?? lastSuccess.createdAt, frequency)
      ) {
        continue;
      }

      this.jobs.enqueue({
        kind: 'backup',
        title: `${frequency[0]?.toUpperCase() ?? ''}${frequency.slice(1)} panel backup`,
        payload: {
          scope: 'panel',
          operation: 'create',
          frequency,
          periodKey,
          includeGameServers: schedule.includeGameServers,
          includeDependencies: schedule.includeDependencies,
        },
        // Retries belong to the scheduler, which spaces them out by its check
        // interval instead of restarting a multi-hour archive immediately.
        maxAttempts: 1,
      });
    }
  }
}

export async function listBackupArchives(
  backupDir: string,
  scope: 'site' | 'panel',
): Promise<BackupArchive[]> {
  const folder = path.join(backupDir, scope === 'site' ? 'websites' : 'panel');
  const extension = scope === 'site' ? '.zip' : '.tar.gz';
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const archives: BackupArchive[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const id = entry.name.slice(0, -extension.length);
    if (!BACKUP_ID.test(id)) continue;
    const stat = await fs.stat(path.join(folder, entry.name));
    archives.push({ id, scope, sizeBytes: stat.size, createdAt: stat.birthtime });
  }

  return archives.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
