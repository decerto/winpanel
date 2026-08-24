import { z } from 'zod';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  DATABASE_ENGINES,
  DatabaseEngine,
  DatabaseName,
  databaseEngineInfo,
} from '@winpanel/shared';
import { adminProcedure, protectedProcedure, router, type RequestContext } from '../trpc.js';
import { SiteService } from '../../sites/site-service.js';
import { sites, users } from '../../db/schema.js';
import { DatabaseError } from '../../databases/errors.js';
import { sitePrefix } from '../../databases/names.js';
import { engineAvailability } from '../../databases/registry.js';
import {
  accountAllowance,
  adoptLegacyDatabases,
  connectionFor,
  createDatabase,
  reconcile,
  removeDatabase,
  resetDatabasePassword,
  revealDatabasePassword,
  siteAllowance,
} from '../../databases/service.js';
import {
  getDatabase,
  listAllDatabases,
  listDatabasesForOwner,
  listDatabasesForSite,
  type DatabaseSummary,
} from '../../databases/store.js';
import { browseCollections, browseDocuments } from '../../databases/browser.js';
import { rewriteWpConfigPassword } from '../../sites/wordpress.js';
import type { EngineContext } from '../../databases/types.js';

/**
 * Databases, across every engine the server has.
 *
 * Two shapes of request arrive here. Some name a website — the Databases tab
 * on a site — and are scoped by the middleware in `trpc.ts` like everything
 * else about a site. The rest name a database by its id, because the
 * server-wide Databases page lists databases that belong to a person rather
 * than to any one website, and those cannot be scoped by slug. Every one of
 * them goes through `mustGetDatabase`, which refuses a database the caller
 * does not own in exactly the same words it uses for one that does not exist.
 * `test/authorisation.test.ts` enforces that: a procedure here that reaches
 * for neither a slug nor `mustGetDatabase` fails the build.
 */

const Slug = z.string().min(1);

function engineContext(ctx: RequestContext): EngineContext {
  return { db: ctx.app.db, vault: ctx.app.vault, binDir: ctx.app.config.binDir };
}

/** The site, or a 404 in the panel's wording. */
function mustGetSite(ctx: RequestContext, slug: string) {
  const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
  const site = service.get(slug);
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  return site;
}

/**
 * The database this request is about, if the caller is allowed to see it.
 *
 * A customer may reach the databases they own and nothing else. One they do
 * not own is reported as not found rather than not allowed, so other people's
 * databases cannot be discovered by watching which ids come back refused —
 * the same posture the site and file routes take.
 */
function mustGetDatabase(ctx: RequestContext, id: string): DatabaseSummary {
  const record = getDatabase(ctx.app.db, id);
  const notFound = new TRPCError({
    code: 'NOT_FOUND',
    message: 'That database was not found.',
  });

  if (!record) throw notFound;
  if (!ctx.user) throw notFound;
  if (ctx.user.role !== 'user') return record;
  if (record.ownerUserId !== null && record.ownerUserId === ctx.user.id) return record;

  throw notFound;
}

/** Turns an engine failure into something worth reading. */
function asTrpcError(error: unknown, fallback: string): TRPCError {
  return new TRPCError({
    code: error instanceof DatabaseError ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
    message: error instanceof DatabaseError ? error.message : fallback,
    cause: error,
  });
}

/** One database, as the panel lists it. Never includes the password. */
function present(record: DatabaseSummary) {
  const info = databaseEngineInfo(record.engine);

  return {
    id: record.id,
    engine: record.engine,
    engineLabel: info.label,
    browser: info.browser,
    name: record.name,
    username: record.username,
    siteSlug: record.siteSlug,
    siteName: record.siteName,
    ownerUsername: record.ownerUsername,
    createdAt: record.createdAt,
    connection: connectionFor(record),
  };
}

