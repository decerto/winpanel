import type { SiteManifest } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import { sites } from '../db/schema.js';
import { isPortAnswered, type PortProbe } from '../windows/service-probe.js';
import { readServiceState } from '../windows/service-manager.js';
import { runCommand } from '../process/run-command.js';
import { siteServiceId } from '../windows/panel-services.js';
import type { CheckDefinition, CheckOutcome } from './engine.js';

/**
 * Per-website health: the check that says a site is down even when everything
 * server-level is green.
 *
 * Every server-level check can pass while one website serves a 502 — its own
 * process is the only thing that has to be wrong, and a process is per-site.
 * This is the check that closes that gap, and it deliberately probes two
 * different addresses because they fail independently:
 *
 *   - The application port. Nothing answering there is the dead-process case:
 *     the site is down on its domain *and* its preview.
 *   - The preview port. The preview is a plain-HTTP listener on a bare IP with
 *     its own proxy in the web server's config, and it can be broken — config
 *     not applied, upstream pointing at the previous colour's port — while the
 *     domain keeps working. That is exactly the failure that produced "the
 *     preview isn't working but the site is fine", and it is invisible without
 *     looking at the preview directly.
 *
 * A site the user has disabled, or one that has never been given a port, is
 * not reported broken: there is nothing that ought to be answering.
 */

/** Runtimes with a process the panel supervises and so a port to probe. */
const PROCESS_RUNTIMES = new Set(['node', 'dotnet', 'php']);

interface SiteRow {
  slug: string;
  displayName: string;
  runtime: string;
  enabled: boolean;
  activeColour: 'blue' | 'green';
  portBlue: number | null;
  portGreen: number | null;
  previewPort: number | null;
  manifest: SiteManifest;
}

function activePortOf(site: SiteRow): number | null {
  return site.activeColour === 'blue' ? site.portBlue : site.portGreen;
}

/** Whether the site's own Windows service reports running. */
async function serviceRunning(serviceId: string): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;

  const result = await runCommand({ exe: 'sc.exe', args: ['query', serviceId], timeoutMs: 15_000 });
  if (result.exitCode !== 0) return null;
  return readServiceState(result.stdout) === 'running';
}

/**
 * Builds one check per website that has a process to keep alive.
 *
 * The list is rebuilt by the engine's caller, not cached here, so a site added
 * after boot is checked like any other. Each check is independent: one site's
 * probe timing out must not hold up — or take down — the others.
 */
export function buildSiteHealthChecks(
  db: DatabaseHandle,
  probe: PortProbe = isPortAnswered,
): CheckDefinition[] {
  const rows = db.db
    .select({
      slug: sites.slug,
      displayName: sites.displayName,
      runtime: sites.runtime,
      enabled: sites.enabled,
      activeColour: sites.activeColour,
      portBlue: sites.portBlue,
      portGreen: sites.portGreen,
      previewPort: sites.previewPort,
      manifest: sites.manifest,
    })
    .from(sites)
    .all() as SiteRow[];

  const checks: CheckDefinition[] = [];

  for (const site of rows) {
    if (!PROCESS_RUNTIMES.has(site.runtime)) continue;

    const activePort = activePortOf(site);

    checks.push({
      id: `site.${site.slug}.serving`,
      category: 'site',
      name: `${site.displayName} is serving`,
      plainDescription:
        `The program behind ${site.displayName} has to be running and answering for the ` +
        'site to load. Its domain and its preview address are checked separately, because ' +
        'either can break on its own.',
      ttlSeconds: 30,
      run: async (): Promise<CheckOutcome> => {
        if (!site.enabled) {
          return { state: 'ok', detail: 'This website is switched off.' };
        }

        // A site that was never given a port has never been deployed; the
        // deploy flow already says so, and there is nothing to probe.
        if (activePort === null) {
          return { state: 'absent', detail: 'Not deployed yet.' };
        }

        const appAnswered = await probe(activePort);

        /*
         * The preview is probed on the server's own loopback rather than the
         * public IP: the firewall deliberately blocks the preview band from
         * some networks, and a check that went out and back in would report a
         * firewall rule as a broken site. Locally it tests exactly the part
         * that breaks — the listener and its proxy — and nothing else.
         */
        const previewAnswered =
          site.previewPort === null ? null : await probe(site.previewPort);

        if (appAnswered && previewAnswered !== false) {
          return { state: 'ok', detail: 'The site and its preview both answer.' };
        }

        // The site serves nothing at all: the application process is down.
        if (!appAnswered) {
          const serviceId = siteServiceId(site.slug, site.activeColour);
          const running = await serviceRunning(serviceId);

          return {
            state: 'blocked',
            detail:
              running === true
                ? 'Its background program says running, but nothing answers on its port.'
                : 'Its background program is not answering.',
            reason:
              'The site is down on its address and its preview. This is usually the ' +
              'program having crashed after starting — restarting the app nearly always ' +
              'brings it back.',
            fix: {
              kind: 'manual',
              label: 'Restart the website',
              instructions:
                `Open ${site.displayName}, go to its Application page, and press ` +
                '\u201cRestart app\u201d. Whoever owns the site can do this — it only ever ' +
                'restarts this one website. If it will not stay running, open the ' +
                'site\u2019s Logs to see why it stopped.',
            },
            siteSlug: site.slug,
          };
        }

        // The app answers but the preview does not: the live site is fine and
        // only the IP-and-port address is broken.
        return {
          state: 'warning',
          detail: 'The site works, but its preview address does not.',
          reason:
            `The program is running, but nothing answers on the preview port ` +
            `${site.previewPort ?? 0}. Re-applying the web server configuration rebuilds ` +
            'the preview route.',
          fix: {
            kind: 'manual',
            label: 'Rebuild the web server configuration',
            instructions:
              'Open the Health page and run "Reapply the website configuration", or ' +
              'restart the web server from Background programs in Settings.',
          },
          siteSlug: site.slug,
        };
      },
    });
  }

  return checks;
}
