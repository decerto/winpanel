import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { superadminProcedure, router } from '../trpc.js';

const emailAddress = z.string().trim().email().max(254);

const panelEmail = z.object({
  mode: z.enum(['local', 'external']),
  fromAddress: emailAddress,
  fromName: z.string().trim().max(120).default('WinPanel'),
  smtpHost: z.string().trim().max(253).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSecurity: z.enum(['none', 'starttls', 'tls']).nullable().optional(),
  smtpUsername: z.string().trim().max(320).nullable().optional(),
  /** Empty means remove it; omitted preserves the currently stored password. */
  smtpPassword: z.string().max(1024).nullable().optional(),
});

function mailError(error: unknown): never {
  if (error instanceof Error) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}

export const notificationsRouter = router({
  settings: superadminProcedure.query(({ ctx }) => ctx.app.mailer.getSettings()),

  saveSettings: superadminProcedure.input(panelEmail).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.app.mailer.configure(input);
    } catch (error) {
      mailError(error);
    }
  }),

  test: superadminProcedure
    .input(z.object({ recipient: emailAddress }))
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.app.mailer.send({
          to: { name: null, email: input.recipient.toLowerCase() },
          subject: 'WinPanel test email',
          text:
            'This is a test message from WinPanel. Your panel email settings are working.',
          html: '<p>This is a test message from <strong>WinPanel</strong>.</p><p>Your panel email settings are working.</p>',
        });
        return { ok: true };
      } catch (error) {
        mailError(error);
      }
    }),
});
