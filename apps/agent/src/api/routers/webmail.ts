import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc.js';
import {
  MAX_ATTACHMENT_BYTES,
  WebmailClient,
  WebmailError,
  type MailAddress,
} from '../../mail/webmail-client.js';
import { webmailSessions } from '../../mail/webmail-sessions.js';

/**
 * Webmail.
 *
 * The panel proxies every request rather than letting the browser talk to the
 * mail server directly. Two reasons, and both are load-bearing: the mail
 * server's API is bound to loopback so the browser could not reach it anyway,
 * and going through here means the mailbox password is held in this process
 * for the length of a sitting instead of being kept in a browser tab where
 * every other script on the page can read it.
 *
 * Signing in is a mailbox password, not the panel's. They are different
 * credentials for different things, and the panel administrator deliberately
 * cannot read a mailbox without being given its password.
 */

const Token = z.object({ token: z.string().min(1).max(200) });
const SenderInput = Token.extend({
  sender: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
});

const Address = z.object({
  name: z.string().max(200).nullable().default(null),
  email: z.string().email().max(254),
});

/**
 * Removes the parts of an HTML message that try to do something.
 *
 * The panel also renders this inside a sandboxed frame with scripting off,
 * which is what actually stops it running. This pass exists because "the
 * message body is attacker-controlled HTML displayed in an admin panel" is
 * worth being wrong about twice before it becomes a way to take over the
 * server that hosts everything.
 */
export function sanitiseHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    .replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(?:src|srcset|background|poster|data|formaction|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (attribute, doubleQuoted, singleQuoted, bare) => {
        const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
        return /^data:image\/(?:gif|jpeg|png|webp);base64,/i.test(value)
          ? attribute
          : '';
      },
    )
    .replace(
      /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (attribute, doubleQuoted, singleQuoted, bare) => {
        const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
        return /\b(?:url|expression|behavior)\s*\(|-moz-binding\s*:/i.test(value)
          ? ''
          : attribute;
      },
    )
    .replace(
      /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (attribute, doubleQuoted, singleQuoted, bare) => {
        const value = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim();
        return /^(?:https?:|mailto:|tel:|#|\/)/i.test(value) ? attribute : ' href="#"';
      },
    )
    .replace(/(href|src|action)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"');
}

function clientFor(token: string, userId: string): WebmailClient {
  const credentials = webmailSessions.get(token, userId);

  if (!credentials) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Your webmail sitting has ended. Sign in to the mailbox again.',
    });
  }

  return new WebmailClient(credentials.address, credentials.password);
}

