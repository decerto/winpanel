import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupScheduler,
  SCHEDULE_ATTEMPT_LIMIT,
  deleteBackupArchive,
  describeBackupSchedule,
  pruneFrequencyBackups,
  startOfNextPeriod,
  writeBackupSchedule,
  type BackupFrequency,
} from '../src/backups/service.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import { JobQueue } from '../src/jobs/queue.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let queue: JobQueue;
let scheduler: BackupScheduler;

function backupJobs() {
  return handle.db.select().from(schema.jobs).where(eq(schema.jobs.kind, 'backup')).all();
}

function scheduledJobs(frequency: BackupFrequency) {
  return backupJobs().filter(
    (job) => (job.payload as { frequency?: string } | null)?.frequency === frequency,
  );
}

function setStatus(jobId: string, status: string, errorMessage: string | null = null): void {
  handle.db
    .update(schema.jobs)
    .set({ status, errorMessage, finishedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
    .run();
}

/** A finished automatic snapshot, and the archive file it left behind. */
async function completedSnapshot(
  frequency: BackupFrequency,
  periodKey: string,
  createdAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  handle.db
    .insert(schema.jobs)
    .values({
      id,
      kind: 'backup',
      title: `${frequency} panel backup`,
      status: 'succeeded',
      payload: {
        scope: 'panel',
        operation: 'create',
        frequency,
        periodKey,
        includeGameServers: false,
        includeDependencies: false,
      },
      createdAt,
      finishedAt: createdAt,
    })
    .run();

  const file = path.join(tmpDir, 'backups', 'panel', `${id}.tar.gz`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'archive');
  return id;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-backup-schedule-'));
  handle = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(handle, MIGRATIONS);
  queue = new JobQueue(handle);
  scheduler = new BackupScheduler(handle, queue);
  writeBackupSchedule(handle, {
    daily: true,
    weekly: false,
    monthly: false,
    includeGameServers: false,
    includeDependencies: false,
  });
});

afterEach(async () => {
  scheduler.stop();
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('automatic panel snapshots', () => {
  it('queues one snapshot per period and moves on to the next day', async () => {
    await scheduler.checkNow(new Date(2026, 7, 26, 9, 0));
    await scheduler.checkNow(new Date(2026, 7, 26, 23, 59));
    expect(scheduledJobs('daily')).toHaveLength(1);

    await scheduler.checkNow(new Date(2026, 7, 27, 0, 5));
    expect(scheduledJobs('daily')).toHaveLength(2);
  });

  /**
   * The bug this page was rebuilt for: a job existing was treated as the
   * period being handled, so the first failure of the day stood in for a
   * snapshot and the schedule silently produced nothing.
   */
  it('retries a period whose snapshot failed', async () => {
    await scheduler.checkNow(new Date(2026, 7, 26, 9, 0));
    setStatus(scheduledJobs('daily')[0]!.id, 'failed', 'The disk is full.');

    await scheduler.checkNow(new Date(2026, 7, 26, 9, 15));
    expect(scheduledJobs('daily')).toHaveLength(2);
  });

  it('stops retrying a period once it has used up its attempts', async () => {
    for (let attempt = 0; attempt < SCHEDULE_ATTEMPT_LIMIT + 2; attempt += 1) {
      await scheduler.checkNow(new Date(2026, 7, 26, 9, attempt));
      for (const job of scheduledJobs('daily')) setStatus(job.id, 'failed', 'Nope.');
    }

    expect(scheduledJobs('daily')).toHaveLength(SCHEDULE_ATTEMPT_LIMIT);
    const report = describeBackupSchedule(handle, new Date(2026, 7, 26, 12, 0));
    const daily = report.slots.find((slot) => slot.frequency === 'daily')!;
    expect(daily.givenUpThisPeriod).toBe(true);
    expect(daily.lastRun?.error).toBe('Nope.');
    expect(daily.nextRunAt).toEqual(new Date(2026, 7, 27, 0, 0, 0, 0));
  });

  it('does not queue a snapshot for a schedule that is switched off', async () => {
    writeBackupSchedule(handle, {
      daily: false,
      weekly: false,
      monthly: false,
      includeGameServers: false,
      includeDependencies: false,
    });

    await scheduler.checkNow(new Date(2026, 7, 26, 9, 0));
    expect(backupJobs()).toHaveLength(0);
  });

  it('carries the archive options from the saved schedule', async () => {
    writeBackupSchedule(handle, {
      daily: true,
      weekly: false,
      monthly: false,
      includeGameServers: true,
      includeDependencies: true,
    });

    await scheduler.checkNow(new Date(2026, 7, 26, 9, 0));
    expect(scheduledJobs('daily')[0]!.payload).toMatchObject({
      includeGameServers: true,
      includeDependencies: true,
    });
  });
});

describe('when the next snapshot is due', () => {
  it('counts from the start of the next period', () => {
    const wednesday = new Date(2026, 7, 26, 14, 30);
    expect(startOfNextPeriod(wednesday, 'daily')).toEqual(new Date(2026, 7, 27, 0, 0, 0, 0));
    expect(startOfNextPeriod(wednesday, 'weekly')).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0));
    expect(startOfNextPeriod(wednesday, 'monthly')).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
  });

  it('treats a Sunday as the last day of its week', () => {
    const sunday = new Date(2026, 7, 30, 22, 0);
    expect(sunday.getDay()).toBe(0);
    expect(startOfNextPeriod(sunday, 'weekly')).toEqual(new Date(2026, 7, 31, 0, 0, 0, 0));
  });

  it('reports a newly enabled schedule as due now', () => {
    const now = new Date(2026, 7, 26, 14, 30);
    const daily = describeBackupSchedule(handle, now).slots.find(
      (slot) => slot.frequency === 'daily',
    )!;

    expect(daily.dueNow).toBe(true);
    expect(daily.nextRunAt).toEqual(now);
    expect(daily.lastRun).toBeNull();
  });

  it('reports the next run and the snapshot each schedule holds', async () => {
    const created = new Date(2026, 7, 26, 0, 10);
    const id = await completedSnapshot('daily', '2026-08-26', created);

    const report = describeBackupSchedule(handle, new Date(2026, 7, 26, 14, 30));
    const daily = report.slots.find((slot) => slot.frequency === 'daily')!;
    expect(daily.dueNow).toBe(false);
    expect(daily.nextRunAt).toEqual(new Date(2026, 7, 27, 0, 0, 0, 0));
    expect(daily.currentBackupId).toBe(id);
    expect(daily.lastSuccessAt).toEqual(created);

    const weekly = report.slots.find((slot) => slot.frequency === 'weekly')!;
    expect(weekly.enabled).toBe(false);
    expect(weekly.nextRunAt).toBeNull();
  });
});

describe('snapshot retention', () => {
  it('keeps only the newest snapshot of each frequency', async () => {
    const oldDaily = await completedSnapshot('daily', '2026-08-25', new Date(2026, 7, 25, 0, 10));
    const newDaily = await completedSnapshot('daily', '2026-08-26', new Date(2026, 7, 26, 0, 10));
    const weekly = await completedSnapshot('weekly', '2026-08-24', new Date(2026, 7, 24, 0, 10));

    const removed = await pruneFrequencyBackups(
      handle,
      path.join(tmpDir, 'backups'),
      'daily',
      newDaily,
    );

    expect(removed).toBe(1);
    const panelDir = path.join(tmpDir, 'backups', 'panel');
    await expect(fs.access(path.join(panelDir, `${oldDaily}.tar.gz`))).rejects.toThrow();
    await expect(fs.access(path.join(panelDir, `${newDaily}.tar.gz`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(panelDir, `${weekly}.tar.gz`))).resolves.toBeUndefined();
  });

  it('leaves a snapshot that is still being written', async () => {
    const pending = await completedSnapshot('daily', '2026-08-26', new Date(2026, 7, 26, 0, 10));
    setStatus(pending, 'running');

    const removed = await pruneFrequencyBackups(
      handle,
      path.join(tmpDir, 'backups'),
      'daily',
      crypto.randomUUID(),
    );

    expect(removed).toBe(0);
  });
});

describe('deleting a snapshot', () => {
  it('removes the archive and says so when it had already gone', async () => {
    const id = await completedSnapshot('daily', '2026-08-26', new Date(2026, 7, 26, 0, 10));
    const backupDir = path.join(tmpDir, 'backups');

    await expect(deleteBackupArchive(backupDir, 'panel', id)).resolves.toBe(true);
    await expect(deleteBackupArchive(backupDir, 'panel', id)).resolves.toBe(false);
  });

  it('refuses an identifier that is not a backup id', async () => {
    await expect(
      deleteBackupArchive(path.join(tmpDir, 'backups'), 'panel', '../../panel/data'),
    ).rejects.toThrow(/not valid/i);
  });
});
