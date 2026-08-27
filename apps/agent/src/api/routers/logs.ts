import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { listLogFiles, readLogFile } from '../../logs/log-files.js';
import { superadminProcedure, router } from '../trpc.js';

export const logsRouter = router({
  list: superadminProcedure.query(({ ctx }) =>
    listLogFiles(ctx.app.config.logDir, [ctx.app.config.accessLogDir]),
  ),

  read: superadminProcedure
    .input(
      z.object({
        id: z.string().min(1).max(512),
        lines: z.number().int().min(1).max(2000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const result = await readLogFile(ctx.app.config.logDir, input.id, input.lines, [ctx.app.config.accessLogDir]);
      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That panel log was not found.' });
      }
      return result;
    }),
});