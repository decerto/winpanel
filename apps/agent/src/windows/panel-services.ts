import { COMPONENT_CATALOGUE } from '../components/catalogue.js';
import { runCommand, runDetached } from '../process/run-command.js';

/**
 * Everything WinPanel leaves running on the machine.
 *
 * The panel is not one process. It is the agent, the web server, the mail
 * server, and a service per website per colour — all headless, all in session
 * 0, none of them visible as a window. That is fine while it is working and
 * miserable when it is not: an upgrade or an uninstall stalls on "the file is
 * in use" naming a folder rather than a program, and the user has no way to
 * find out what is holding it.
 *
 * So the set is discovered from Windows itself rather than assembled from what
 * the panel believes it installed. A service left behind by a half-finished
 * deployment is exactly the thing that blocks removal, and it is precisely the
 * thing a list built from the database would miss.
 *
 * Stopping goes through sc.exe rather than the WinSW wrapper for the same
 * reason: the wrapper for an orphaned service may be gone, and the service
 * would then be unstoppable from here. An sc.exe stop is also a *requested*
 * stop, so WinSW's restart-on-failure policy does not fight it.
 */

export const PANEL_SERVICE_PREFIX = 'winpanel-';
export const AGENT_SERVICE_ID = 'winpanel-agent';

export type PanelServiceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown';

/** What a service is for. Also decides the order things are stopped in. */
export type PanelServiceKind = 'site' | 'component' | 'other' | 'panel';

export interface PanelService {
  id: string;
  label: string;
  kind: PanelServiceKind;
  state: PanelServiceState;
}

/**
 * Websites first, then the servers they depend on, then the panel itself.
 * Stopping the panel first would leave nothing able to report what happened.
 */
const STOP_ORDER: Record<PanelServiceKind, number> = {
  site: 0,
  component: 1,
  other: 2,
  panel: 3,
};

function toState(word: string): PanelServiceState {
  switch (word.toUpperCase()) {
    case 'RUNNING':
      return 'running';
    case 'STOPPED':
      return 'stopped';
    case 'START_PENDING':
      return 'starting';
    case 'STOP_PENDING':
      return 'stopping';
    default:
      return 'unknown';
  }
}

/** Turns a service id into something worth showing a person. */
export function describePanelService(id: string): { label: string; kind: PanelServiceKind } {
  const lower = id.toLowerCase();

  if (lower === AGENT_SERVICE_ID) return { label: 'Control panel', kind: 'panel' };

  const component = COMPONENT_CATALOGUE.find(
    (candidate) => candidate.serviceName?.toLowerCase() === lower,
  );
  if (component) return { label: component.name, kind: 'component' };

  const site = /^winpanel-site-(.+)-(blue|green)$/.exec(lower);
  if (site?.[1] && site[2]) {
    return { label: `Website: ${site[1]} (${site[2]})`, kind: 'site' };
  }

  return { label: id, kind: 'other' };
}

/**
 * Reads `sc.exe query` output.
 *
 * Separated from the command so it can be tested without a Windows machine.
 * `STATE` is the last line of a block that matters, and a block with no state
 * line at all still counts: a service that exists but cannot be interrogated
 * is more useful to report as unknown than to drop silently.
 */
export function parseServiceQuery(output: string, prefix: string): PanelService[] {
  const services: PanelService[] = [];
  let current: PanelService | null = null;

  for (const line of output.split(/\r?\n/)) {
    const name = /^SERVICE_NAME:\s*(\S+)/.exec(line);
    if (name?.[1]) {
      const id = name[1];
      current = id.toLowerCase().startsWith(prefix)
        ? { id, state: 'unknown', ...describePanelService(id) }
        : null;
      if (current) services.push(current);
      continue;
    }

    if (!current) continue;

    const state = /^\s*STATE\s*:\s*\d+\s+(\S+)/.exec(line);
    if (state?.[1]) {
      current.state = toState(state[1]);
      current = null;
    }
  }

  return services;
}

export function sortForShutdown(services: readonly PanelService[]): PanelService[] {
  return [...services].sort(
    (a, b) => STOP_ORDER[a.kind] - STOP_ORDER[b.kind] || a.id.localeCompare(b.id),
  );
}

/** Starting is the reverse: what a site depends on comes up before the site. */
export function sortForStartup(services: readonly PanelService[]): PanelService[] {
  return sortForShutdown(services).reverse();
}

/** Every WinPanel service Windows knows about, in the order it should be stopped. */
export async function listPanelServices(): Promise<PanelService[]> {
  if (process.platform !== 'win32') return [];

  const result = await runCommand({
    // The spaces after `type=` and `state=` are not a mistake: sc.exe requires
    // the value to be a separate argument.
    exe: 'sc.exe',
    args: ['query', 'type=', 'service', 'state=', 'all'],
    timeoutMs: 60_000,
  });

  if (result.exitCode !== 0) return [];

  return sortForShutdown(parseServiceQuery(result.stdout, PANEL_SERVICE_PREFIX));
}

