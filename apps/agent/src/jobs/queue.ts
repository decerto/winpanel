import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { JobKind, JobStatus, LogLevel } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { jobLogs, jobs } from '../db/schema.js';

/**
 * A SQLite-backed job queue.
 *
 * Deliberately not BullMQ: that would mean running Redis, and a control panel
 * whose job system depends on a second service is a control panel that cannot
 * repair itself when that service is down. Everything here survives a restart
 * because it lives in the same database as the rest of the panel state.
 *
 * Jobs run one at a time by default. Deploys mutate the filesystem, the Caddy
 * config and Windows services; running two concurrently invites races that
 * only show up in production.
 */

export interface JobContext {
  readonly jobId: string;
  /** Appends a line to the job log, streamed live to the panel. */
  log: (message: string, level?: LogLevel, step?: string) => void;
  /** Updates the 0..100 progress indicator. */
  progress: (percent: number) => void;
  /** True once the user has asked to cancel. Handlers should check this. */
  isCancelled: () => boolean;
  /** Throws if cancellation was requested, to unwind a long handler. */
  throwIfCancelled: () => void;
  /** Aborts child processes that support cancellation. */
  signal?: AbortSignal;
  /** Leaves the job running while an external process finishes the work. */
  defer?: () => void;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'JobCancelledError';
  }
}

export interface EnqueueOptions {
  kind: JobKind;
  title: string;
  payload?: unknown;
  siteId?: string | null;
  gameServerId?: string | null;
  maxAttempts?: number;
}

type TransactionCallback = Parameters<DatabaseHandle['db']['transaction']>[0];
export type JobTransaction = TransactionCallback extends (transaction: infer T) => unknown
  ? T
  : never;

