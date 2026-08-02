import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { JobQueue } from '../src/jobs/queue.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let queue: JobQueue;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-jobs-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  queue = new JobQueue(handle);
});

afterEach(async () => {
  await queue.stop();
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('JobQueue', () => {
  it('runs a job and records success', async () => {
    let ran = false;
    queue.register('health-check', async () => {
      ran = true;
    });

    const id = queue.enqueue({ kind: 'health-check', title: 'Check the server' });
    await queue.drain();

    expect(ran).toBe(true);
    expect(queue.getJob(id)?.status).toBe('succeeded');
    expect(queue.getJob(id)?.finishedAt).not.toBeNull();
  });

  it('passes the payload through to the handler', async () => {
    let seen: unknown;
    queue.register('deploy', async (payload) => {
      seen = payload;
    });

    queue.enqueue({ kind: 'deploy', title: 'Deploy', payload: { siteSlug: 'kitora', ref: 'main' } });
    await queue.drain();

    expect(seen).toEqual({ siteSlug: 'kitora', ref: 'main' });
  });

  it('captures log lines in order', async () => {
    queue.register('deploy', async (_payload, ctx) => {
      ctx.log('Installing packages', 'info', 'install');
      ctx.log('Building', 'info', 'build');
      ctx.log('Careful now', 'warn');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();

    const logs = queue.getLogs(id);
    expect(logs.map((l) => l.message)).toEqual([
      'Installing packages',
      'Building',
      'Careful now',
    ]);
    expect(logs[0]?.step).toBe('install');
    expect(logs[2]?.level).toBe('warn');
  });

  it('supports incremental log fetching for live streaming', async () => {
    queue.register('deploy', async (_payload, ctx) => {
      ctx.log('one');
      ctx.log('two');
      ctx.log('three');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();

    expect(queue.getLogs(id, 0).map((l) => l.message)).toEqual(['two', 'three']);
    expect(queue.getLogs(id, 2)).toHaveLength(0);
  });

  it('records progress', async () => {
    queue.register('deploy', async (_payload, ctx) => {
      ctx.progress(50);
      ctx.progress(100);
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();
    expect(queue.getJob(id)?.progress).toBe(100);
  });

  it('clamps out-of-range progress instead of storing nonsense', async () => {
    queue.register('deploy', async (_payload, ctx) => {
      ctx.progress(-20);
      expect(queue.getJob(ctx.jobId)?.progress).toBe(0);
      ctx.progress(500);
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();
    expect(queue.getJob(id)?.progress).toBe(100);
  });

  it('records failure with the error message', async () => {
    queue.register('deploy', async () => {
      throw new Error('The build step failed.');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();

    const job = queue.getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.errorMessage).toBe('The build step failed.');
    expect(queue.getLogs(id).some((l) => l.level === 'error')).toBe(true);
  });

  it('retries up to maxAttempts before giving up', async () => {
    let attempts = 0;
    queue.register('deploy', async () => {
      attempts++;
      throw new Error('flaky');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy', maxAttempts: 3 });
    await queue.drain();

    expect(attempts).toBe(3);
    expect(queue.getJob(id)?.status).toBe('failed');
  });

  it('succeeds if a retry works', async () => {
    let attempts = 0;
    queue.register('deploy', async () => {
      attempts++;
      if (attempts < 2) throw new Error('first attempt fails');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy', maxAttempts: 3 });
    await queue.drain();

    expect(attempts).toBe(2);
    expect(queue.getJob(id)?.status).toBe('succeeded');
  });

  it('cancels a pending job outright', async () => {
    queue.register('deploy', async () => {
      throw new Error('should never run');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    queue.requestCancel(id);
    await queue.drain();

    expect(queue.getJob(id)?.status).toBe('cancelled');
  });

  it('lets a running handler observe cancellation', async () => {
    let sawCancellation = false;
    queue.register('deploy', async (_payload, ctx) => {
      queue.requestCancel(ctx.jobId);
      sawCancellation = ctx.isCancelled();
      ctx.throwIfCancelled();
      throw new Error('unreachable');
    });

    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });
    await queue.drain();

    expect(sawCancellation).toBe(true);
    expect(queue.getJob(id)?.status).toBe('cancelled');
  });

  it('fails cleanly when no handler is registered', async () => {
    const id = queue.enqueue({ kind: 'backup', title: 'Back up' });
    await queue.drain();

    const job = queue.getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.errorMessage).toContain('backup');
  });

  it('processes jobs in the order they were queued', async () => {
    const order: string[] = [];
    queue.register('deploy', async (payload) => {
      order.push((payload as { name: string }).name);
    });

    queue.enqueue({ kind: 'deploy', title: 'a', payload: { name: 'a' } });
    queue.enqueue({ kind: 'deploy', title: 'b', payload: { name: 'b' } });
    queue.enqueue({ kind: 'deploy', title: 'c', payload: { name: 'c' } });
    await queue.drain();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('never runs two jobs at once', async () => {
    // Deploys touch the filesystem, the Caddy config and Windows services.
    // Overlapping them would produce races that only appear in production.
    let active = 0;
    let maxActive = 0;

    queue.register('deploy', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
    });

    for (let i = 0; i < 4; i++) {
      queue.enqueue({ kind: 'deploy', title: `job ${i}` });
    }
    await queue.drain();

    expect(maxActive).toBe(1);
  });

  it('clears jobs stranded by a restart', async () => {
    queue.register('deploy', async () => {});
    const id = queue.enqueue({ kind: 'deploy', title: 'Deploy' });

    // Simulate the process dying mid-job.
    handle.sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);

    const recovered = queue.reconcileOrphans();
    expect(recovered).toBe(1);

    const job = queue.getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.errorMessage).toMatch(/restarted/i);
  });
});
