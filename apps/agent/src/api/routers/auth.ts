import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { LoginRequest, Password, SetupRequest } from '@winpanel/shared';
import { AuthError } from '../../services/auth-service.js';
import {
  authedProcedure,
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

      // Sign the new owner in immediately so they can finish enrolling TOTP.
      const login = await ctx.app.auth.login({
        username: input.username,
        password: input.password,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      ctx.setSessionCookie(login.token, login.expiresAt);

      return {
        user: result.user,
        totpUri: result.totpUri,
        totpSecret: result.totpSecret,
      };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  /** Confirms the authenticator app works, completing enrolment. */
  confirmTotp: authedProcedure
    .input(z.object({ code: z.string().regex(/^\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      try {
        ctx.app.auth.confirmTotpEnrolment(ctx.user.id, input.code);
        // The setup code is now spent and must not remain readable on disk.
        await ctx.app.auth.destroySetupToken();
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  login: publicAuditedProcedure.input(LoginRequest).mutation(async ({ ctx, input }) => {
    try {
      const result = await ctx.app.auth.login({
        username: input.username,
        password: input.password,
        totp: input.totp,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      ctx.setSessionCookie(result.token, result.expiresAt);
      return { user: result.user };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  logout: authedProcedure.mutation(({ ctx }) => {
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
      try {
        await ctx.app.auth.login({
          username: ctx.user.username,
          password: input.currentPassword,
          ip: ctx.ip,
        });
      } catch {
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

      return { ok: true };
    }),
});
