import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { LoginRequest, Password, SetupRequest } from '@winpanel/shared';
import { AuthError } from '../../services/auth-service.js';
import { webmailSessions } from '../../mail/webmail-sessions.js';
import {
  emailVerificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
} from '../../mail/templates.js';
import {
  protectedProcedure,
  publicAuditedProcedure,
  publicProcedure,
  router,
} from '../trpc.js';
import type { RequestContext } from '../trpc.js';

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
            : error.code === 'invalid-input' || error.code === 'invalid-token'
              ? 'BAD_REQUEST'
              : error.code === 'not-found'
                ? 'NOT_FOUND'
                : 'UNAUTHORIZED';
    throw new TRPCError({ code, message: error.message, cause: error });
  }
  throw error;
}

function panelLink(baseUrl: string, path: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(
  ctx: RequestContext,
  verification: { token: string; username: string; email: string },
): Promise<boolean> {
  const message = emailVerificationEmail({
    username: verification.username,
    link: panelLink(ctx.baseUrl, '/verify-email', verification.token),
  });

  try {
    await ctx.app.mailer.send({
      to: { name: verification.username, email: verification.email },
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return true;
  } catch {
    return false;
  }
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
    webmailSessions.closeForUser(ctx.user.id);
    ctx.clearSessionCookie();
    return { ok: true };
  }),

  me: protectedProcedure.query(({ ctx }) => ctx.user),

  profile: protectedProcedure.query(({ ctx }) => ctx.app.auth.getProfile(ctx.user.id)),

  updateProfile: protectedProcedure
    .input(
      z.object({
        email: z.string().trim().email().max(254).nullable().optional(),
        outageNotifications: z.boolean(),
        currentPassword: z.string().min(1).max(1024).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = ctx.app.auth.getProfile(ctx.user.id);
      const wantedEmail = input.email === undefined ? undefined : input.email?.toLowerCase() ?? null;
      const emailChanged = wantedEmail !== undefined && wantedEmail !== before.email;

      if (emailChanged) {
        if (!input.currentPassword) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Enter your current password to change the account email.',
          });
        }
        if (!(await ctx.app.auth.reauthenticate(ctx.user.id, input.currentPassword))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your password is not correct.' });
        }
      }

      try {
        const profile = ctx.app.auth.updateProfile(ctx.user.id, {
          email: wantedEmail,
          outageNotifications: input.outageNotifications,
        });
        let verificationSent = false;

        if (emailChanged && profile.email) {
          const verification = ctx.app.auth.createEmailVerificationToken(ctx.user.id);
          if (verification) verificationSent = await sendVerificationEmail(ctx, verification);
        }

        return { profile, verificationSent };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  resendEmailVerification: protectedProcedure.mutation(async ({ ctx }) => {
    const verification = ctx.app.auth.createEmailVerificationToken(ctx.user.id);
    if (!verification) return { sent: false };
    return { sent: await sendVerificationEmail(ctx, verification) };
  }),

  verifyEmail: publicAuditedProcedure
    .input(z.object({ token: z.string().min(16).max(256) }))
    .mutation(({ ctx, input }) => {
      try {
        return { ok: true, profile: ctx.app.auth.verifyEmailToken(input.token) };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  requestPasswordReset: publicAuditedProcedure
    .input(z.object({ email: z.string().trim().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.app.auth.canRequestPasswordReset(ctx.ip, input.email)) return { ok: true };

      const reset = ctx.app.auth.createPasswordResetToken(input.email);
      if (reset) {
        const message = passwordResetEmail({
          username: reset.username,
          link: panelLink(ctx.baseUrl, '/reset-password', reset.token),
        });
        try {
          await ctx.app.mailer.send({
            to: { name: reset.username, email: reset.email },
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
        } catch {
          // The same response is returned for an unknown address and a
          // delivery failure, so this endpoint cannot be used to enumerate
          // accounts. The owner can fix delivery on Settings.
        }
      }
      return { ok: true };
    }),

  resetPassword: publicAuditedProcedure
    .input(z.object({ token: z.string().min(16).max(256), password: Password }))
    .mutation(async ({ ctx, input }) => {
      let reset: { username: string; email: string | null };
      try {
        reset = await ctx.app.auth.resetPassword(input.token, input.password);
      } catch (error) {
        toTrpcError(error);
      }

      if (reset.email) {
        const message = passwordChangedEmail({ username: reset.username });
        try {
          await ctx.app.mailer.send({
            to: { name: reset.username, email: reset.email },
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
        } catch {
          // The password change has succeeded; delivery is best effort.
        }
      }

      return { ok: true };
    }),

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

      const profile = ctx.app.auth.getProfile(ctx.user.id);
      if (profile.email && profile.emailVerified) {
        const message = passwordChangedEmail({ username: ctx.user.username });
        try {
          await ctx.app.mailer.send({
            to: { name: ctx.user.username, email: profile.email },
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
        } catch {
          // Password changes must not fail because the notification transport is down.
        }
      }

      return { ok: true };
    }),
});
