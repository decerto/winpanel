import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc.js';
import { COMPONENT_CATALOGUE, findComponent } from '../../components/catalogue.js';
import { findExecutable } from '../../components/archive.js';
import { discoverNodeVersions } from '../../sites/node-versions.js';
import type { ComponentDefinition } from '@winpanel/shared';

/**
 * The programs the panel drives: web server, mail server, git.
 *
 * Node is in the catalogue but is deliberately not installable here. On a
 * managed server the runtime is the hosting provider's to decide, and a panel
 * that quietly adds a second copy is how a site ends up running on something
 * nobody chose. The panel finds the versions that exist and uses one of them.
 */

const PANEL_MANAGED = new Set(['caddy', 'stalwart', 'git', 'pnpm', 'yarn', 'bun']);

/** Names each program may go by, matching the installer's own list. */
const EXECUTABLES: Record<string, string[]> = {
  stalwart: ['stalwart.exe', 'stalwart-mail.exe'],
};

function executablesFor(id: string): string[] {
  return EXECUTABLES[id] ?? [`${id}.exe`];
}

/** Where a component's program landed, or null if it is not installed. */
async function locate(binDir: string, component: ComponentDefinition): Promise<string | null> {
  const installDir = path.join(binDir, component.id);

  if (component.kind === 'node-script') {
    const script = path.join(installDir, `${component.id}.js`);
    return await fs.access(script).then(() => script, () => null);
  }

  return await findExecutable(installDir, executablesFor(component.id));
}

export const componentsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    // Node is not installed by the panel, so "is it there" means "did we find
    // one", not "did we put one there".
    const nodeVersions = await discoverNodeVersions(ctx.app.config.binDir);

    return await Promise.all(
      COMPONENT_CATALOGUE.map(async (component) => {
        const executable = await locate(ctx.app.config.binDir, component);

        const serviceState = component.serviceName
          ? await ctx.app.services.getState(component.serviceName)
          : null;

        const managed = PANEL_MANAGED.has(component.id);

        return {
          id: component.id,
          name: component.name,
          description: component.description,
          version: managed
            ? component.version
            : (nodeVersions.map((entry) => entry.version).join(', ') || component.version),
          installed: managed ? executable !== null : nodeVersions.length > 0,
          executable,
          serviceName: component.serviceName,
          serviceState,
          /** False for anything the server owns rather than the panel. */
          managed,
        };
      }),
    );
  }),

  install: protectedProcedure
    .input(z.object({ componentId: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const component = findComponent(input.componentId);

      if (!component || !PANEL_MANAGED.has(component.id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That program is not one the panel installs.',
        });
      }

      const jobId = ctx.app.jobs.enqueue({
        kind: 'install-component',
        title: `Installing ${component.name}`,
        payload: { componentId: component.id },
      });

      return { jobId };
    }),

  uninstall: protectedProcedure
    .input(z.object({ componentId: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const component = findComponent(input.componentId);

      if (!component || !PANEL_MANAGED.has(component.id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That program is not one the panel installs.',
        });
      }

      const jobId = ctx.app.jobs.enqueue({
        kind: 'uninstall-component',
        title: `Removing ${component.name}`,
        payload: { componentId: component.id },
      });

      return { jobId };
    }),

  /** Start, stop or restart the Windows service a component runs as. */
  service: protectedProcedure
    .input(z.object({ componentId: z.string().min(1), action: z.enum(['start', 'stop', 'restart']) }))
    .mutation(async ({ ctx, input }) => {
      const component = findComponent(input.componentId);

      if (!component?.serviceName) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That program does not run as a service.',
        });
      }

      // A half-finished install leaves the program on disk with no service
      // registered, and "start" would then fail with a path nobody recognises.
      if ((await ctx.app.services.getState(component.serviceName)) === 'not-installed') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            `${component.name} is not registered as a Windows service. Install it again to ` +
            'register it.',
        });
      }

      try {
        await ctx.app.services[input.action](component.serviceName);
        return { ok: true, state: await ctx.app.services.getState(component.serviceName) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'The service did not respond.',
          cause: error,
        });
      }
    }),
});
