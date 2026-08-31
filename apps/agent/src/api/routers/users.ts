import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CreateUserRequest,
  Password,
  UpdateUserRequest,
  UserRole,
  roleAtLeast,
  type SiteSource,
} from '@winpanel/shared';
import { AuthError } from '../../services/auth-service.js';
import { passwordResetByAdminEmail } from '../../mail/templates.js';
import { isSshUrl } from '../../sites/ssh-keys.js';
import { DatabaseAllocationError } from '../../databases/errors.js';
import {
  assertDatabaseStorageAllocation,
  databaseUsedBytesForOwner,
} from '../../databases/service.js';
import { listDatabasesForSite, reassignSiteDatabases } from '../../databases/store.js';
import { adminProcedure, router } from '../trpc.js';
import type { RequestContext } from '../trpc.js';
import { sendVerificationEmail } from './auth.js';

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
  list: adminProcedure.query(async ({ ctx }) => {
    const context = { db: ctx.app.db, vault: ctx.app.vault, binDir: ctx.app.config.binDir };
    const people = ctx.app.auth.listUsers();

    return await Promise.all(
      people.map(async (person) => ({
        ...person,
        databaseUsedBytes:
          person.role === 'user' ? await databaseUsedBytesForOwner(context, person.id) : null,
      })),
    );
  }),

  /**
   * Creates an account.
   *
   * The password is chosen by whoever creates the account and handed over out
   * of band. When an email is supplied, the account also receives the normal
   * verification link so recovery and panel alerts can be used after it is
   * confirmed. A mail delivery failure must not undo account creation.
   */
  create: adminProcedure.input(CreateUserRequest).mutation(async ({ ctx, input }) => {
    assertOutranks(ctx, input.role);

    try {
      const created = await ctx.app.auth.createUser({
        username: input.username,
        password: input.password,
        role: input.role,
        email: input.email,
        siteLimit: input.siteLimit,
        subdomainLimit: input.subdomainLimit,
        mailboxLimit: input.mailboxLimit,
        mailQuotaBytes: input.mailQuotaBytes,
        siteDiskQuotaBytes: input.siteDiskQuotaBytes,
        gameServerLimit: input.gameServerLimit,
        databaseLimit: input.databaseLimit,
        databaseQuotaBytes: input.databaseQuotaBytes,
        gameServerProviders: input.gameServerProviders,
        createdBy: ctx.user?.id ?? null,
      });

      let verificationSent = false;
      if (created.email) {
        const verification = ctx.app.auth.createEmailVerificationToken(created.id);
        if (verification) verificationSent = await sendVerificationEmail(ctx, verification);
      }
      return { ...created, verificationSent };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  update: adminProcedure.input(UpdateUserRequest).mutation(async ({ ctx, input }) => {
    const target = ctx.app.auth.getUser(input.userId);
    if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

    assertOutranks(ctx, target.role);
    if (input.role !== undefined) assertOutranks(ctx, input.role);
    if (input.role !== undefined) assertNotSelf(ctx, input.userId, 'change the role of');
    if (input.disabled !== undefined) assertNotSelf(ctx, input.userId, 'switch off');

    try {
      const { userId, ...changes } = input;
      const wantedEmail =
        input.email === undefined ? undefined : input.email?.trim().toLowerCase() ?? null;
      const emailChanged = wantedEmail !== undefined && wantedEmail !== target.email;
      const updated = ctx.app.auth.updateUser(userId, {
        ...changes,
        ...(wantedEmail === undefined ? {} : { email: wantedEmail }),
      });

      let verificationSent = false;
      if (emailChanged && updated.email) {
        const verification = ctx.app.auth.createEmailVerificationToken(updated.id);
        if (verification) verificationSent = await sendVerificationEmail(ctx, verification);
      }
      return { ...updated, verificationSent };
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
      const profile = ctx.app.auth.getProfile(input.userId);

      try {
        await ctx.app.auth.setPassword(input.userId, input.password);
      } catch (error) {
        toTrpcError(error);
      }

      if (profile.email && profile.emailVerified) {
        const message = passwordResetByAdminEmail({
          username: target.username,
          administrator: ctx.user.username,
        });
        try {
          await ctx.app.mailer.send({
            to: { name: target.username, email: profile.email },
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
        } catch {
          // The reset succeeded; an unavailable notification transport must
          // not turn it into an error or invite a second reset attempt.
        }
      }

      return { ok: true };
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
   *
   * Nothing is done to the stored repository credentials, because there is
   * nothing to do: an access token belongs to the person who added it, so it
   * neither follows the website to its new owner nor is taken away from
   * whoever set the site up. The new owner adds their own.
   */
  assignSite: adminProcedure
    .input(z.object({ slug: z.string().min(1).max(64), userId: z.string().uuid().nullable() }))
    .mutation(({ ctx, input }) => {
      const site = ctx.app.sites.get(input.slug);
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such website.' });

      if (site.parentSiteId !== null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Subdomains follow their parent website and cannot be assigned separately.',
        });
      }

      const children = ctx.app.sites.childrenFor(site.id);
      const relatedSites = [site, ...children];
      const additionalSites = site.ownerUserId === input.userId ? 0 : 1;
      const additionalSubdomains = children.filter(
        (child) => child.ownerUserId !== input.userId,
      ).length;

      if (input.userId !== null) {
        const target = ctx.app.auth.getUser(input.userId);
        if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

        if (
          target.siteLimit !== null &&
          target.siteCount + additionalSites > target.siteLimit
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${target.username} is already at their limit of ${target.siteLimit} ` +
              `${target.siteLimit === 1 ? 'website' : 'websites'}. Raise it first.`,
          });
        }

        if (
          target.subdomainLimit !== null &&
          target.subdomainCount + additionalSubdomains > target.subdomainLimit
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${target.username} is already at their limit of ${target.subdomainLimit} ` +
              `${target.subdomainLimit === 1 ? 'subdomain' : 'subdomains'}. Raise it first.`,
          });
        }

        const siteDatabases = relatedSites.flatMap((relatedSite) =>
          listDatabasesForSite(ctx.app.db, relatedSite.id),
        );
        const databasesToTransfer = siteDatabases.filter(
          (database) => database.ownerUserId !== input.userId,
        ).length;
        if (
          target.databaseLimit !== null &&
          target.databaseCount + databasesToTransfer > target.databaseLimit
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `${target.username} cannot take this website because its databases would exceed ` +
              `their limit of ${target.databaseLimit}. Raise it first.`,
          });
        }

        try {
          assertDatabaseStorageAllocation(
            { db: ctx.app.db, vault: ctx.app.vault, binDir: ctx.app.config.binDir },
            input.userId,
            siteDatabases.map((database) => database.sizeLimitBytes),
            siteDatabases.map((database) => database.id),
          );
        } catch (error) {
          if (error instanceof DatabaseAllocationError) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `${target.username} cannot take this website. ${error.message}`,
              cause: error,
            });
          }
          throw error;
        }
      }

      for (const relatedSite of relatedSites) {
        ctx.app.sites.setOwner(relatedSite.id, input.userId);
      }

      /*
       * The databases go with it. They were made for this website and are
       * named after it, and leaving them behind is worse than untidy: the new
       * owner cannot see the password their own site is using, while the
       * previous owner still can.
       */
      const databases = relatedSites.reduce(
        (total, relatedSite) =>
          total + reassignSiteDatabases(ctx.app.db, relatedSite.id, input.userId),
        0,
      );

      const needsOwnGitAccess = relatedSites.some((relatedSite) => {
        const source = relatedSite.source as SiteSource;
        const isSsh = source.kind === 'git' && isSshUrl(source.url);
        return (
          source.kind === 'git' &&
          !isSsh &&
          input.userId !== null &&
          !ctx.app.sites
            .gitTokenHolders(relatedSite.id)
            .some((holder) => holder.userId === input.userId)
        );
      });

      return { ok: true, needsOwnGitAccess, databases };
    }),
});
