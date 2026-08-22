import { TRPCError, initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { and, eq } from 'drizzle-orm';
import superjson from 'superjson';
import crypto from 'node:crypto';
// Loads the declaration merging that adds `cookies`, `setCookie` and
// `clearCookie` to Fastify's request and reply types.
import type {} from '@fastify/cookie';
import { roleAtLeast, type UserRole } from '@winpanel/shared';
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

/** Requires at least the given role. */
function requireRole(minimum: UserRole) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user || !roleAtLeast(ctx.user.role, minimum)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          minimum === 'superadmin'
            ? 'Only the owner of this server can do that.'
            : 'Only an administrator can do that.',
      });
    }
    return await next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/**
 * The website or domain an input is talking about, if any.
 *
 * Every site-scoped endpoint in the panel names its subject the same handful
 * of ways, which is what makes a single check possible. Reading the raw input
 * here rather than trusting each handler is the whole point: a guard that has
 * to be remembered on every new endpoint is a guard that will eventually be
 * forgotten.
 */
export function scopeOf(input: unknown): { slug?: string; domain?: string } {
  if (typeof input !== 'object' || input === null) return {};
  const record = input as Record<string, unknown>;
  const scope: { slug?: string; domain?: string } = {};

  for (const key of ['slug', 'siteSlug']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') scope.slug = value;
  }

  const domain = record['domain'];
  if (typeof domain === 'string' && domain !== '') scope.domain = domain.toLowerCase();

  // Mailboxes are named by address rather than by domain. The part after the
  // @ is the thing ownership is actually decided on.
  const address = record['address'];
  if (scope.domain === undefined && typeof address === 'string' && address.includes('@')) {
    scope.domain = address.split('@')[1]?.toLowerCase();
  }

  return scope;
}

/**
 * Whether `domain` sits under `owned`.
 *
 * Deliberately one-directional. Owning `example.com` covers `mail.example.com`
 * because the same person controls the zone; owning `shop.example.com` does
 * not give anyone `example.com`, or every customer on a shared parent domain
 * would inherit the lot.
 */
export function domainCovers(owned: string, domain: string): boolean {
  const parent = owned.toLowerCase();
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Whether `user` may act on the website named by `slug`.
 *
 * The same rule `enforceSiteScope` applies, in a form the streamed file routes
 * can call. Those are plain Fastify handlers rather than tRPC procedures, so no
 * middleware runs for them and the check has to be made by hand.
 */
export function userMayAccessSite(app: AppContext, user: SessionUser, slug: string): boolean {
  if (user.role !== 'user') return true;

  return (
    app.db.db
      .select()
      .from(app.schema.sites)
      .where(and(eq(app.schema.sites.ownerUserId, user.id), eq(app.schema.sites.slug, slug)))
      .all().length > 0
  );
}

/** Whether a customer owns or has been explicitly assigned a game server. */
export function userMayAccessGameServer(
  app: AppContext,
  user: SessionUser,
  slug: string,
): boolean {
  if (user.role !== 'user') return true;
  return app.gameServers.getVisible(slug, user.id) !== undefined;
}

/**
 * Stops a customer reaching a website that is not theirs.
 *
 * Answers "not found" rather than "not allowed", so that the panel cannot be
 * used to discover which slugs and domains exist on the server.
 */
const enforceSiteScope = t.middleware(async ({ ctx, getRawInput, next }) => {
  if (ctx.user?.role !== 'user') return await next();

  const { slug, domain } = scopeOf(await getRawInput());
  if (slug === undefined && domain === undefined) return await next();

  const owned = ctx.app.db.db
    .select()
    .from(ctx.app.schema.sites)
    .where(eq(ctx.app.schema.sites.ownerUserId, ctx.user.id))
    .all();

  const missing =
    (slug !== undefined && !owned.some((site) => site.slug === slug)) ||
    (domain !== undefined &&
      !owned.some((site) =>
        (site.domains as string[]).some((name) => domainCovers(name, domain)),
      ));

  if (missing) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That website is not on your account.',
    });
  }

  return await next();
});

/**
 * Requires a valid session, and — for a customer — a website they own.
 *
 * There is deliberately no second tier gated on two-factor enrolment. Two
 * factors are optional, so an account without them is a supported state
 * rather than a half-finished one, and a middleware that refused those
 * accounts would simply lock them out of the panel entirely.
 */
export const protectedProcedure = t.procedure
  .use(requireAuth)
  .use(enforceSiteScope)
  .use(auditMiddleware);

/** Authenticated API without the website-specific scope middleware. */
export const accountProcedure = t.procedure.use(requireAuth).use(auditMiddleware);

/**
 * Requires an administrator or the owner.
 *
 * Anything that describes or changes the machine itself lives here: runtimes,
 * services, health checks, browsing the disk. A customer account has no
 * business seeing any of it, and hiding it in the UI is not a control.
 */
export const adminProcedure = t.procedure
  .use(requireAuth)
  .use(requireRole('admin'))
  .use(auditMiddleware);

/**
 * Requires the owner account.
 *
 * Reserved for the things an administrator must not be able to do even by
 * accident: updating or removing the panel, reading the security trail, and
 * creating or changing other administrators. Also covers anything that would
 * tell one person about another's sign-ins — saying that an account exists and
 * is under attack helps nobody but an attacker.
 */
export const superadminProcedure = t.procedure
  .use(requireAuth)
  .use(requireRole('superadmin'))
  .use(auditMiddleware);

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
