import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CheckEngine } from '../../checks/engine.js';
import { buildServerChecks } from '../../checks/server-checks.js';
import { buildSiteHealthChecks } from '../../checks/site-checks.js';
import { FixError, FixRunner } from '../../checks/fixes.js';
import { adminProcedure, router } from '../trpc.js';
import type { DatabaseHandle } from '../../db/index.js';

/**
 * Server health and the fixes that go with it.
 *
 * The engine is built once per process: check definitions are stateless, and
 * the cache inside the engine is what makes the Health page feel instant on
 * revisit. The per-website checks are a dynamic source rather than a fixed
 * registration, so a site created after boot is checked — and a deleted one
 * stops appearing — without the engine being rebuilt.
 */
const engine = new CheckEngine();
engine.registerAll(buildServerChecks());

/** The database the per-website checks read. Set once the app context exists. */
let siteCheckDb: DatabaseHandle | null = null;

export function registerSiteChecks(db: DatabaseHandle): void {
  siteCheckDb = db;
  engine.registerDynamic(() => (siteCheckDb ? buildSiteHealthChecks(siteCheckDb) : []));
}

/** Sentinel used by the "Fix everything safe" button. */
const FIX_ALL_SAFE = '__all_safe__';

export const checksRouter = router({
  run: adminProcedure
    .input(z.object({ useCache: z.boolean().default(false) }).optional())
    .query(async ({ input }) => await engine.runAll({ useCache: input?.useCache ?? false })),

  runOne: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => await engine.runOne(input.id)),

  applyFix: adminProcedure
    .input(z.object({ action: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const runner = new FixRunner(ctx.app.db);

      // "Fix everything safe" deliberately excludes anything that could lock
      // the user out of the machine — those stay one deliberate click each.
      if (input.action === FIX_ALL_SAFE) {
        const results = await engine.runAll();
        const fixable = engine.batchFixable(results);

        const applied: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];

        for (const result of fixable) {
          if (result.fix?.kind !== 'automatic') continue;
          try {
            await runner.apply(result.fix.action, result.id);
            applied.push(result.id);
          } catch (error) {
            // One failure must not abandon the rest; report them all.
            failed.push({
              id: result.id,
              reason: error instanceof Error ? error.message : 'Unknown error.',
            });
          }
        }

        engine.clearCache();
        return { applied, failed };
      }

      const results = await engine.runAll({ useCache: true });
      const match = results.find(
        (result) => result.fix?.kind === 'automatic' && result.fix.action === input.action,
      );

      if (!match) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That fix is not available right now. Refresh and try again.',
        });
      }

      try {
        await runner.apply(input.action, match.id);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof FixError ? error.message : 'The fix could not be applied.',
          cause: error,
        });
      }

      engine.clearCache();
      return { applied: [match.id], failed: [] };
    }),

  /** Changes still in effect, so the user can reverse any of them. */
  appliedChanges: adminProcedure.query(({ ctx }) =>
    new FixRunner(ctx.app.db).listApplied(),
  ),

  undoChange: adminProcedure
    .input(z.object({ changeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await new FixRunner(ctx.app.db).undo(input.changeId);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof FixError ? error.message : 'That change could not be undone.',
          cause: error,
        });
      }
      engine.clearCache();
      return { ok: true };
    }),
});
