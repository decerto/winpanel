import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseHandle } from '../db/index.js';
import { jobs, settings, sites } from '../db/schema.js';
import { listAllDatabases, listDatabasesForSite, type DatabaseSummary } from '../databases/store.js';
import { readDatabasePassword } from '../databases/secrets.js';
import { engineBinDir, engineDataDir } from '../databases/types.js';
import { withMongo } from '../databases/mongodb.js';
import { findExecutable } from '../components/archive.js';
import { runCommand, runDetached } from '../process/run-command.js';
import type { JobContext, JobQueue } from '../jobs/queue.js';
import {
  listPanelServices,
  sortForStartup,
  startPanelService,
  startSupportingServices,
  stopSupportingServices,
} from '../windows/panel-services.js';
import { createServiceRecovery } from '../windows/watched-services.js';

export const BackupFrequency = z.enum(['daily', 'weekly', 'monthly']);
export type BackupFrequency = z.infer<typeof BackupFrequency>;

export const BackupPayload = z.object({
  scope: z.enum(['site', 'panel']),
  operation: z.enum(['create', 'restore']).default('create'),
  siteId: z.string().uuid().optional(),
  backupId: z.string().uuid().optional(),
  frequency: BackupFrequency.optional(),
  periodKey: z.string().max(32).optional(),
});
export type BackupPayload = z.infer<typeof BackupPayload>;

export const BackupSchedule = z.object({
  daily: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
});
export type BackupSchedule = z.infer<typeof BackupSchedule>;

const DEFAULT_SCHEDULE: BackupSchedule = { daily: true, weekly: false, monthly: false };
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

export interface BackupArchive {
  id: string;
  scope: 'site' | 'panel';
  sizeBytes: number;
  createdAt: Date;
}

export interface BackupServiceOptions {
  db: DatabaseHandle;
  vault: import('../security/vault.js').SecretVault;
  root: string;
  dataDir: string;
  sitesRoot: string;
  gameServersRoot: string;
  binDir: string;
  backupDir: string;
}

function archivePath(backupDir: string, scope: 'site' | 'panel', id: string): string {
  if (!BACKUP_ID.test(id)) throw new Error('That backup identifier is not valid.');
  const folder = scope === 'site' ? 'websites' : 'panel';
  const extension = scope === 'site' ? 'zip' : 'tar.gz';
  return path.join(backupDir, folder, `${id}.${extension}`);
}

export function backupFilePath(
  backupDir: string,
  scope: 'site' | 'panel',
  id: string,
): string {
  return archivePath(backupDir, scope, id);
}

async function exists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(() => true, () => false);
}

