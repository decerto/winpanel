import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc.js';
import { SiteService, appRootFor } from '../../sites/site-service.js';
import { serviceIdFor } from '../../sites/deploy-handler.js';
import { findExecutable } from '../../components/archive.js';
import { runCommand } from '../../process/run-command.js';
import path from 'node:path';
import { SiteManifest } from '@winpanel/shared';

/**
 * The PHP a website runs on.
 *
 * Separate from the application router because a PHP site is not a Node app:
 * it has no package.json scripts or startup file, and what the page needs to
 * know is which PHP it runs on and whether its pool is up — a much smaller
 * surface.
 */
export const sitePhpRouter = router({
  info: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const service = new SiteService(ctx.app.db, ctx.app.vault, ctx.app.config.sitesRoot);
      const site = service.get(input.slug);
      if (!site) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That website was not found.' });
      }

      const manifest = SiteManifest.parse(site.manifest);

      // The PHP the panel installed, and what it calls itself.
      let phpVersion: string | null = null;
      const phpExe = await findExecutable(path.join(ctx.app.config.binDir, 'php'), ['php.exe']);
      if (phpExe) {
        const result = await runCommand({ exe: phpExe, args: ['--version'], timeoutMs: 15_000 });
        const match = /^PHP (\S+)/.exec(result.stdout.trim());
        phpVersion = match?.[1] ?? null;
      }

      const colour = site.activeColour;
      const serviceState = await ctx.app.services
        .getState(serviceIdFor(site.slug, colour))
        .catch(() => null);

      // Composer is only offered when it is there to run.
      const composerInstalled =
        (await findExecutable(path.join(ctx.app.config.binDir, 'composer'), ['composer.phar'])) !==
        null;

      return {
        runtime: site.runtime,
        phpVersion,
        serviceState,
        documentRoot: appRootFor(ctx.app.config.sitesRoot, site),
        composerInstalled,
        usesComposer: manifest.steps.some((step) => step.command === 'composer'),
      };
    }),
});
