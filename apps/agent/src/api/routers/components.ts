import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router, superadminProcedure } from '../trpc.js';
import { COMPONENT_CATALOGUE, findComponent } from '../../components/catalogue.js';
import { findExecutable } from '../../components/archive.js';
import { discoverNodeVersions } from '../../sites/node-versions.js';
import { runCommand } from '../../process/run-command.js';
import type { ComponentDefinition } from '@winpanel/shared';

/**
 * The programs the panel drives: web server, mail server, git.
 *
 * Node is in the catalogue but is deliberately not installable here. On a
 * managed server the runtime is the hosting provider's to decide, and a panel
 * that quietly adds a second copy is how a site ends up running on something
 * nobody chose. The panel finds the versions that exist and uses one of them.
 */

const PANEL_MANAGED = new Set([
  'caddy',
  'stalwart',
  'git',
  'pnpm',
  'yarn',
  'bun',
  'vcredist',
  'php',
  'mariadb',
  'composer',
  'adminer',
]);

/** Names each program may go by, matching the installer's own list. */
const EXECUTABLES: Record<string, string[]> = {
  stalwart: ['stalwart.exe', 'stalwart-mail.exe'],
  php: ['php-cgi.exe', 'php.exe'],
  mariadb: ['mariadbd.exe', 'mysqld.exe'],
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

  if (component.kind === 'php-script') {
    // Composer keeps its `.phar` name; Adminer is renamed to `adminer.php`.
    const filename = component.id === 'adminer' ? 'adminer.php' : `${component.id}.phar`;
    const script = path.join(installDir, filename);
    return await fs.access(script).then(() => script, () => null);
  }

  return await findExecutable(installDir, executablesFor(component.id));
}

/** True when a component's program is on disk. Shared with the site wizard. */
export async function isComponentInstalled(binDir: string, id: string): Promise<boolean> {
  const component = findComponent(id);
  if (!component) return false;
  return (await locate(binDir, component)) !== null;
}

/**
 * The VC++ runtime installs itself system-wide and leaves nothing in the
 * panel's folders, so "is it there" is answered by the registry key Windows
 * keeps for installed redistributables, not by looking for a file.
 */
async function isVcredistInstalled(): Promise<boolean> {
  const result = await runCommand({
    exe: 'reg.exe',
    args: [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
      '/v',
      'Installed',
    ],
    timeoutMs: 15_000,
  });

  return result.exitCode === 0 && /Installed\s+REG_DWORD\s+0x1/i.test(result.stdout);
}

export const componentsRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
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

        // The VC++ runtime leaves no file for `locate` to find; its presence
        // is answered by the registry instead.
        const installed = managed
          ? component.id === 'vcredist'
            ? await isVcredistInstalled()
            : executable !== null
          : nodeVersions.length > 0;

        return {
          id: component.id,
          name: component.name,
          description: component.description,
          version: managed
            ? component.version
            : (nodeVersions.map((entry) => entry.version).join(', ') || component.version),
          installed,
          executable,
          serviceName: component.serviceName,
          serviceState,
          /** False for anything the server owns rather than the panel. */
          managed,
        };
      }),
    );
  }),

  install: adminProcedure
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

  /**
   * Removes a program the panel installed.
   *
   * Owner only. Taking away Caddy or the mail server stops every website and
   * every mailbox on the machine at once, which is not something an
   * administrator should be able to do while troubleshooting one site.
   */
  uninstall: superadminProcedure
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
  service: adminProcedure
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