function archiveEntry(filePath: string): { parent: string; name: string } {
  return { parent: path.dirname(filePath), name: path.basename(filePath) };
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

async function withSupportingServicesStopped(
  options: BackupServiceOptions,
  ctx: JobContext,
  operation: () => Promise<void>,
): Promise<void> {
  const services = await listPanelServices();
  const recovery = createServiceRecovery(options.db);
  const restart = services.filter((service) => service.kind !== 'panel' && service.state !== 'stopped');
  let operationError: unknown;

  try {
    const stopped = await stopSupportingServices(services, { unblock: recovery.unblock });
    if (stopped.failed.length > 0) {
      throw new Error(
        `Could not stop ${stopped.failed[0]?.label ?? 'a panel service'} before creating the backup.`,
      );
    }
    await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const failed: string[] = [];
    for (const service of restart) {
      if (
        !(await startPanelService(service.id, { unblock: recovery.unblock }))
      ) {
        failed.push(service.label);
      }
    }

    if (failed.length > 0 && operationError === undefined) {
      throw new Error(`Could not restart ${failed.join(', ')} after creating the backup.`);
    }
    if (failed.length > 0) {
      ctx.log(`Could not restart ${failed.join(', ')} after the backup operation.`, 'error');
    }
  }
}

async function createArchive(
  output: string,
  entries: readonly string[],
  format: 'zip' | 'tar.gz',
): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const present = entries.filter((entry) => entry.length > 0);
  if (present.length === 0) throw new Error('There is no data available to back up.');

  const result = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-a', '-c', '-f', output, ...present.flatMap((entry) => {
      const part = archiveEntry(entry);
      return ['-C', part.parent, part.name];
    })],
    timeoutMs: 60 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `The ${format} archive could not be created. ${result.stderr.trim() || 'The archive tool returned no details.'}`,
    );
  }
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  const listing = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-tf', archive],
    timeoutMs: 60 * 60 * 1000,
  });
  if (listing.exitCode !== 0) {
    throw new Error(
      `The backup could not be inspected. ${listing.stderr.trim() || 'The archive tool returned no details.'}`,
    );
  }

  for (const entry of listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const normalised = entry.replaceAll('\\', '/');
    if (
      normalised.startsWith('/') ||
      /^[a-zA-Z]:\//.test(normalised) ||
      normalised === '..' ||
      normalised.startsWith('../') ||
      normalised.includes('/../')
    ) {
      throw new Error('The backup contains an unsafe file path and was not restored.');
    }
  }

  await fs.mkdir(destination, { recursive: true });
  const result = await runCommand({
    exe: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['-xf', archive, '-C', destination],
    timeoutMs: 60 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `The backup could not be opened. ${result.stderr.trim() || 'The archive tool returned no details.'}`,
    );
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  const rootPath = await fs.realpath(root);
  const visit = async (current: string): Promise<void> => {
    const relative = path.relative(rootPath, await fs.realpath(current));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('The backup contains a file that points outside its archive.');
    }

    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error('The backup contains a symbolic link and was not restored.');
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
): Promise<void> {
  await withMongo(
    { username: record.username, password, authSource: record.name },
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
      await dumpMongoDatabase(record, password, output);
    } else {
      await dumpSqlDatabase(record, password, options.binDir, output);
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
          version: 1,
          createdAt: new Date().toISOString(),
          website: { slug: site.slug, displayName: site.displayName, domains: site.domains },
          databases: databaseDumps,
        },
        null,
        2,
      ),
      'utf8',
    );

    ctx.log('Compressing the website files and database exports.');
    await createArchive(output, [siteRoot, metadata, databaseDir], 'zip');
    ctx.progress(100);
    ctx.log('The website archive is ready to download.');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function createPanelArchive(
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  const workDir = path.join(options.backupDir, '.working', ctx.jobId);
  const metadata = path.join(workDir, 'winpanel-panel-backup.json');
  const output = archivePath(options.backupDir, 'panel', ctx.jobId);
  const siteRecords = options.db.db.select({ slug: sites.slug }).from(sites).all();
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
    await withSupportingServicesStopped(options, ctx, async () => {
      const panelEntries = await listPanelRootEntries(options);
      const panelDatabaseSnapshot = path.join(workDir, 'panel-database', 'panel.db');
      await fs.mkdir(path.dirname(panelDatabaseSnapshot), { recursive: true });
      await options.db.sqlite.backup(panelDatabaseSnapshot);

      const websiteManifest = siteRecords.map((site) => ({
        slug: site.slug,
        path: `${path.basename(options.sitesRoot)}/${site.slug}`,
      }));
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
        ...(await exists(options.gameServersRoot) ? [options.gameServersRoot] : []),
        path.dirname(panelDatabaseSnapshot),
        metadata,
      ];

      ctx.log(
        `Compressing the panel, ${websiteManifest.length} website${websiteManifest.length === 1 ? '' : 's'}, ` +
          `${databaseManifest.length} database${databaseManifest.length === 1 ? '' : 's'} and game servers.`,
      );
      await createArchive(output, entries, 'tar.gz');
      ctx.progress(100);
      ctx.log('The local panel backup is ready.');
    });
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
  serviceIds: readonly string[],
  panelEntries: readonly string[],
): string {
  const servicesJson = JSON.stringify(serviceIds);
  return `$ErrorActionPreference = 'Stop'
$work = ${powershellLiteral(workDir)}
$root = ${powershellLiteral(options.root)}
$backup = ${powershellLiteral(options.backupDir)}
$data = ${powershellLiteral(options.dataDir)}
$panelEntries = ConvertFrom-Json @'
${JSON.stringify(panelEntries)}
'@
$agent = 'winpanel-agent'
$targets = ConvertFrom-Json @'
${JSON.stringify([
  { source: path.join(workDir, path.basename(options.sitesRoot)), target: options.sitesRoot },
  { source: path.join(workDir, path.basename(options.gameServersRoot)), target: options.gameServersRoot },
])}
'@
$services = ConvertFrom-Json @'
${servicesJson}
'@
$log = Join-Path $work 'restore.log'

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
    if ([IO.Path]::GetFullPath($entry.FullName) -eq $backupPath) { continue }
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
    if (-not (Test-Path -LiteralPath $target.source)) { continue }
    Remove-Item -LiteralPath $target.target -Recurse -Force -ErrorAction SilentlyContinue
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
  & sc.exe start $agent *> $null
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $message = "[$([DateTime]::UtcNow.ToString('o'))] $($_.Exception.Message)"
  Set-Content -LiteralPath $log -Value $message -Encoding UTF8
  foreach ($service in $services) { & sc.exe start $service *> $null }
  & sc.exe start $agent *> $null
  exit 1
}
`;
}

