import { CADDY_ADMIN_PORT, MAIL_PORTS, STALWART_HTTP_PORT } from '@winpanel/shared';
import { findStrayListeners, killProcessTree, type StrayProcess } from './stray-processes.js';
import type { ServiceState } from './service-manager.js';

/**
 * Recovery for a service Windows cannot restart because its own last process
 * is still holding the ports.
 *
 * Windows' restart-on-failure policy assumes a service that exited released
 * what it had. When a WinSW wrapper dies without running its stop path — a
 * sleep/wake cycle is the usual cause — the supervised process is orphaned
 * instead, and every restart attempt then fails to bind. The service ends up
 * flapping on the failure-action interval indefinitely, which is a whole night
 * of downtime for something a single `taskkill` would have fixed.
 *
 * Two rules keep this from being dangerous:
 *
 *   - A stopped service with no stray process is left alone. Somebody stopped
 *     it deliberately, and a control panel that restarts services behind your
 *     back is worse than one that does nothing.
 *   - Only a process matching the service's own executable *and* holding one
 *     of the service's own ports is killed.
 */

export interface WatchedService {
  id: string;
  /** Used in log lines, so it reads as a sentence. */
  label: string;
  /** Executable names the service may run under. */
  images: readonly string[];
  /** Ports the service binds and a stray copy would still be holding. */
  ports: readonly number[];
}

export const WATCHED_SERVICES: readonly WatchedService[] = [
  {
    id: 'winpanel-caddy',
    label: 'web server',
    images: ['caddy.exe'],
    ports: [80, 443, CADDY_ADMIN_PORT],
  },
  {
    id: 'winpanel-stalwart',
    label: 'mail server',
    images: ['stalwart.exe', 'stalwart-mail.exe'],
    ports: [STALWART_HTTP_PORT, ...MAIL_PORTS],
  },
];

export type WatchdogOutcome =
  | 'not-installed'
  | 'running'
  /** Down, but nothing is squatting on its ports: a deliberate stop. */
  | 'left-alone'
  | 'recovered'
  /** Strays were cleared but the service still would not come up. */
  | 'still-down';

export interface WatchdogDeps {
  getState: (id: string) => Promise<ServiceState>;
  start: (id: string) => Promise<void>;
  findStrays?: (ports: readonly number[], images: readonly string[]) => Promise<StrayProcess[]>;
  kill?: (pid: number) => Promise<boolean>;
  log?: (message: string, detail?: unknown) => void;
}

export async function recoverStalledService(
  service: WatchedService,
  deps: WatchdogDeps,
): Promise<WatchdogOutcome> {
  const state = await deps.getState(service.id);
  if (state === 'not-installed') return 'not-installed';
  // `stopping` is a transition, not a stall: acting on it would race Windows.
  if (state !== 'stopped') return 'running';

  const findStrays = deps.findStrays ?? findStrayListeners;
  const strays = await findStrays(service.ports, service.images);
  if (strays.length === 0) return 'left-alone';

  const kill = deps.kill ?? killProcessTree;
  const pids = [...new Set(strays.map((stray) => stray.pid))];

  deps.log?.(
    `The ${service.label} is stopped but ${pids.length === 1 ? 'a process is' : 'processes are'} ` +
      'still holding its ports. Ending them so it can start again.',
    { service: service.id, strays },
  );

  for (const pid of pids) await kill(pid);

  try {
    await deps.start(service.id);
  } catch (error) {
    deps.log?.(`Could not restart the ${service.label} after clearing its ports.`, error);
    return 'still-down';
  }

  return (await deps.getState(service.id)) === 'stopped' ? 'still-down' : 'recovered';
}

export const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Runs the check on a timer for the lifetime of the agent.
 *
 * The agent is the only WinPanel process that survives a component's crash
 * loop, so it is the only place this can live. Sweeps never overlap: a slow
 * `netstat` on a loaded machine would otherwise stack up kills.
 */
export class ServiceWatchdog {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor(
    private readonly deps: WatchdogDeps,
    private readonly services: readonly WatchedService[] = WATCHED_SERVICES,
  ) {}

  async sweep(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;

    try {
      for (const service of this.services) {
        try {
          const outcome = await recoverStalledService(service, this.deps);
          if (outcome === 'recovered') {
            this.deps.log?.(`Restarted the ${service.label}.`, { service: service.id });
          }
        } catch (error) {
          this.deps.log?.(`Could not check on the ${service.label}.`, error);
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  start(intervalMs = WATCHDOG_INTERVAL_MS): void {
    if (this.#timer || process.platform !== 'win32') return;

    this.#timer = setInterval(() => void this.sweep(), intervalMs);
    // Must never be the reason the process stays alive.
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