export class JobQueue extends EventEmitter {
  readonly #handlers = new Map<JobKind, JobHandler>();
  #running = false;
  #stopped = false;
  #pollTimer: NodeJS.Timeout | null = null;
  readonly #abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly pollIntervalMs = 500,
  ) {
    super();
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.#handlers.set(kind, handler);
  }

  enqueue(options: EnqueueOptions): string {
    return this.enqueueWithinTransaction((_transaction, enqueue) => enqueue(options));
  }

  /** Runs a synchronous check and one or more job inserts in one database transaction. */
  enqueueWithinTransaction<T>(
    work: (transaction: JobTransaction, enqueue: (options: EnqueueOptions) => string) => T,
  ): T {
    const enqueued: string[] = [];
    const result = this.handle.db.transaction((transaction) => {
      const enqueue = (options: EnqueueOptions): string => {
        const id = crypto.randomUUID();
        transaction
          .insert(jobs)
          .values({
            id,
            kind: options.kind,
            title: options.title,
            status: 'pending',
            payload: options.payload ?? null,
            siteId: options.siteId ?? null,
            gameServerId: options.gameServerId ?? null,
            maxAttempts: options.maxAttempts ?? 1,
          })
          .run();
        enqueued.push(id);
        return id;
      };

      return work(transaction, enqueue);
    });

    for (const jobId of enqueued) this.emit('enqueued', jobId);
    return result;
  }

  /** Marks a job for cancellation. The handler decides where to stop. */
  requestCancel(jobId: string): void {
    this.#abortControllers.get(jobId)?.abort();
    this.handle.db
      .update(jobs)
      .set({ cancelRequested: true })
      .where(eq(jobs.id, jobId))
      .run();

    // A job that has not started can be cancelled outright.
    this.handle.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'pending')))
      .run();
  }

  start(): void {
    if (this.#pollTimer) return;
    this.#stopped = false;
    this.#pollTimer = setInterval(() => {
      void this.#tick();
    }, this.pollIntervalMs);
    // Do not hold the process open purely for the poll timer.
    this.#pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    // Let an in-flight job finish rather than leaving a half-applied change.
    while (this.#running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Runs pending work until the queue is empty. Used by tests. */
  async drain(): Promise<void> {
    for (;;) {
      const worked = await this.#tick();
      if (!worked) return;
    }
  }

  async #tick(): Promise<boolean> {
    if (this.#running || this.#stopped) return false;

    // A deferred job owns the machine until its external completion marker is
    // reconciled after restart. Do not start another mutating job in the gap.
    const external = this.handle.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, 'running'))
      .limit(1)
      .get();
    if (external) return false;

    const next = this.handle.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'pending'))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .get();

    if (!next) return false;

    this.#running = true;
    try {
      await this.#run(next.id, next.kind as JobKind, next.payload);
    } finally {
      this.#running = false;
    }
    return true;
  }

  async #run(jobId: string, kind: JobKind, payload: unknown): Promise<void> {
    const handler = this.#handlers.get(kind);

    if (!handler) {
      this.#finish(jobId, 'failed', `No handler is registered for "${kind}".`);
      return;
    }

    this.handle.db
      .update(jobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(eq(jobs.id, jobId))
      .run();

    this.emit('started', jobId);

    let seq = 0;
    let deferred = false;
    const abortController = new AbortController();
    this.#abortControllers.set(jobId, abortController);
    const ctx: JobContext = {
      jobId,
      log: (message, level = 'info', step) => {
        this.handle.db
          .insert(jobLogs)
          .values({ jobId, seq: seq++, level, step: step ?? null, message })
          .run();
        this.emit('log', { jobId, message, level, step });
      },
      progress: (percent) => {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        this.handle.db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, jobId)).run();
        this.emit('progress', { jobId, progress: clamped });
      },
      isCancelled: () => this.#isCancelled(jobId),
      throwIfCancelled: () => {
        if (this.#isCancelled(jobId)) throw new JobCancelledError();
      },
      signal: abortController.signal,
      defer: () => {
        deferred = true;
      },
    };

    try {
      await handler(payload, ctx);
      if (!deferred) {
        this.#finish(jobId, this.#isCancelled(jobId) ? 'cancelled' : 'succeeded', null);
      }
    } catch (error) {
      if (error instanceof JobCancelledError || abortController.signal.aborted || this.#isCancelled(jobId)) {
        this.#finish(jobId, 'cancelled', null);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      ctx.log(message, 'error');

      const row = this.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      const canRetry = row !== undefined && row.attempts < row.maxAttempts;

      if (canRetry) {
        // Back to pending so the next tick picks it up again.
        this.handle.db
          .update(jobs)
          .set({ status: 'pending', errorMessage: message })
          .where(eq(jobs.id, jobId))
          .run();
        this.emit('retrying', { jobId, attempt: row.attempts });
      } else {
        this.#finish(jobId, 'failed', message);
      }
    } finally {
      this.#abortControllers.delete(jobId);
    }
  }

  #isCancelled(jobId: string): boolean {
    const row = this.handle.db
      .select({ cancelRequested: jobs.cancelRequested })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    return row?.cancelRequested ?? false;
  }

  #finish(jobId: string, status: JobStatus, errorMessage: string | null): void {
    this.handle.db
      .update(jobs)
      .set({ status, errorMessage, finishedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .run();
    this.emit('finished', { jobId, status, errorMessage });
  }

  getJob(jobId: string) {
    return this.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  }

  getLogs(jobId: string, afterSeq = -1) {
    return this.handle.db
      .select()
      .from(jobLogs)
      .where(and(eq(jobLogs.jobId, jobId), sql`${jobLogs.seq} > ${afterSeq}`))
      .orderBy(asc(jobLogs.seq))
      .all();
  }

  /**
   * Jobs left `running` when the process died are not actually running.
   * Called at startup so the Activity list never shows a permanent ghost.
   */
  reconcileOrphans(): number {
    const orphans = this.handle.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, 'running'))
      .all();

    for (const orphan of orphans) {
      this.#finish(
        orphan.id,
        'failed',
        'This task was interrupted because the panel restarted. You can run it again.',
      );
    }
    return orphans.length;
  }
}
