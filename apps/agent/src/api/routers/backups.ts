import fs from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, superadminProcedure, type RequestContext } from '../trpc.js';
import { jobs } from '../../db/schema.js';
import {
  BackupSchedule,
  BackupPayload,
  backupFilePath,
  deleteBackupArchive,
  describeBackupSchedule,
  listBackupArchives,
  writeBackupSchedule,
} from '../../backups/service.js';

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

function activeBackupJob(
  rows: Array<typeof jobs.$inferSelect>,
  scope: 'site' | 'panel',
  siteId?: string,
): { jobId: string } | null {
  const job = rows.find((row) => {
    if (row.status !== 'pending' && row.status !== 'running') return false;

    const payload = BackupPayload.safeParse(row.payload);
    return (
      payload.success &&
      payload.data.operation === 'create' &&
      payload.data.scope === scope &&
      (scope === 'site' ? payload.data.siteId === siteId : row.siteId === null)
    );
  });

  return job ? { jobId: job.id } : null;
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

    create: protectedProcedure
      .input(z.object({ slug: z.string().min(1), includeDependencies: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        const site = siteForSlug(ctx, input.slug);
        const jobId = ctx.app.jobs.enqueue({
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
      .input(z.object({ backupId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
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

        return {
          jobId: ctx.app.jobs.enqueue({
            kind: 'backup',
            title: 'Restoring a panel backup',
            payload: {
              scope: 'panel',
              operation: 'restore',
              backupId: input.backupId,
            },
            maxAttempts: 1,
          }),
        };
      }),
  }),
});
