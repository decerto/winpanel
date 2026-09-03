import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  panelRestoreResultPath,
  reconcilePanelRestoreResults,
} from '../src/backups/service.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import { JobQueue } from '../src/jobs/queue.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let queue: JobQueue;
const backupDir = () => path.join(tmpDir, 'backups');

function addRestoreJob(status: 'running' | 'pending' = 'running'): string {
  const id = crypto.randomUUID();
  handle.db
    .insert(schema.jobs)
    .values({
      id,
      kind: 'backup',
      title: 'Restoring a panel backup',
      status,
      payload: { scope: 'panel', operation: 'restore' },
    })
    .run();
  return id;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-backup-lifecycle-'));
  handle = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(handle, MIGRATIONS);
  queue = new JobQueue(handle);
});

afterEach(async () => {
  await queue.stop();
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('detached panel restore reconciliation', () => {
  it('marks a running restore successful from its completion marker', async () => {
    const jobId = addRestoreJob();
    const marker = panelRestoreResultPath(backupDir(), jobId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ status: 'succeeded', error: null }));

    expect(await reconcilePanelRestoreResults(handle, backupDir())).toBe(1);
    expect(queue.getJob(jobId)?.status).toBe('succeeded');
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('stores the detached script error when the marker reports failure', async () => {
    const jobId = addRestoreJob();
    const marker = panelRestoreResultPath(backupDir(), jobId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ status: 'failed', error: 'The panel did not start.' }));

    expect(await reconcilePanelRestoreResults(handle, backupDir())).toBe(1);
    expect(queue.getJob(jobId)).toMatchObject({
      status: 'failed',
      errorMessage: 'The panel did not start.',
    });
  });

  it('ignores an invalid marker and leaves the restore recoverable', async () => {
    const jobId = addRestoreJob();
    const marker = panelRestoreResultPath(backupDir(), jobId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ status: 'still-running' }));

    expect(await reconcilePanelRestoreResults(handle, backupDir())).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe('running');
    await expect(fs.access(marker)).resolves.toBeUndefined();
  });

  it('does not let orphan reconciliation overwrite a successful marker result', async () => {
    const jobId = addRestoreJob();
    const marker = panelRestoreResultPath(backupDir(), jobId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ status: 'succeeded' }));

    await reconcilePanelRestoreResults(handle, backupDir());
    expect(queue.reconcileOrphans()).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe('succeeded');
  });

  it('marks a restore interrupted when no completion marker exists', async () => {
    const jobId = addRestoreJob();

    expect(await reconcilePanelRestoreResults(handle, backupDir())).toBe(0);
    expect(queue.reconcileOrphans()).toBe(1);
    expect(queue.getJob(jobId)?.errorMessage).toMatch(/panel restarted/i);
  });

  it('does not reconcile a pending restore from a marker', async () => {
    const jobId = addRestoreJob('pending');
    const marker = panelRestoreResultPath(backupDir(), jobId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ status: 'succeeded' }));

    expect(await reconcilePanelRestoreResults(handle, backupDir())).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe('pending');
  });
});