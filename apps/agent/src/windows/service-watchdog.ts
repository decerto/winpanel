import { CADDY_ADMIN_PORT, MAIL_PORTS, STALWART_HTTP_PORT } from '@winpanel/shared';
import { allPortsSilent, isPortAnswered, type PortProbe } from './service-probe.js';
import {
  describeHolder,
  killProcessTree,
  listPortHolders,
  partitionHolders,
  type StrayProcess,
} from './stray-processes.js';
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
 * Websites are watched as well as components, and are in fact the common case:
 * a website's orphan goes on answering the web server, so the site looks
 * perfectly healthy from outside while the panel reports it stopped, every
 * restart fails, and each deploy lands on a process that is still running the
 * code it was built from. Nothing about that is visible without this check.
 *
 * Two rules keep this from being dangerous:
 *
 *   - A stopped service with no stray process is left alone. Somebody stopped
 *     it deliberately, and a control panel that restarts services behind your
 *     back is worse than one that does nothing.
 *   - Only a process matching the service's own executable *and* holding one
 *     of the service's own ports is killed. Anything else on the port is
 *     reported and left running.
 */

export interface WatchedService {
  id: string;
  /** Used in log lines, so it reads as a sentence. */
  label: string;
  /** Executable names the service may run under. */
  images: readonly string[];
  /** Ports the service binds and a stray copy would still be holding. */
  ports: readonly number[];
  /** Set for a website, so callers can tell which one it belongs to. */
  siteId?: string;
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
  /** Up according to Windows, but nothing answers on its ports. Restarted. */
  | 'revived'
  /** Down, but nothing is squatting on its ports: a deliberate stop. */
  | 'left-alone'
  /** Down, and the port belongs to something that is not ours to end. */
  | 'blocked'
  | 'recovered'
  /** Strays were cleared but the service still would not come up. */
  | 'still-down';

export interface WatchdogDeps {
  getState: (id: string) => Promise<ServiceState>;
  start: (id: string) => Promise<void>;
  /** Everything listening on those ports, whatever it is. Filtering is done here. */
  listHolders?: (ports: readonly number[]) => Promise<StrayProcess[]>;
  kill?: (pid: number) => Promise<boolean>;
  /**
   * Whether anything answers on a port. Injected so the running-but-dead case
   * can be tested without real sockets; defaults to a genuine TCP connect.
   */
  probePort?: PortProbe;
  /**
   * Confirmation for the running-but-dead case. Called with the service id
   * and whether its ports are silent right now; returns whether they were
   * already silent last time it was asked. Backed by the watchdog's memory of
   * the previous sweep, so a service is only restarted once it has been
   * silent for a full interval — never because it was merely still coming up.
   */
  confirmDead?: (id: string, silent: boolean) => boolean;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Ends any of the service's own processes still holding its ports, then starts
 * it. Shared by both repairs: a stopped service whose orphan never let go, and
 * a running service whose child is dead. Either way, whatever of ours is on
 * the port is the previous incarnation and has to go before the new one can
 * bind it.
 */
async function clearOursAndStart(
  service: WatchedService,
  ours: readonly StrayProcess[],
  deps: WatchdogDeps,
): Promise<WatchdogOutcome> {
  const kill = deps.kill ?? killProcessTree;
  const pids = [...new Set(ours.map((stray) => stray.pid))];

  if (pids.length > 0) {
    deps.log?.(
      `The ${service.label} has ${pids.length === 1 ? 'a process' : 'processes'} still ` +
        'holding its ports. Ending them so it can start again.',
      { service: service.id, strays: ours },
    );
    for (const pid of pids) await kill(pid);
  }

  try {
    await deps.start(service.id);
  } catch (error) {
    deps.log?.(`Could not restart the ${service.label}.`, error);
    return 'still-down';
  }

  return (await deps.getState(service.id)) === 'stopped' ? 'still-down' : 'recovered';
}

/**
 * The case the state word hides: the service is RUNNING, but nothing answers.
 *
 * `sc.exe query` reports the wrapper, and the wrapper is alive. The program it
 * is supervising is a separate process, and once that dies — usually because
 * it tried to bind a port its own orphaned predecessor still held — the
 * wrapper sits there reporting success for a site that serves nothing. From
 * the outside this is a 502; from the panel it looked, until now, exactly like
 * health.
 *
 * The evidence that separates it from a slow start is the port. A service
 * that is coming up answers within seconds; one whose ports stay silent across
 * a watchdog sweep is not coming up. Anything of ours still on the port is
 * cleared first — it is the orphan that caused the death — then the service is
 * restarted, which goes through `stop` and `start` and so gets the full
 * unblock-and-prove treatment a panel-initiated start does.
 */
async function reviveDeadService(
  service: WatchedService,
  deps: WatchdogDeps,
): Promise<WatchdogOutcome> {
  const probe = deps.probePort ?? isPortAnswered;

  // A service with nothing to connect to (a static site has no process) is
  // not watched here at all — it has no ports in the list.
  const silent = await allPortsSilent(service.ports, probe);

  /*
   * The confirmation is the whole safety of this. A service that is starting
   * — PHP workers spawning one by one, a Node app warming its framework — is
   * silent for a few seconds and then answers, and restarting it in that
   * window both kills the start and produces exactly the hang this check was
   * built to prevent. Only a service silent across two whole sweeps (a full
   * interval, far past any legitimate startup) is treated as dead. With no
   * memory supplied, a single silent reading is reported but not acted on.
   */
  const wasAlreadyDead = deps.confirmDead?.(service.id, silent) ?? false;
  if (!silent) return 'running';
  if (!wasAlreadyDead) {
    deps.log?.(
      `The ${service.label} reports running but nothing answered on its ` +
        `${service.ports.length === 1 ? 'port' : 'ports'} (${service.ports.join(', ')}). ` +
        'Watching it; if it is still silent next sweep it will be restarted.',
      { service: service.id },
    );
    return 'running';
  }

  /*
   * Silent twice. Now find out whether one of our own is squatting there.
   * The commonest reason the child died is `EADDRINUSE` against its own
   * orphan, and leaving that orphan in place while restarting would just kill
   * the next child the same way.
   */
  const listHolders = deps.listHolders ?? listPortHolders;
  const { ours } = partitionHolders(await listHolders(service.ports), service.images);

  deps.log?.(
    `The ${service.label} reports running but nothing answers on its ` +
      `${service.ports.length === 1 ? 'port' : 'ports'} (${service.ports.join(', ')}). ` +
      'Restarting it.',
    { service: service.id },
  );

  return await clearOursAndStart(service, ours, deps);
}

export async function recoverStalledService(
  service: WatchedService,
  deps: WatchdogDeps,
): Promise<WatchdogOutcome> {
  const state = await deps.getState(service.id);
  if (state === 'not-installed') return 'not-installed';
  // `stopping` is a transition, not a stall: acting on it would race Windows.
  if (state === 'stopping') return 'running';

  /*
   * A running service is not assumed healthy. Its state describes the wrapper
   * process; the application behind it can be dead with the wrapper none the
   * wiser. Probe the ports before believing it.
   */
  if (state === 'running' || state === 'starting') {
    return await reviveDeadService(service, deps);
  }

  const listHolders = deps.listHolders ?? listPortHolders;
  const { ours, foreign } = partitionHolders(await listHolders(service.ports), service.images);

  if (ours.length === 0) {
    if (foreign.length === 0) return 'left-alone';

    /*
     * Reported every sweep on purpose. A port collision does not heal itself,
     * and a service that is down because something else took its port is
     * indistinguishable from one that was stopped deliberately unless the
     * panel says so.
     */
    deps.log?.(
      `The ${service.label} is stopped and cannot start: ${foreign
        .map(describeHolder)
        .join(', ')} is holding a port it needs. That program is not the panel's to end.`,
      { service: service.id, holders: foreign },
    );
    return 'blocked';
  }

  return await clearOursAndStart(service, ours, deps);
}

export const WATCHDOG_INTERVAL_MS = 60_000;

/** Either a fixed set or one recomputed each sweep, as websites come and go. */
export type WatchedServiceSource =
  | readonly WatchedService[]
  | (() => readonly WatchedService[] | Promise<readonly WatchedService[]>);

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
  /**
   * Which services were silent on the previous sweep. The memory that makes
   * the running-but-dead check safe: a service is only restarted once it has
   * been silent across two sweeps, so a slow start is never mistaken for a
   * death. Entries clear the moment a service answers again.
   */
  readonly #silentLastSweep = new Map<string, boolean>();

