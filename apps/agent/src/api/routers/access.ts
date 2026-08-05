import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { superadminProcedure, router } from '../trpc.js';

/**
 * Who is signed in, and who has been trying to.
 *
 * Everything here is owner-only. The panel is reachable from the internet, so
 * the useful question is not "did anyone get in" but "how hard is anyone
 * knocking" — and that has to be answerable from the panel itself, because the
 * moment it is only answerable over RDP nobody ever looks.
 */
export const accessRouter = router({
  summary: superadminProcedure.query(({ ctx }) => ctx.app.auth.accessSummary()),

  sessions: superadminProcedure.query(({ ctx }) => ctx.app.auth.listSessions(ctx.sessionToken)),

  /** Ends one sign-in. The owner may end their own, including this one. */
  revokeSession: superadminProcedure
    .input(z.object({ sessionId: z.string().regex(/^[0-9a-f]{32}$/) }))
    .mutation(({ ctx, input }) => {
      if (!ctx.app.auth.revokeSessionById(input.sessionId)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That sign-in has already ended.',
        });
      }
      return { ok: true };
    }),

  /** The "I think someone else is in here" button. */
  revokeOtherSessions: superadminProcedure.mutation(({ ctx }) => ({
    revoked: ctx.app.auth.revokeAllSessionsExcept(ctx.sessionToken),
  })),

  attempts: superadminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).default(200),
          onlyFailures: z.boolean().default(false),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      ctx.app.auth.recentLoginAttempts(input?.limit ?? 200, input?.onlyFailures ?? false),
    ),

  blockedAddresses: superadminProcedure.query(({ ctx }) => ctx.app.auth.activeIpBans()),

  /**
   * Lets a blocked address back in.
   *
   * Needed because the address that gets locked out is usually the owner's
   * own: a whole office shares one public IP, so a colleague's three bad
   * guesses lock out everybody behind it.
   */
  unblockAddress: superadminProcedure
    .input(z.object({ ip: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => {
      if (!ctx.app.auth.liftIpBan(input.ip)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That address is not blocked.',
        });
      }
      return { ok: true };
    }),
});
