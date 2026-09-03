import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { and, desc, eq, gt } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, superadminProcedure, type RequestContext } from '../trpc.js';
import { backupUploads, jobs, sites, users } from '../../db/schema.js';
import type { DatabaseHandle } from '../../db/index.js';
import type { JobTransaction } from '../../jobs/queue.js';
import {
  BackupSchedule,
  BackupPayload,
  backupFilePath,
  deleteBackupArchive,
  describeBackupSchedule,
  listBackupArchives,
  stagedBackupFilePath,
  writeBackupSchedule,
} from '../../backups/service.js';

const RestoreSourceFields = {
  backupId: z.string().uuid().optional(),
  uploadedBackupId: z.string().uuid().optional(),
};

function hasActiveRestore(rows: Array<typeof jobs.$inferSelect>): boolean {
  return rows.some((row) => {
    if (row.status !== 'pending' && row.status !== 'running') return false;
    const payload = BackupPayload.safeParse(row.payload);
    return payload.success && payload.data.operation === 'restore';
  });
}

async function assertUploadedRestore(
  ctx: RequestContext,
  uploadId: string,
  scope: 'site' | 'panel',
  siteId: string | null,
): Promise<void> {
  const upload = ctx.app.db.db
    .select()
    .from(backupUploads)
    .where(
      and(
        eq(backupUploads.id, uploadId),
        eq(backupUploads.scope, scope),
        eq(backupUploads.ownerUserId, ctx.user!.id),
        gt(backupUploads.expiresAt, new Date()),
        ...(scope === 'site' && siteId !== null ? [eq(backupUploads.siteId, siteId)] : []),
      ),
    )
    .get();
  if (!upload) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That uploaded backup was not found.' });
  }

  const archive = stagedBackupFilePath(ctx.app.config.backupDir, scope, uploadId);
  if (!(await fs.access(archive).then(() => true, () => false))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That uploaded backup is no longer available.' });
  }
}

function siteForSlug(ctx: RequestContext, slug: string) {
  const site = ctx.app.sites.get(slug);
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  return site;
}

function backupJobsForSite(ctx: RequestContext, siteId: string) {
  return ctx.app.db.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'backup'), eq(jobs.siteId, siteId)))
    .orderBy(desc(jobs.createdAt))
    .all();
}

function panelBackupJobs(ctx: RequestContext) {
  return ctx.app.db.db
    .select()
    .from(jobs)
    .where(eq(jobs.kind, 'backup'))
    .orderBy(desc(jobs.createdAt))
    .all();
}

function siteBackupUsage(
  transaction: DatabaseHandle['db'] | JobTransaction,
  backupDir: string,
  ownerUserId: string,
): { completed: number; reserved: number } {
  const rows = transaction
    .select({ id: jobs.id, status: jobs.status, payload: jobs.payload, siteId: jobs.siteId })
    .from(jobs)
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .where(and(eq(jobs.kind, 'backup'), eq(sites.ownerUserId, ownerUserId)))
    .all();

  let completed = 0;
  let reserved = 0;

  for (const row of rows) {
    const payload = BackupPayload.safeParse(row.payload);
    if (
      !payload.success ||
      payload.data.scope !== 'site' ||
      payload.data.operation !== 'create' ||
      payload.data.siteId !== row.siteId
    ) {
      continue;
    }

    if (row.status === 'pending' || row.status === 'running') {
      reserved += 1;
      continue;
    }

    if (
      row.status === 'succeeded' &&
      fsSync.existsSync(backupFilePath(backupDir, 'site', row.id))
    ) {
      completed += 1;
    }
  }

  return { completed, reserved };
}