export const databasesRouter = router({
  /**
   * Which database servers this machine actually has.
   *
   * Only installed engines are returned. The panel shows nothing at all for
   * one that is not there — no greyed-out row, no "install this first" option
   * in a dropdown. An engine you do not have is not a choice you are making,
   * it is a question about somebody else's server.
   */
  engines: protectedProcedure.query(async ({ ctx }) => {
    const context = engineContext(ctx);
    const availability = await engineAvailability(context);
    const byId = new Map(availability.map((entry) => [entry.engine, entry]));

    const engines = DATABASE_ENGINES.filter((info) => byId.get(info.id)?.installed).map((info) => ({
      id: info.id,
      label: info.label,
      description: info.description,
      port: info.port,
      sql: info.sql,
      browser: info.browser,
      ready: byId.get(info.id)?.ready ?? false,
    }));

    /*
     * Whether this account has any business seeing databases at all.
     *
     * An allowance of zero is how an administrator says "databases are not
     * part of what this customer bought", so the whole section — the sidebar
     * entry, the website tab — stays out of their panel rather than sitting
     * there refusing them. A customer who already holds one still sees it,
     * because taking away the only way to reach a database they are being
     * charged for would be worse than the tidiness is worth.
     */
    const user = ctx.user!;
    const allowance = user.role === 'user' ? accountAllowance(context, user.id) : null;
    const permitted = allowance === null || allowance.limit !== 0 || allowance.used > 0;

    return {
      engines,
      /** True when the panel should offer databases to whoever is asking. */
      visible: engines.length > 0 && permitted,
      /** True when at least one engine can take a new database right now. */
      any: engines.some((engine) => engine.ready),
      /**
       * Installed but not finished setting itself up. Worth naming separately:
       * "install it" is the wrong advice for a server that is already there.
       */
      unfinished: engines.filter((engine) => !engine.ready).map((engine) => engine.label),
    };
  }),

  /**
   * Every database the caller may see, for the server-wide Databases page.
   *
   * An administrator sees the machine's; a customer sees their own. Unscoped
   * by design — a database need not belong to a website — and listed in the
   * authorisation test as such.
   */
  listAll: protectedProcedure.query(async ({ ctx }) => {
    const context = engineContext(ctx);
    const user = ctx.user!;
    const isCustomer = user.role === 'user';

    /*
     * Databases made before the panel kept records are claimed first, so an
     * upgrade does not present somebody with an empty page while their
     * WordPress database is sitting on the server unlisted.
     */
    await adoptLegacyDatabases(
      context,
      ctx.app.db.db
        .select({ id: sites.id, ownerUserId: sites.ownerUserId })
        .from(sites)
        .all()
        .filter((site) => !isCustomer || site.ownerUserId === user.id),
    );

    const records = isCustomer
      ? listDatabasesForOwner(ctx.app.db, user.id)
      : listAllDatabases(ctx.app.db);

    const live = await reconcile(context, records);
    const allowance = isCustomer ? accountAllowance(context, user.id) : null;

    return {
      databases: [...live]
        .sort((first, second) => second.createdAt.getTime() - first.createdAt.getTime())
        .map(present),
      limit: allowance?.limit ?? null,
      used: allowance?.used ?? live.length,
      problem: allowance?.problem ?? null,
    };
  }),

  /**
   * The websites a new database may be attached to.
   *
   * Offered on the server-wide page so a database can be made for a site
   * without going to that site first. A customer only ever sees their own.
   */
  attachableSites: protectedProcedure.query(({ ctx }) => {
    const user = ctx.user!;

    return ctx.app.db.db
      .select({ slug: sites.slug, displayName: sites.displayName, ownerUserId: sites.ownerUserId })
      .from(sites)
      .all()
      .filter((row) => user.role !== 'user' || row.ownerUserId === user.id)
      .map((row) => ({ slug: row.slug, name: row.displayName }));
  }),

  /**
   * Everything one website's Databases tab needs: which engines are available,
   * what the site already has, and how much of its allowance is left.
   */
  overview: protectedProcedure
    .input(z.object({ slug: Slug }))
    .query(async ({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);
      const context = engineContext(ctx);

      // Databases made before the panel kept records are claimed here, so an
      // upgrade never makes somebody's WordPress database vanish from the tab.
      await adoptLegacyDatabases(context, [site]);

      const availability = await engineAvailability(context);
      const live = await reconcile(context, listDatabasesForSite(ctx.app.db, site.id));
      const account = accountAllowance(context, site.ownerUserId);
      const perSite = siteAllowance(context, site.id);

      return {
        engines: availability
          .filter((entry) => entry.installed)
          .map((entry) => ({
            id: entry.engine,
            label: databaseEngineInfo(entry.engine).label,
            ready: entry.ready,
          })),
        /** True when a database could be created here right now. */
        installed: availability.some((entry) => entry.ready),
        databases: live.map(present),
        limit: perSite.limit,
        used: perSite.used,
        problem: perSite.problem ?? account.problem,
        accountLimit: account.limit,
        accountUsed: account.used,
      };
    }),

  /**
   * Creates a database on a chosen engine, optionally attached to a website.
   *
   * Unscoped for a customer because a database need not belong to a website at
   * all. When one is named, `mustGetSite` and the site middleware settle
   * whether it is theirs before anything is created.
   */
  create: protectedProcedure
    .input(
      z.object({
        engine: DatabaseEngine,
        name: DatabaseName,
        /** The website this is for. Omitted for a standalone database. */
        slug: Slug.optional(),
        password: z.string().max(1024).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const context = engineContext(ctx);
      const site = input.slug ? mustGetSite(ctx, input.slug) : null;

      /*
       * Whose allowance this comes out of. A database for a website belongs to
       * whoever owns the website, even when an administrator creates it on
       * their behalf — otherwise the administrator's own count would grow
       * every time they helped somebody out, and the customer's would not
       * reflect what they actually have.
       */
      const ownerUserId = site ? site.ownerUserId : (ctx.user?.id ?? null);

      const account = accountAllowance(context, ownerUserId);
      if (account.problem) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: account.problem });
      }

      if (site) {
        const perSite = siteAllowance(context, site.id);
        if (perSite.problem) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: perSite.problem });
        }
      }

      try {
        const created = await createDatabase({
          ctx: context,
          engine: input.engine,
          label: input.name,
          site: site ? { id: site.id, ownerUserId: site.ownerUserId } : null,
          ownerUserId,
          password: input.password,
        });

        return {
          id: created.id,
          engine: created.engine,
          name: created.name,
          username: created.username,
          password: created.password,
          generated: created.generated,
          // The whole point of the screen that follows: where to point an
          // application at what was just made.
          connection: connectionFor({
            id: created.id,
            engine: created.engine,
            name: created.name,
            username: created.username,
            siteId: site?.id ?? null,
            ownerUserId,
            createdAt: new Date(),
          }),
        };
      } catch (error) {
        throw asTrpcError(error, 'The database could not be created.');
      }
    }),

  /** Removes a database and the login that could reach it. */
  drop: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const record = mustGetDatabase(ctx, input.id);

      try {
        await removeDatabase(engineContext(ctx), record);
      } catch (error) {
        throw asTrpcError(error, 'The database could not be removed.');
      }

      return { ok: true };
    }),

  /**
   * Changes a database's password. Given one, it is used; otherwise a fresh
   * one is generated. Either way it is returned once — it is otherwise only
   * ever in the vault.
   */
  setPassword: protectedProcedure
    .input(z.object({ id: z.string().min(1), password: z.string().max(1024).optional() }))
    .mutation(async ({ ctx, input }) => {
      const record = mustGetDatabase(ctx, input.id);

      let result: { password: string; generated: boolean };
      try {
        result = await resetDatabasePassword(engineContext(ctx), record, input.password);
      } catch (error) {
        throw asTrpcError(error, 'The password could not be changed.');
      }

      /*
       * A WordPress site keeps its database password in wp-config.php, so it
       * is told about the change in the same breath — changing the database
       * alone would take the site offline until someone edited the file. Only
       * the site's own WordPress database qualifies; a second database the
       * same site happens to have is nothing to do with wp-config.
       */
      if (record.siteId && record.siteSlug && record.name === sitePrefix(record.siteId)) {
        const site = ctx.app.db.db
          .select({ preset: sites.preset })
          .from(sites)
          .where(eq(sites.id, record.siteId))
          .get();

        if (site?.preset === 'wordpress') {
          await rewriteWpConfigPassword(
            path.join(ctx.app.config.sitesRoot, record.siteSlug),
            result.password,
          );
        }
      }

      return { name: record.name, password: result.password, generated: result.generated };
    }),

  /** Reveals a database's stored password to whoever owns it. */
  revealPassword: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const record = mustGetDatabase(ctx, input.id);
      const password = revealDatabasePassword(engineContext(ctx), record);

      if (!password) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'The panel no longer holds a password for that database. ' +
            'Set a new one and it will be stored again.',
        });
      }

      return { password };
    }),

  /**
   * The collections inside a MongoDB database.
   *
   * MongoDB has no Adminer driver that works on Windows — it needs a PECL
   * extension PHP does not ship — so the panel browses it itself. The
   * connection is made as the database's own login rather than as the
   * administrator, so a mistake here cannot reach anything the person asking
   * could not reach anyway.
   */
  mongoCollections: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const record = mustGetDatabase(ctx, input.id);

      try {
        return await browseCollections(engineContext(ctx), record);
      } catch (error) {
        throw asTrpcError(error, 'That database could not be opened.');
      }
    }),

  /** One page of documents out of one collection. */
  mongoDocuments: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        collection: z.string().min(1).max(120),
        page: z.number().int().min(1).max(10_000).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        /** A JSON filter, exactly as it would be typed into a shell. */
        filter: z.string().max(4_000).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const record = mustGetDatabase(ctx, input.id);

      try {
        return await browseDocuments(engineContext(ctx), record, {
          collection: input.collection,
          page: input.page,
          pageSize: input.pageSize,
          ...(input.filter === undefined ? {} : { filter: input.filter }),
        });
      } catch (error) {
        throw asTrpcError(error, 'Those documents could not be read.');
      }
    }),

  /**
   * Sets how many databases a website may have. Admin only: it is the
   * allowance a customer is held to, not something a customer can raise.
   */
  setLimit: adminProcedure
    .input(z.object({ slug: Slug, limit: z.number().int().min(0).nullable() }))
    .mutation(({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);

      ctx.app.db.db
        .update(sites)
        .set({ databaseLimit: input.limit })
        .where(eq(sites.id, site.id))
        .run();

      return { ok: true };
    }),

  /** Sets how many databases an account may hold in total. Admin only. */
  setAccountLimit: adminProcedure
    .input(z.object({ userId: z.string().min(1), limit: z.number().int().min(0).nullable() }))
    .mutation(({ ctx, input }) => {
      ctx.app.db.db
        .update(users)
        .set({ databaseLimit: input.limit })
        .where(eq(users.id, input.userId))
        .run();

      return { ok: true };
    }),
});
