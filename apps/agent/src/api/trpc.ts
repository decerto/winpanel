import { TRPCError, initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import superjson from 'superjson';
import crypto from 'node:crypto';
// Loads the declaration merging that adds `cookies`, `setCookie` and
// `clearCookie` to Fastify's request and reply types.
import type {} from '@fastify/cookie';
import type { AppContext } from '../app-context.js';
import type { SessionUser } from '../services/auth-service.js';

export interface RequestContext {
  app: AppContext;
  user: SessionUser | null;
  ip: string;
  userAgent: string | undefined;
  sessionToken: string | undefined;
  setSessionCookie: (token: string, expiresAt: Date) => void;
  clearSessionCookie: () => void;
}

export const SESSION_COOKIE = 'winpanel_session';

export function createContextFactory(app: AppContext) {
  return function createContext({ req, res }: CreateFastifyContextOptions): RequestContext {
    const token = req.cookies[SESSION_COOKIE];

    return {
      app,
      user: app.auth.resolveSession(token),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      sessionToken: token,
      setSessionCookie: (value, expiresAt) => {
        void res.setCookie(SESSION_COOKIE, value, {
          httpOnly: true,
          // Only over HTTPS when HTTPS is on; forcing it while the user has
          // opted into plain HTTP would silently break every login.
          secure: app.config.httpsEnabled,
          sameSite: 'strict',
          path: '/',
          expires: expiresAt,
        });
      },
      clearSessionCookie: () => {
        void res.clearCookie(SESSION_COOKIE, { path: '/' });
      },
    };
  };
}

const t = initTRPC.context<RequestContext>().create({
  /*
   * Without a transformer, JSON turns every Date into a string and the client
   * types quietly lie about it. superjson keeps Date, Map and Set intact so
   * `checkedAt` really is a Date on both sides.
   */
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Never leak internals to a page that anyone on the internet can reach.
        stack: undefined,
        // Surfaced so the UI can render the right recovery action.
        appCode: error.cause instanceof Error ? error.cause.name : undefined,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Records who did what, for every mutation.
 *
 * Applied as middleware rather than left to each handler, because an audit
 * log with gaps in it is worse than none — it invites false confidence.
 */
const auditMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  if (type !== 'mutation') return await next();

  const result = await next();

  ctx.app.db.db
    .insert(ctx.app.schema.auditEvents)
    .values({
      id: crypto.randomUUID(),
      userId: ctx.user?.id ?? null,
      action: path,
      target: null,
      ip: ctx.ip,
      outcome: result.ok ? 'success' : 'failure',
      detail: {},
    })
    .run();

  return result;
});

/** Requires a valid session. */
const requireAuth = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in.' });
  }
  if (!ctx.app.auth.isIpAllowed(ctx.ip)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This panel does not accept connections from your network.',
    });
  }
  return await next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Requires a valid session.
 *
 * There is deliberately no second tier gated on two-factor enrolment. Two
 * factors are optional, so an account without them is a supported state
 * rather than a half-finished one, and a middleware that refused those
 * accounts would simply lock them out of the panel entirely.
 */
export const protectedProcedure = t.procedure.use(requireAuth).use(auditMiddleware);

/**
 * Unauthenticated, but still audited.
 *
 * Sign-in and first-run setup are the most security-relevant events the panel
 * handles, and they necessarily happen before a session exists. Leaving them
 * on `publicProcedure` would mean a brute-force attempt against an
 * internet-facing panel produced no audit trail at all — precisely the
 * opposite of what is wanted.
 */
export const publicAuditedProcedure = t.procedure.use(auditMiddleware);
