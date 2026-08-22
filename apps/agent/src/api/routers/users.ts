import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CreateUserRequest,
  Password,
  UpdateUserRequest,
  UserRole,
  roleAtLeast,
} from '@winpanel/shared';
import { AuthError } from '../../services/auth-service.js';
import { adminProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';

/**
 * The people who can sign in to this server.
 *
 * Two rules run through everything here, and they are what stop the page
 * becoming a privilege ladder:
 *
 *   1. Nobody may create or change an account at or above their own level.
 *      An administrator manages customers; only the owner manages
 *      administrators and other owners.
 *   2. Nobody may change their own role or switch themselves off. Otherwise
 *      the "last owner" guard is one careless click away from a server with
 *      nobody left who can manage it.
 */

function toTrpcError(error: unknown): never {
  if (error instanceof AuthError) {
    throw new TRPCError({
      code:
        error.code === 'username-taken'
          ? 'CONFLICT'
          : error.code === 'not-found'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST',
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

/** Refuses a change aimed at somebody the caller does not outrank. */
function assertOutranks(ctx: RequestContext, targetRole: UserRole): void {
  const actor = ctx.user;
  if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in.' });
  if (actor.role === 'superadmin') return;

  if (roleAtLeast(targetRole, actor.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the owner of this server can manage administrators.',
    });
  }
}

function assertNotSelf(ctx: RequestContext, userId: string, what: string): void {
  if (ctx.user?.id === userId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `You cannot ${what} your own account.`,
    });
  }
}

export const usersRouter = router({
  list: adminProcedure.query(({ ctx }) => ctx.app.auth.listUsers()),

  /**
   * Creates an account.
   *
   * The password is chosen by whoever creates the account and handed over out
   * of band. There is deliberately no emailed invitation: a brand new server
   * often cannot send mail yet, and an invite link that never arrives is a
   * worse first experience than a password read down the phone.
   */
  create: adminProcedure.input(CreateUserRequest).mutation(async ({ ctx, input }) => {
    assertOutranks(ctx, input.role);

    try {
      return await ctx.app.auth.createUser({
        username: input.username,
        password: input.password,
        role: input.role,
        siteLimit: input.siteLimit,
        mailQuotaBytes: input.mailQuotaBytes,
        siteDiskQuotaBytes: input.siteDiskQuotaBytes,
        gameServerLimit: input.gameServerLimit,
        gameServerProviders: input.gameServerProviders,
        createdBy: ctx.user?.id ?? null,
      });
    } catch (error) {
      toTrpcError(error);
    }
  }),

  update: adminProcedure.input(UpdateUserRequest).mutation(({ ctx, input }) => {
    const target = ctx.app.auth.getUser(input.userId);
    if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

    assertOutranks(ctx, target.role);
    if (input.role !== undefined) assertOutranks(ctx, input.role);
    if (input.role !== undefined) assertNotSelf(ctx, input.userId, 'change the role of');
    if (input.disabled !== undefined) assertNotSelf(ctx, input.userId, 'switch off');

    try {
      const { userId, ...changes } = input;
      return ctx.app.auth.updateUser(userId, changes);
    } catch (error) {
      toTrpcError(error);
    }
  }),

  /**
   * Sets somebody else's password.
   *
   * Kept apart from `update` so it cannot happen by accident as part of a
   * quota edit, and because it ends every session that account has open.
   */
  setPassword: adminProcedure
    .input(z.object({ userId: z.string().uuid(), password: Password }))
    .mutation(async ({ ctx, input }) => {
      const target = ctx.app.auth.getUser(input.userId);
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

      assertOutranks(ctx, target.role);
      assertNotSelf(ctx, input.userId, 'reset the password of');

      try {
        await ctx.app.auth.setPassword(input.userId, input.password);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Removes an account.
   *
   * Their websites stay. Deleting somebody's hosting because their login was
   * tidied up would be an unrecoverable surprise; the sites fall back to the
   * server instead, where an admin can reassign or remove them deliberately.
   */
  remove: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      const target = ctx.app.auth.getUser(input.userId);
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

      assertOutranks(ctx, target.role);
      assertNotSelf(ctx, input.userId, 'delete');

      try {
        ctx.app.auth.deleteUser(input.userId);
        return { ok: true, sitesReleased: target.siteCount };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Hands a website to somebody else.
   *
   * The one way a site changes hands, and the reason deleting an account does
   * not delete its sites. Passing `userId: null` gives it back to the server.
   */
  assignSite: adminProcedure
    .input(z.object({ slug: z.string().min(1).max(64), userId: z.string().uuid().nullable() }))
    .mutation(({ ctx, input }) => {
      const site = ctx.app.sites.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such website.' });

      if (input.userId !== null) {
        const target = ctx.app.auth.getUser(input.userId);
        if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

        if (target.siteLimit !== null && target.siteCount >= target.siteLimit) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${target.username} is already at their limit of ${target.siteLimit} ` +
              `${target.siteLimit === 1 ? 'website' : 'websites'}. Raise it first.`,
          });
        }
      }

      ctx.app.sites.setOwner(site.id, input.userId);
      return { ok: true };
    }),
});