export async function panelServiceState(id: string): Promise<PanelServiceState | 'not-installed'> {
  const result = await runCommand({ exe: 'sc.exe', args: ['query', id], timeoutMs: 15_000 });
  if (result.exitCode !== 0) return 'not-installed';

  const state = /^\s*STATE\s*:\s*\d+\s+(\S+)/m.exec(result.stdout);
  return state?.[1] ? toState(state[1]) : 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks Windows to stop a service and waits for it to actually be stopped.
 *
 * The exit code is ignored on purpose — sc.exe fails when the service is
 * already stopped, which is the outcome being asked for. Only the state that
 * follows is evidence of anything.
 */
export async function stopPanelService(id: string, timeoutMs = 60_000): Promise<boolean> {
  await runCommand({ exe: 'sc.exe', args: ['stop', id], timeoutMs: 30_000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await panelServiceState(id);
    if (state === 'stopped' || state === 'not-installed') return true;
    await delay(500);
  }

  return false;
}

/**
 * Asks Windows to start a service and waits for it to still be running.
 *
 * The wait is what makes this worth having. Windows reports success the moment
 * it has launched the process, so a website whose build is broken reports
 * "started" and is gone a second later. Waiting for the state to settle turns
 * that into an honest failure the user can act on.
 */
export async function startPanelService(id: string, timeoutMs = 60_000): Promise<boolean> {
  await runCommand({ exe: 'sc.exe', args: ['start', id], timeoutMs: 30_000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(1000);
    const state = await panelServiceState(id);
    if (state === 'running') return true;
    if (state === 'stopped' || state === 'not-installed') return false;
  }

  return false;
}

export async function restartPanelService(id: string): Promise<boolean> {
  await stopPanelService(id);
  return await startPanelService(id);
}

export interface ServiceActionReport {
  changed: string[];
  failed: Array<{ id: string; label: string; reason: string }>;
}

export interface ShutdownReport extends ServiceActionReport {
  /** True when the panel has asked Windows to stop it too. */
  panelStopping: boolean;
}

/**
 * Runs one operation across several services, reporting on all of them.
 *
 * One failure never abandons the rest: a website whose service is wedged
 * should not leave the mail server running as well, and the user needs the
 * full list of what is still up, not the first thing that went wrong.
 */
async function acrossServices(
  services: readonly PanelService[],
  operation: (id: string) => Promise<boolean>,
  failureReason: string,
): Promise<ServiceActionReport> {
  const changed: string[] = [];
  const failed: ServiceActionReport['failed'] = [];

  for (const service of services) {
    try {
      if (await operation(service.id)) {
        changed.push(service.label);
      } else {
        failed.push({ id: service.id, label: service.label, reason: failureReason });
      }
    } catch (error) {
      failed.push({
        id: service.id,
        label: service.label,
        reason: error instanceof Error ? error.message : 'Windows refused the request.',
      });
    }
  }

  return { changed, failed };
}

/** Stops everything except the panel, which the caller stops last. */
export async function stopSupportingServices(
  services: readonly PanelService[],
): Promise<ServiceActionReport> {
  return await acrossServices(
    sortForShutdown(services).filter(
      (service) => service.kind !== 'panel' && service.state !== 'stopped',
    ),
    (id) => stopPanelService(id),
    'It did not stop within a minute.',
  );
}

/**
 * Starts everything except the panel, which is by definition already running.
 *
 * This deliberately starts every registered service, including the inactive
 * colour of a website. That is exactly what Windows does on a restart — they
 * are all set to start automatically and each colour has its own port — so
 * this button produces the same result as rebooting, and no surprises beyond
 * it.
 */
export async function startSupportingServices(
  services: readonly PanelService[],
): Promise<ServiceActionReport> {
  return await acrossServices(
    sortForStartup(services).filter(
      (service) => service.kind !== 'panel' && service.state !== 'running',
    ),
    (id) => startPanelService(id),
    'It did not stay running. Its log in the logs folder says why.',
  );
}

/**
 * Stops the panel a moment from now.
 *
 * It cannot stop itself inline: the process being stopped is the one holding
 * the connection that asked for it, and the user would see a network error
 * instead of confirmation. The delay lets the reply reach the browser first.
 *
 * The stop is spawned detached because the service manager kills this process
 * the instant the request lands, and a child would go with it before Windows
 * had finished reading the request.
 */
export function scheduleAgentStop(delayMs = 2000): void {
  setTimeout(() => {
    runDetached({ exe: 'sc.exe', args: ['stop', AGENT_SERVICE_ID] });
  }, delayMs);
}
