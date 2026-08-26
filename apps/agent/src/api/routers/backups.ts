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
  listBackupArchives,
  readBackupSchedule,
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

function archiveDetails(
  archives: Awaited<ReturnType<typeof listBackupArchives>>,
  rows: Array<typeof jobs.$inferSelect>,
  scope: 'site' | 'panel',
  siteId?: string,
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return archives
    .map((archive) => {
      const job = byId.get(archive.id);
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
      return {
        id: archive.id,
        sizeBytes: archive.sizeBytes,
        createdAt: job.finishedAt ?? archive.createdAt,
        status: job.status,
      };
    })
    .filter((archive): archive is NonNullable<typeof archive> => archive !== null);
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
  }),

  panel: router({
    settings: superadminProcedure.query(({ ctx }) => readBackupSchedule(ctx.app.db)),

    setSettings: superadminProcedure
      .input(BackupSchedule)
      .mutation(({ ctx, input }) => {
        writeBackupSchedule(ctx.app.db, input);
        return input;
      }),

    list: superadminProcedure.query(async ({ ctx }) => {
      const archives = await listBackupArchives(ctx.app.config.backupDir, 'panel');
      const rows = ctx.app.db.db
        .select()
        .from(jobs)
        .where(eq(jobs.kind, 'backup'))
        .orderBy(desc(jobs.createdAt))
        .all();
      return archiveDetails(archives, rows, 'panel').map((archive) => {
        const job = rows.find((row) => row.id === archive.id);
        const payload = BackupPayload.safeParse(job?.payload);
        return {
          ...archive,
          frequency: payload.success ? payload.data.frequency ?? null : null,
        };
      });
    }),

    active: superadminProcedure.query(({ ctx }) => {
      const rows = ctx.app.db.db
        .select()
        .from(jobs)
        .where(eq(jobs.kind, 'backup'))
        .orderBy(desc(jobs.createdAt))
        .all();
      return activeBackupJob(rows, 'panel');
    }),

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
