import { z } from 'zod';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router, type RequestContext } from '../trpc.js';
import { SiteService } from '../../sites/site-service.js';
import { sites } from '../../db/schema.js';
import {
  assertSafeDbName,
  databaseServerInstalled,
  dropDatabase,
  generatePassword,
  listDatabases,
  provisionDatabase,
  readDatabasePassword,
  DatabaseError,
} from '../../sites/databases.js';
import { rewriteWpConfigPassword } from '../../sites/wordpress.js';

/**
 * The databases a website's data lives in.
 *
 * Every procedure names a site, so the per-customer scoping in `trpc.ts`
 * applies automatically: a customer can only ever reach the databases of a
 * site that is theirs. The operations themselves live in `sites/databases.ts`;
 * this router is the thin layer that checks the allowance and reports in
 * plain English.
 */

const Slug = z.string().min(1);

/** The site, or a 404 in the panel's wording. */
function mustGetSite(ctx: RequestContext, slug: string) {
  const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
  const site = service.get(slug);
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
  return site;
}

export const databasesRouter = router({
  /**
   * Whether the database server is installed, and how many databases this
   * site has and may have. One call so the tab can decide what to show.
   */
  overview: protectedProcedure
    .input(z.object({ slug: Slug }))
    .query(async ({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);
      const installed = await databaseServerInstalled(ctx.app.config.binDir);
      const prefix = `wp_${site.id.replace(/-/g, '').slice(0, 24)}`;

      const names = installed
        ? await listDatabases({
            db: ctx.app.db,
            vault: ctx.app.vault,
            binDir: ctx.app.config.binDir,
            prefix,
          })
        : [];

      return {
        installed,
        limit: site.databaseLimit,
        used: names.length,
        databases: names.map((name) => ({ name })),
      };
    }),

  /** Creates a database, within the site's allowance. */
  create: protectedProcedure
    .input(z.object({ slug: Slug, name: z.string().min(1).max(64), password: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);

      if (!(await databaseServerInstalled(ctx.app.config.binDir))) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The database server is not installed. Install it from the Programs section of Settings.',
        });
      }

      const prefix = `wp_${site.id.replace(/-/g, '').slice(0, 24)}`;
      const existing = await listDatabases({
        db: ctx.app.db,
        vault: ctx.app.vault,
        binDir: ctx.app.config.binDir,
        prefix,
      });

      if (site.databaseLimit !== null && existing.length >= site.databaseLimit) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            `This website can have up to ${site.databaseLimit} ` +
            `${site.databaseLimit === 1 ? 'database' : 'databases'}. Remove one, or ask your ` +
            'administrator to raise the limit.',
        });
      }

      // Databases are named for the site so one site's can never collide with
      // or be mistaken for another's; the user-chosen part follows the prefix.
      const name = assertSafeDbName(`${prefix}_${input.name.toLowerCase()}`);

      try {
        const created = await provisionDatabase({
          db: ctx.app.db,
          vault: ctx.app.vault,
          binDir: ctx.app.config.binDir,
          siteId: site.id,
          name,
          password: input.password,
        });

        return {
          name: created.name,
          username: created.username,
          password: created.password,
          generated: created.generated,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof DatabaseError ? error.message : 'The database could not be created.',
          cause: error,
        });
      }
    }),

  /** Removes a database and the user that could reach it. */
  drop: protectedProcedure
    .input(z.object({ slug: Slug, name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);
      assertSafeDbName(input.name);

      await dropDatabase({
        db: ctx.app.db,
        vault: ctx.app.vault,
        binDir: ctx.app.config.binDir,
        siteId: site.id,
        name: input.name,
      });

      return { ok: true };
    }),

  /**
   * Changes a database's password. Given one, it is used; otherwise a fresh
   * one is generated. Either way it is returned once — it is otherwise only
   * ever in the vault.
   */
  setPassword: protectedProcedure
    .input(z.object({ slug: Slug, name: z.string().min(1), password: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);
      assertSafeDbName(input.name);

      const password = input.password?.trim() ? input.password : generatePassword();
      const generated = !input.password?.trim();

      // Re-provisioning the same name resets its password to the new value.
      await provisionDatabase({
        db: ctx.app.db,
        vault: ctx.app.vault,
        binDir: ctx.app.config.binDir,
        siteId: site.id,
        name: input.name,
        password,
      });

      // A WordPress site keeps its database password in wp-config.php, so it
      // is told about the change in the same breath — changing the database
      // alone would take the site offline until someone edited the file.
      if (site.preset === 'wordpress') {
        await rewriteWpConfigPassword(
          path.join(ctx.app.config.sitesRoot, site.slug),
          password,
        );
      }

      return { name: input.name, password, generated };
    }),

  /** Reveals a database's stored password to its owner. */
  revealPassword: protectedProcedure
    .input(z.object({ slug: Slug, name: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const site = mustGetSite(ctx, input.slug);
      const password = readDatabasePassword(ctx.app.db, ctx.app.vault, site.id, input.name);
      if (!password) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That database was not found.' });
      }
      return { password };
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
});