  constructor(
    private readonly deps: WatchdogDeps,
    private readonly source: WatchedServiceSource = WATCHED_SERVICES,
  ) {}

  /** Records this sweep's reading and answers whether the last one matched. */
  #confirmDead = (id: string, silent: boolean): boolean => {
    const was = this.#silentLastSweep.get(id) ?? false;
    if (silent) this.#silentLastSweep.set(id, true);
    else this.#silentLastSweep.delete(id);
    return was;
  };

  async sweep(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;

    try {
      let services: readonly WatchedService[];
      try {
        services = typeof this.source === 'function' ? await this.source() : this.source;
      } catch (error) {
        // A sweep that cannot list what to watch must not take the timer down
        // with it, or one bad read ends supervision until the next restart.
        this.deps.log?.('Could not work out which background programs to check on.', error);
        return;
      }

      const deps: WatchdogDeps = { ...this.deps, confirmDead: this.#confirmDead };

      for (const service of services) {
        try {
          const outcome = await recoverStalledService(service, deps);
          if (outcome === 'recovered') {
            this.deps.log?.(`Restarted the ${service.label}.`, { service: service.id });
          } else if (outcome === 'revived') {
            this.deps.log?.(
              `The ${service.label} said it was running but was not answering, so it was ` +
                'restarted.',
              { service: service.id },
            );
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