async function restorePanelArchive(
  payload: BackupPayload,
  options: BackupServiceOptions,
  ctx: JobContext,
): Promise<void> {
  if (!payload.backupId) throw new Error('The restore request has no backup attached to it.');
  const archive = archivePath(options.backupDir, 'panel', payload.backupId);
  if (!(await exists(archive))) throw new Error('That panel backup is no longer available.');

  const workDir = path.join(options.backupDir, '.restore', ctx.jobId);
  const services = await listPanelServices();
  const recovery = createServiceRecovery(options.db);
  let stopped = false;
  let deferred = false;

  try {
    await fs.rm(workDir, { recursive: true, force: true });
    await extractArchive(archive, workDir);
    await validateExtractedTree(workDir);
    const metadataPath = path.join(workDir, 'winpanel-panel-backup.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as { format?: string };
    if (metadata.format !== 'winpanel-panel-backup') {
      throw new Error('That file is not a WinPanel panel backup.');
    }

    const stoppedReport = await stopSupportingServices(services, { unblock: recovery.unblock });
    if (stoppedReport.failed.length > 0) {
      throw new Error(
        `Could not stop ${stoppedReport.failed[0]?.label ?? 'a panel service'} before restoring.`,
      );
    }
    stopped = true;

    if (process.platform === 'win32') {
      const serviceIds = sortForStartup(services)
        .filter((service) => service.kind !== 'panel')
        .map((service) => service.id);
      const scriptPath = path.join(workDir, 'restore.ps1');
      await fs.writeFile(
        scriptPath,
        restoreScript(workDir, options, serviceIds, panelEntryNames(metadata)),
        'utf8',
      );
      ctx.progress(100);
      ctx.log('The restore is staged. The panel will restart while the saved state is applied.');
      runDetached({
        exe: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      });
      deferred = true;
      return;
    }

    const entries = panelEntryNames(metadata);
    const backupRoot = path.resolve(options.backupDir);
    for (const entry of await fs.readdir(options.root, { withFileTypes: true })) {
      const target = path.join(options.root, entry.name);
      if (path.resolve(target) === backupRoot || entries.includes(entry.name)) continue;
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

    for (const [sourceRoot, targetRoot] of [
      [options.sitesRoot, options.sitesRoot],
      [options.gameServersRoot, options.gameServersRoot],
    ] as const) {
      const source = path.join(workDir, path.basename(sourceRoot));
      if (!(await exists(source))) continue;
      await fs.rm(targetRoot, { recursive: true, force: true });
      await fs.cp(source, targetRoot, { recursive: true, force: true });
      void sourceRoot;
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
      if (stopped) await startSupportingServices(services, { unblock: recovery.unblock });
    }
  }

}

export function createBackupHandler(options: BackupServiceOptions) {
  return async (payload: unknown, ctx: JobContext): Promise<void> => {
    const parsed = BackupPayload.parse(payload);
    if (parsed.operation === 'restore') {
      if (parsed.scope !== 'panel') throw new Error('Only panel backups can be restored here.');
      await restorePanelArchive(parsed, options, ctx);
      return;
    }

    if (parsed.scope === 'site') {
      await createSiteArchive(parsed, options, ctx);
    } else {
      await createPanelArchive(options, ctx);
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

function scheduledBackupExists(
  db: DatabaseHandle,
  frequency: BackupFrequency,
  periodKey: string,
): boolean {
  return db.db
    .select({ id: jobs.id, status: jobs.status, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.kind, 'backup'))
    .all()
    .some((job) => {
      const payload = BackupPayload.safeParse(job.payload);
      return (
        payload.success &&
        payload.data.scope === 'panel' &&
        payload.data.operation === 'create' &&
        payload.data.frequency === frequency &&
        payload.data.periodKey === periodKey
      );
    });
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
      if (scheduledBackupExists(this.db, frequency, periodKey)) continue;

      this.jobs.enqueue({
        kind: 'backup',
        title: `${frequency[0]?.toUpperCase() ?? ''}${frequency.slice(1)} panel backup`,
        payload: { scope: 'panel', operation: 'create', frequency, periodKey },
        maxAttempts: 2,
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
