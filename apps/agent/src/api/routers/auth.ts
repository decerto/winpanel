import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { LoginRequest, Password, SetupRequest } from '@winpanel/shared';
import { AuthError } from '../../services/auth-service.js';
import {
  protectedProcedure,
  publicAuditedProcedure,
  publicProcedure,
  router,
} from '../trpc.js';

/** Maps an AuthError onto the right tRPC code so the UI can react properly. */
function toTrpcError(error: unknown): never {
  if (error instanceof AuthError) {
    const code =
      error.code === 'throttled'
        ? 'TOO_MANY_REQUESTS'
        : error.code === 'ip-blocked'
          ? 'FORBIDDEN'
          : error.code === 'already-setup'
            ? 'CONFLICT'
            : 'UNAUTHORIZED';
    throw new TRPCError({ code, message: error.message, cause: error });
  }
  throw error;
}

export const authRouter = router({
  /** Drives the login screen: setup wizard, sign-in, or already signed in. */
  state: publicProcedure.query(({ ctx }) => ({
    needsSetup: ctx.app.auth.needsSetup(),
    signedIn: ctx.user !== null,
    user: ctx.user,
    httpsEnabled: ctx.app.config.httpsEnabled,
  })),

  completeSetup: publicAuditedProcedure.input(SetupRequest).mutation(async ({ ctx, input }) => {
    try {
      const result = await ctx.app.auth.completeSetup(input);

      // Sign the new owner in immediately so they can go straight on to
      // enrolling two-factor, or skip it and land in the panel.
      const login = await ctx.app.auth.login({
        username: input.username,
        password: input.password,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      ctx.setSessionCookie(login.token, login.expiresAt);

      return { user: result.user };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  /**
   * Starts two-factor enrolment.
   *
   * The password is re-entered rather than trusting the session: enrolment
   * decides what the second factor will be, so a stolen cookie must not be
   * able to quietly point it at the attacker's own device. Replacing an
   * existing authenticator additionally needs a code from the current one.
   */
  beginTotp: protectedProcedure
    .input(
      z.object({
        password: z.string().min(1).max(1024),
        currentCode: z.string().regex(/^\d{6}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.app.auth.reauthenticate(ctx.user.id, input.password))) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your password is not correct.',
        });
      }

      if (ctx.user.totpEnrolled) {
        if (!input.currentCode) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Enter a code from your current authenticator app.',
          });
        }
        if (!ctx.app.auth.verifyTotpFor(ctx.user.id, input.currentCode)) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'That code is not correct.',
          });
        }
      }

      return ctx.app.auth.beginTotpEnrolment(ctx.user.id);
    }),

  /**
   * Confirms the authenticator app works, completing enrolment.
   *
   * Hands back the recovery codes, which are the only moment they are
   * readable. The panel has to show them before the user goes anywhere else.
   */
  confirmTotp: protectedProcedure
    .input(z.object({ code: z.string().regex(/^\d{6}$/) }))
    .mutation(({ ctx, input }) => {
      try {
        return { ok: true, recoveryCodes: ctx.app.auth.confirmTotpEnrolment(ctx.user.id, input.code) };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /** How many recovery codes are left, for the reminder in the panel. */
  recoveryCodeStatus: protectedProcedure.query(({ ctx }) =>
    ctx.app.auth.recoveryCodeStatus(ctx.user.id),
  ),

  /**
   * Issues a fresh set of recovery codes, invalidating the old ones.
   *
   * Guarded like the other second-factor changes: the codes are a way past
   * two-factor, so being able to mint new ones is as good as holding the
   * authenticator.
   */
  regenerateRecoveryCodes: protectedProcedure
    .input(
      z.object({
        password: z.string().min(1).max(1024),
        code: z.string().regex(/^\d{6}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.app.auth.reauthenticate(ctx.user.id, input.password))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your password is not correct.' });
      }

      if (!ctx.app.auth.verifyTotpFor(ctx.user.id, input.code)) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not correct.' });
      }

      return { recoveryCodes: ctx.app.auth.issueRecoveryCodes(ctx.user.id) };
    }),

  /** Throws away an enrolment the user started and backed out of. */
  cancelTotp: protectedProcedure.mutation(({ ctx }) => {
    ctx.app.auth.cancelTotpEnrolment(ctx.user.id);
    return { ok: true };
  }),

  /**
   * Turns two-factor authentication off.
   *
   * Both factors are required to give one of them up, so neither a stolen
   * session nor a stolen password is enough to strip the account back to a
   * single factor.
   */
  disableTotp: protectedProcedure
    .input(
      z.object({
        password: z.string().min(1).max(1024),
        code: z.string().regex(/^\d{6}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.app.auth.reauthenticate(ctx.user.id, input.password))) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your password is not correct.',
        });
      }

      if (!ctx.app.auth.verifyTotpFor(ctx.user.id, input.code)) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'That code is not correct.' });
      }

      ctx.app.auth.disableTotp(ctx.user.id);
      return { ok: true };
    }),

  login: publicAuditedProcedure.input(LoginRequest).mutation(async ({ ctx, input }) => {
    try {
      const result = await ctx.app.auth.login({
        username: input.username,
        password: input.password,
        totp: input.totp,
        recoveryCode: input.recoveryCode,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      ctx.setSessionCookie(result.token, result.expiresAt);
      return { user: result.user };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  logout: protectedProcedure.mutation(({ ctx }) => {
    ctx.app.auth.logout(ctx.sessionToken);
    ctx.clearSessionCookie();
    return { ok: true };
  }),

  me: protectedProcedure.query(({ ctx }) => ctx.user),

  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1), newPassword: Password }))
    .mutation(async ({ ctx, input }) => {
      // Re-authenticate rather than trusting the session alone, so a stolen
      // cookie cannot be escalated into permanent account takeover.
      if (!(await ctx.app.auth.reauthenticate(ctx.user.id, input.currentPassword))) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your current password is not correct.',
        });
      }

      const { hashPassword } = await import('../../security/password.js');
      const { eq } = await import('drizzle-orm');

      ctx.app.db.db
        .update(ctx.app.schema.users)
        .set({ passwordHash: await hashPassword(input.newPassword) })
        .where(eq(ctx.app.schema.users.id, ctx.user.id))
        .run();

      // Changing the password is what someone does when they think the
      // account is compromised, so anyone else holding a cookie is put out.
      ctx.app.auth.revokeOtherSessions(ctx.user.id, ctx.sessionToken);

      return { ok: true };
    }),
});
