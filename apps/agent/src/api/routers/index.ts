import { z } from 'zod';
import { authedProcedure, protectedProcedure, router } from '../trpc.js';
import { authRouter } from './auth.js';
import { checksRouter } from './checks.js';
import { sitesRouter } from './sites.js';
import { filesRouter } from './files.js';
import { dnsRouter } from './dns.js';
import { mailRouter } from './mail.js';

const jobsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const { desc } = await import('drizzle-orm');
      return ctx.app.db.db
        .select()
        .from(ctx.app.schema.jobs)
        .orderBy(desc(ctx.app.schema.jobs.createdAt))
        .limit(input?.limit ?? 50)
        .all();
    }),

  get: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .query(({ ctx, input }) => ctx.app.jobs.getJob(input.jobId) ?? null),

  /** Incremental fetch so the log view can stream without re-sending history. */
  logs: protectedProcedure
    .input(z.object({ jobId: z.string().uuid(), afterSeq: z.number().int().default(-1) }))
    .query(({ ctx, input }) => ctx.app.jobs.getLogs(input.jobId, input.afterSeq)),

  cancel: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      ctx.app.jobs.requestCancel(input.jobId);
      return { ok: true };
    }),
});

const auditRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ ctx, input }) => {
      const { desc } = await import('drizzle-orm');
      return ctx.app.db.db
        .select()
        .from(ctx.app.schema.auditEvents)
        .orderBy(desc(ctx.app.schema.auditEvents.at))
        .limit(input?.limit ?? 100)
        .all();
    }),
});

export const appRouter = router({
  auth: authRouter,
  checks: checksRouter,
  sites: sitesRouter,
  files: filesRouter,
  dns: dnsRouter,
  mail: mailRouter,
  jobs: jobsRouter,
  audit: auditRouter,

  /** Cheap liveness probe used by the installer and the service wrapper. */
  ping: authedProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
});

export type AppRouter = typeof appRouter;