function siteBackupQuota(ctx: RequestContext, siteId: string) {
  const site = ctx.app.db.db.select().from(sites).where(eq(sites.id, siteId)).get();
  const limit = site?.ownerUserId
    ? ctx.app.auth.getUser(site.ownerUserId)?.backupLimit ?? null
    : null;
  const usage = site?.ownerUserId
    ? siteBackupUsage(ctx.app.db.db, ctx.app.config.backupDir, site.ownerUserId)
    : { completed: 0, reserved: 0 };

  return {
    limit,
    unlimited: limit === null,
    completed: usage.completed,
    reserved: usage.reserved,
    remaining: limit === null ? null : Math.max(0, limit - usage.completed - usage.reserved),
  };
}

function activeBackupJob(
  rows: Array<typeof jobs.$inferSelect>,
  scope: 'site' | 'panel',
  siteId?: string,
): { jobId: string; operation: 'create' | 'restore' } | null {
  const job = rows.find((row) => {
    if (row.status !== 'pending' && row.status !== 'running') return false;

    const payload = BackupPayload.safeParse(row.payload);
    return (
      payload.success &&
      (payload.data.operation === 'create' || payload.data.operation === 'restore') &&
      payload.data.scope === scope &&
      (scope === 'site' ? payload.data.siteId === siteId : row.siteId === null)
    );
  });

  const payload = BackupPayload.safeParse(job?.payload);
  return job && payload.success
    ? { jobId: job.id, operation: payload.data.operation }
    : null;
}

/** The finished create job an archive came from, or null if it is not one. */
function completedBackupJob(
  rows: Array<typeof jobs.$inferSelect>,
  id: string,
  scope: 'site' | 'panel',
  siteId?: string,
) {
  const job = rows.find((row) => row.id === id);
  const payload = BackupPayload.safeParse(job?.payload);
  if (
    !job ||
    job.kind !== 'backup' ||
    job.status !== 'succeeded' ||
    !payload.success ||
    payload.data.operation !== 'create' ||
    payload.data.scope !== scope ||
    (scope === 'site' && payload.data.siteId !== siteId) ||
    (scope === 'panel' && job.siteId !== null)
  ) {
    return null;
  }

  return { job, payload: payload.data };
}

function archiveDetails(
  archives: Awaited<ReturnType<typeof listBackupArchives>>,
  rows: Array<typeof jobs.$inferSelect>,
  scope: 'site' | 'panel',
  siteId?: string,
) {
  return archives
    .map((archive) => {
      const match = completedBackupJob(rows, archive.id, scope, siteId);
      if (!match) return null;

      return {
        id: archive.id,
        sizeBytes: archive.sizeBytes,
        createdAt: match.job.finishedAt ?? archive.createdAt,
        status: match.job.status,
        /** Null for a snapshot somebody took by hand. */
        frequency: match.payload.frequency ?? null,
        includesGameServers: match.payload.includeGameServers,
        includesDependencies: match.payload.includeDependencies,
      };
    })
    .filter((archive): archive is NonNullable<typeof archive> => archive !== null);
}

function totals(archives: ReadonlyArray<{ sizeBytes: number; createdAt: Date }>) {
  const times = archives.map((archive) => archive.createdAt.getTime());
  return {
    count: archives.length,
    totalBytes: archives.reduce((sum, archive) => sum + archive.sizeBytes, 0),
    newestAt: times.length > 0 ? new Date(Math.max(...times)) : null,
    oldestAt: times.length > 0 ? new Date(Math.min(...times)) : null,
  };
}

async function panelStatus(ctx: RequestContext) {
  const backupDir = ctx.app.config.backupDir;
  const [panelArchives, siteArchives] = await Promise.all([
    listBackupArchives(backupDir, 'panel'),
    listBackupArchives(backupDir, 'site'),
  ]);

  const backups = archiveDetails(panelArchives, panelBackupJobs(ctx), 'panel');
  const byId = new Map(backups.map((backup) => [backup.id, backup]));
  const report = describeBackupSchedule(ctx.app.db);

  return {
    schedule: report.schedule,
    checkIntervalMs: report.checkIntervalMs,
    slots: report.slots.map((slot) => ({
      ...slot,
      // Null once the file has been pruned or deleted. `lastSuccessAt` still
      // records the run, so the panel can say the snapshot itself is gone.
      currentBackup: slot.currentBackupId ? (byId.get(slot.currentBackupId) ?? null) : null,
    })),
    backups,
    storage: totals(backups),
    websiteStorage: totals(siteArchives),
  };
}