function toTrpcError(error: unknown): never {
  if (error instanceof WebmailError) {
    throw new TRPCError({
      code: error.unauthorised ? 'UNAUTHORIZED' : 'BAD_REQUEST',
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

export const webmailRouter = router({
  /**
   * Opens a mailbox.
   *
   * The password is verified against the mail server before a token is issued,
   * so a wrong one fails while somebody is still looking at the field they
   * typed it into.
   */
  signIn: protectedProcedure
    .input(
      z.object({
        address: z.string().email().max(254).transform((value) => value.toLowerCase()),
        password: z.string().min(1).max(512),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await new WebmailClient(input.address, input.password).signIn();
      } catch (error) {
        toTrpcError(error);
      }

      const { token, expiresAt } = webmailSessions.open(ctx.user.id, {
        address: input.address,
        password: input.password,
      });

      return { token, address: input.address, expiresAt: new Date(expiresAt).toISOString() };
    }),

  signOut: protectedProcedure.input(Token).mutation(({ input, ctx }) => {
    webmailSessions.close(input.token, ctx.user.id);
    return { ok: true };
  }),

  folders: protectedProcedure.input(Token).query(async ({ input, ctx }) => {
    try {
      return await clientFor(input.token, ctx.user.id).folders();
    } catch (error) {
      toTrpcError(error);
    }
  }),

  messages: protectedProcedure
    .input(
      Token.extend({
        mailboxId: z.string().min(1).max(200),
        position: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        search: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      try {
        return await clientFor(input.token, ctx.user.id).messages(input);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  message: protectedProcedure
    .input(Token.extend({ id: z.string().min(1).max(200) }))
    .query(async ({ input, ctx }) => {
      try {
        const thread = await clientFor(input.token, ctx.user.id).thread(input.id);
        const message = thread.find((entry) => entry.id === input.id);

        if (!message) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That message is no longer there.' });
        }

        return {
          ...message,
          html: message.html ? sanitiseHtml(message.html) : null,
          thread: thread.map((entry) => ({
            ...entry,
            html: entry.html ? sanitiseHtml(entry.html) : null,
          })),
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
    }),

  setSeen: protectedProcedure
    .input(Token.extend({ ids: z.array(z.string().min(1).max(200)).min(1).max(100), seen: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await clientFor(input.token, ctx.user.id).setSeen(input.ids, input.seen);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  setFlagged: protectedProcedure
    .input(
      Token.extend({
        ids: z.array(z.string().min(1).max(200)).min(1).max(100),
        flagged: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await clientFor(input.token, ctx.user.id).setFlagged(input.ids, input.flagged);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * Moves messages to another folder.
   *
   * Deleting is this, aimed at the bin. Nothing here removes a message
   * outright unless it is already in the bin, because "delete" in every other
   * mail program is recoverable and quietly not being so here would lose
   * somebody's invoice.
   */
  move: protectedProcedure
    .input(
      Token.extend({
        ids: z.array(z.string().min(1).max(200)).min(1).max(100),
        mailboxId: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await clientFor(input.token, ctx.user.id).move(input.ids, input.mailboxId);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /** Permanent removal, offered only from within the bin. */
  destroy: protectedProcedure
    .input(Token.extend({ ids: z.array(z.string().min(1).max(200)).min(1).max(100) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await clientFor(input.token, ctx.user.id).destroy(input.ids);
        return { ok: true };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /**
   * One attachment, base64 for the browser to turn back into a file.
   *
   * Bounded rather than streamed: this whole feature is for reading the
   * occasional message, and a streaming download route would need its own
   * authenticated endpoint outside the API.
   */
  attachment: protectedProcedure
    .input(
      Token.extend({
        blobId: z.string().min(1).max(200),
        size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
        name: z.string().max(255).default('attachment'),
        type: z.string().max(120).default('application/octet-stream'),
      }),
    )
    .query(async ({ input, ctx }) => {
      try {
        const bytes = await clientFor(input.token, ctx.user.id).attachment(input.blobId, input.size);

        return {
          name: input.name,
          // The browser is told a harmless type, so a message cannot get an
          // HTML or script file rendered in the panel's own origin.
          type: /^(image|audio|video|text)\/|^application\/pdf$/.test(input.type)
            ? input.type
            : 'application/octet-stream',
          base64: bytes.toString('base64'),
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  send: protectedProcedure
    .input(
      Token.extend({
        to: z.array(Address).min(1).max(50),
        cc: z.array(Address).max(50).default([]),
        subject: z.string().max(400).default(''),
        text: z.string().max(200_000).default(''),
        inReplyTo: z.string().max(400).nullable().default(null),
        references: z.array(z.string().max(400)).max(50).default([]),
        forwardOf: z.string().min(1).max(200).nullable().default(null),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await clientFor(input.token, ctx.user.id).send({
          to: input.to as MailAddress[],
          cc: input.cc as MailAddress[],
          subject: input.subject,
          text: input.text,
          inReplyTo: input.inReplyTo,
          references: input.references,
          forwardOf: input.forwardOf,
        });

        return { ok: true, note: 'Sent. A copy is in your Sent folder.' };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  blockedSenders: protectedProcedure.input(Token).query(async ({ input, ctx }) => {
    try {
      return await clientFor(input.token, ctx.user.id).blockedSenders();
    } catch (error) {
      toTrpcError(error);
    }
  }),

  blockSender: protectedProcedure.input(SenderInput).mutation(async ({ input, ctx }) => {
    try {
      await clientFor(input.token, ctx.user.id).setSenderBlocked(input.sender, true);
      return { ok: true, sender: input.sender };
    } catch (error) {
      toTrpcError(error);
    }
  }),

  unblockSender: protectedProcedure.input(SenderInput).mutation(async ({ input, ctx }) => {
    try {
      await clientFor(input.token, ctx.user.id).setSenderBlocked(input.sender, false);
      return { ok: true, sender: input.sender };
    } catch (error) {
      toTrpcError(error);
    }
  }),
});
