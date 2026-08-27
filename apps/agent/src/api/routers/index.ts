import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { desc, eq, inArray, or } from 'drizzle-orm';
import { protectedProcedure, router, superadminProcedure } from '../trpc.js';
import { accessRouter } from './access.js';
import { authRouter } from './auth.js';
import { checksRouter } from './checks.js';
import { sitesRouter } from './sites.js';
import { filesRouter } from './files.js';
import { dnsRouter } from './dns.js';
import { sslRouter } from './ssl.js';
import { mailRouter } from './mail.js';
import { webmailRouter } from './webmail.js';
import { databasesRouter } from './databases.js';
import { systemRouter } from './system.js';
import { componentsRouter } from './components.js';
import { usersRouter } from './users.js';
import { gameServersRouter } from './game-servers.js';
import { backupsRouter } from './backups.js';
import { logsRouter } from './logs.js';
import type { RequestContext } from '../trpc.js';

/**
 * The jobs a customer is allowed to see: theirs, and nothing else.
 *
 * A job that belongs to no website is server work — installing a runtime,
 * updating the panel — which only an admin ever starts and only an admin
 * should be able to watch.
 */
function visibleJobIds(
  ctx: RequestContext,
): { siteIds: string[]; gameServerIds: string[] } | null {
  if (ctx.user?.role !== 'user') return null;

  const owned = ctx.app.db.db
    .select({ id: ctx.app.schema.sites.id })
    .from(ctx.app.schema.sites)
    .where(eq(ctx.app.schema.sites.ownerUserId, ctx.user.id))
    .all();

  const gameServers = ctx.app.gameServers.listForUser(ctx.user.id);
  return {
    siteIds: owned.map((site) => site.id),
    gameServerIds: gameServers.map((server) => server.id),
  };
}

function assertJobVisible(ctx: RequestContext, jobId: string): void {
  const visible = visibleJobIds(ctx);
  if (visible === null) return;

  const job = ctx.app.jobs.getJob(jobId);

  const visibleSite = job?.siteId != null && visible.siteIds.includes(job.siteId);
  const visibleGameServer =
    job?.gameServerId != null && visible.gameServerIds.includes(job.gameServerId);

  if (!job || (!visibleSite && !visibleGameServer)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That job is not on your account.' });
  }
}

const jobsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(({ ctx, input }) => {
      const visible = visibleJobIds(ctx);

      // An account with no websites yet has no jobs, and `inArray` with an
      // empty list is not something every driver agrees on.
      if (visible?.siteIds.length === 0 && visible.gameServerIds.length === 0) return [];

      const query = ctx.app.db.db.select().from(ctx.app.schema.jobs);

      return (
        visible === null
          ? query
          : query.where(
              or(
                visible.siteIds.length > 0
                  ? inArray(ctx.app.schema.jobs.siteId, visible.siteIds)
                  : undefined,
                visible.gameServerIds.length > 0
                  ? inArray(ctx.app.schema.jobs.gameServerId, visible.gameServerIds)
                  : undefined,
              ),
            )
      )
        .orderBy(desc(ctx.app.schema.jobs.createdAt))
        .limit(input?.limit ?? 50)
        .all();
    }),

  get: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .query(({ ctx, input }) => {
      assertJobVisible(ctx, input.jobId);
      return ctx.app.jobs.getJob(input.jobId) ?? null;
    }),

  /** Incremental fetch so the log view can stream without re-sending history. */
  logs: protectedProcedure
    .input(z.object({ jobId: z.string().uuid(), afterSeq: z.number().int().default(-1) }))
    .query(({ ctx, input }) => {
      assertJobVisible(ctx, input.jobId);
      return ctx.app.jobs.getLogs(input.jobId, input.afterSeq);
    }),

  cancel: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      assertJobVisible(ctx, input.jobId);
      ctx.app.jobs.requestCancel(input.jobId);
      return { ok: true };
    }),
});

/**
 * Who did what.
 *
 * Owner only, alongside the sign-in activity it sits next to: the trail is
 * how the owner checks up on their administrators, so an administrator who
 * could read it would be marking their own homework.
 */
const auditRouter = router({
  list: superadminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(({ ctx, input }) =>
      ctx.app.db.db
        .select()
        .from(ctx.app.schema.auditEvents)
        .orderBy(desc(ctx.app.schema.auditEvents.at))
        .limit(input?.limit ?? 100)
        .all(),
    ),
});

export const appRouter = router({
  auth: authRouter,
  access: accessRouter,
  users: usersRouter,
  checks: checksRouter,
  sites: sitesRouter,
  gameServers: gameServersRouter,
  backups: backupsRouter,
  logs: logsRouter,
  files: filesRouter,
  dns: dnsRouter,
  ssl: sslRouter,
  mail: mailRouter,
  webmail: webmailRouter,
  databases: databasesRouter,
  system: systemRouter,
  components: componentsRouter,
  jobs: jobsRouter,
  audit: auditRouter,

  /** Cheap liveness probe used by the installer and the service wrapper. */
  ping: protectedProcedure.query(() => ({ ok: true, at: new Date().toISOString() })),
});

export type AppRouter = typeof appRouter;