export const backupsRouter = router({
  site: router({
    list: protectedProcedure
      .input(z.object({ slug: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        const archives = await listBackupArchives(ctx.app.config.backupDir, 'site');
        return archiveDetails(archives, backupJobsForSite(ctx, site.id), 'site', site.id);
      }),

    active: protectedProcedure
      .input(z.object({ slug: z.string().min(1) }))
      .query(({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        return activeBackupJob(backupJobsForSite(ctx, site.id), 'site', site.id);
      }),

    quota: protectedProcedure
      .input(z.object({ slug: z.string().min(1) }))
      .query(({ ctx, input }) => siteBackupQuota(ctx, siteForSlug(ctx, input.slug).id)),

    create: protectedProcedure
      .input(z.object({ slug: z.string().min(1), includeDependencies: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        const jobId = ctx.app.jobs.enqueueWithinTransaction((transaction, enqueue) => {
          if (site.ownerUserId) {
            const owner = transaction
              .select({ backupLimit: users.backupLimit })
              .from(users)
              .where(eq(users.id, site.ownerUserId))
              .get();
            const limit = owner?.backupLimit ?? null;

            if (limit !== null) {
              const usage = siteBackupUsage(
                transaction,
                ctx.app.config.backupDir,
                site.ownerUserId,
              );
              if (usage.completed + usage.reserved >= limit) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message:
                    limit === 0
                      ? 'Backups are not included on this account. Ask your hosting provider to enable them.'
                      : `This account is limited to ${limit} website ${limit === 1 ? 'backup' : 'backups'}. ` +
                        'Delete an existing backup, or ask your hosting provider to raise the limit.',
                });
              }
            }
          }

          return enqueue({
            kind: 'backup',
            title: `Backing up ${site.displayName}`,
            payload: {
              scope: 'site',
              operation: 'create',
              siteId: site.id,
              includeDependencies: input.includeDependencies,
            },
            siteId: site.id,
          });
        });
        return { jobId };
      }),

    remove: protectedProcedure
      .input(z.object({ slug: z.string().min(1), backupId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        const match = completedBackupJob(
          backupJobsForSite(ctx, site.id),
          input.backupId,
          'site',
          site.id,
        );
        if (!match) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That website backup was not found.' });
        }

        await deleteBackupArchive(ctx.app.config.backupDir, 'site', input.backupId);
        return { removed: true };
      }),

    restore: protectedProcedure
      .input(
        z
          .object({
            slug: z.string().min(1),
            ...RestoreSourceFields,
            installDependencies: z.boolean().default(false),
          })
          .refine(
            (value) => Boolean(value.backupId) !== Boolean(value.uploadedBackupId),
            'Choose one backup archive to restore.',
          ),
      )
      .mutation(async ({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        const rows = backupJobsForSite(ctx, site.id);
        if (hasActiveRestore(rows)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A restore is already in progress for this website.',
          });
        }

        if (input.uploadedBackupId) {
          await assertUploadedRestore(ctx, input.uploadedBackupId, 'site', site.id);
        } else if (input.backupId) {
          const match = completedBackupJob(rows, input.backupId, 'site', site.id);
          if (!match) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That website backup was not found.' });
          }
          const archive = backupFilePath(ctx.app.config.backupDir, 'site', input.backupId);
          if (!(await fs.access(archive).then(() => true, () => false))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That website backup is no longer available.' });
          }
        }

        return {
          jobId: ctx.app.jobs.enqueue({
            kind: 'backup',
            title: `Restoring ${site.displayName}`,
            payload: {
              scope: 'site',
              operation: 'restore',
              siteId: site.id,
              ...(input.backupId ? { backupId: input.backupId } : {}),
              ...(input.uploadedBackupId ? { uploadedBackupId: input.uploadedBackupId } : {}),
              requestedByUserId: ctx.user.id,
              installDependencies: input.installDependencies,
            },
            siteId: site.id,
            maxAttempts: 1,
          }),
        };
      }),
  }),

  panel: router({
    status: superadminProcedure.query(({ ctx }) => panelStatus(ctx)),

    setSettings: superadminProcedure.input(BackupSchedule).mutation(({ ctx, input }) => {
      writeBackupSchedule(ctx.app.db, input);
      // A schedule that was just switched on is due immediately, so hand back
      // the recalculated timings rather than making the panel ask again.
      return panelStatus(ctx);
    }),

    list: superadminProcedure.query(async ({ ctx }) => {
      const archives = await listBackupArchives(ctx.app.config.backupDir, 'panel');
      return archiveDetails(archives, panelBackupJobs(ctx), 'panel');
    }),

    active: superadminProcedure.query(({ ctx }) => activeBackupJob(panelBackupJobs(ctx), 'panel')),

    create: superadminProcedure
      .input(
        z
          .object({
            includeGameServers: z.boolean(),
            includeDependencies: z.boolean().default(false),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) => ({
        jobId: ctx.app.jobs.enqueue({
          kind: 'backup',
          title: 'Creating a panel backup',
          payload: {
            scope: 'panel',
            operation: 'create',
            includeGameServers: input?.includeGameServers ?? false,
            includeDependencies: input?.includeDependencies ?? false,
          },
          maxAttempts: 2,
        }),
      })),

    remove: superadminProcedure
      .input(z.object({ backupId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const match = completedBackupJob(panelBackupJobs(ctx), input.backupId, 'panel');
        if (!match) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That panel backup was not found.' });
        }

        await deleteBackupArchive(ctx.app.config.backupDir, 'panel', input.backupId);
        return await panelStatus(ctx);
      }),

    restore: superadminProcedure
      .input(
        z
          .object({
            ...RestoreSourceFields,
            installDependencies: z.boolean().default(false),
          })
          .refine(
            (value) => Boolean(value.backupId) !== Boolean(value.uploadedBackupId),
            'Choose one backup archive to restore.',
          ),
      )
      .mutation(async ({ ctx, input }) => {
        const active = activeBackupJob(panelBackupJobs(ctx), 'panel');
        if (active?.operation === 'restore') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A panel restore is already in progress.',
          });
        }

        if (input.uploadedBackupId) {
          await assertUploadedRestore(ctx, input.uploadedBackupId, 'panel', null);
        } else if (input.backupId) {
          const job = ctx.app.jobs.getJob(input.backupId);
          const payload = BackupPayload.safeParse(job?.payload);
          if (
            !job ||
            job.kind !== 'backup' ||
            job.status !== 'succeeded' ||
            !payload.success ||
            payload.data.operation !== 'create' ||
            payload.data.scope !== 'panel' ||
            job.siteId !== null
          ) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That panel backup was not found.' });
          }
          const archive = backupFilePath(ctx.app.config.backupDir, 'panel', input.backupId);
          if (!(await fs.access(archive).then(() => true, () => false))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That panel backup is no longer available.' });
          }
        }

        return {
          jobId: ctx.app.jobs.enqueue({
            kind: 'backup',
            title: 'Restoring a panel backup',
            payload: {
              scope: 'panel',
              operation: 'restore',
              ...(input.backupId ? { backupId: input.backupId } : {}),
              ...(input.uploadedBackupId ? { uploadedBackupId: input.uploadedBackupId } : {}),
              requestedByUserId: ctx.user.id,
              installDependencies: input.installDependencies,
            },
            maxAttempts: 1,
          }),
        };
      }),
  }),
});
