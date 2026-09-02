import {
  CADDY_ADMIN_PORT,
  MAIL_PORTS,
  MARIADB_PORT,
  MONGODB_PORT,
  POSTGRES_PORT,
  STALWART_HTTP_PORT,
  WEB_PORTS,
} from '@winpanel/shared';
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
 *   - A service stopped deliberately through the panel is left alone. A clean
 *     stop after the service was observed running, or an automatic service
 *     already stopped when supervision begins, is treated as a crash only
 *     when no explicit stop intent was recorded.
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
  /** Ports the service normally binds and must answer to be considered healthy. */
  ports: readonly number[];
  /** Extra ports an older or unrepaired copy may still hold while being cleared. */
  recoveryPorts?: readonly number[];
  /** TCP ports that can be used to check whether the application answers. */
  probePorts?: readonly number[];
  /** Set for a website, so callers can tell which one it belongs to. */
  siteId?: string;
}

/** Ports to inspect when clearing a service's own leftover listeners. */
export function portsForRecovery(service: WatchedService): readonly number[] {
  if (!service.recoveryPorts) return service.ports;
  return [...new Set([...service.ports, ...service.recoveryPorts])];
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
    recoveryPorts: WEB_PORTS,
  },
  /*
   * The database servers. A website whose database is down is down, and the
   * failure looks nothing like a broken site from the outside — so these are
   * watched for exactly the same reasons the web server is: an orphan left
   * holding the port after a sleep or a crash stops the service ever starting
   * again, and nothing about that is visible without checking.
   */
  {
    id: 'winpanel-mariadb',
    label: 'MariaDB',
    images: ['mariadbd.exe', 'mysqld.exe'],
    ports: [MARIADB_PORT],
  },
  {
    id: 'winpanel-postgres',
    label: 'PostgreSQL',
    images: ['postgres.exe'],
    ports: [POSTGRES_PORT],
  },
  {
    id: 'winpanel-mongodb',
    label: 'MongoDB',
    images: ['mongod.exe'],
    ports: [MONGODB_PORT],
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
  restart: (id: string) => Promise<void>;
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
  /** Clears remembered silence when a service is removed or deliberately stopped. */
  clearDead?: (id: string) => void;
  /** True when the panel explicitly asked for this service to stay stopped. */
  isIntentionallyStopped?: (id: string) => boolean;
  /** Whether a cleanly stopped service should be started by this recovery. */
  shouldRestartStopped?: (id: string) => boolean;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Ends any of the service's own processes still holding its ports, then starts
 * it. Shared by both repairs: a stopped service whose orphan never let go, and
 * a running service whose child is dead. Either way, whatever of ours is on
 * the port is the previous incarnation and has to go before the new one can
 * bind it.
 */
async function clearOurs(
  service: WatchedService,
  ours: readonly StrayProcess[],
  deps: WatchdogDeps,
  restart: boolean,
): Promise<void> {
  const kill = deps.kill ?? killProcessTree;
  const pids = [...new Set(ours.map((stray) => stray.pid))];

  if (pids.length > 0) {
    deps.log?.(
      `The ${service.label} has ${pids.length === 1 ? 'a process' : 'processes'} still ` +
        `holding its ports. Ending them so it can ${restart ? 'start again' : 'stay stopped'}.`,
      { service: service.id, strays: ours },
    );
    for (const pid of pids) await kill(pid);
  }
}

async function clearOursAndStart(
  service: WatchedService,
  ours: readonly StrayProcess[],
  deps: WatchdogDeps,
  operation: 'start' | 'restart' = 'start',
): Promise<WatchdogOutcome> {
  await clearOurs(service, ours, deps, operation === 'restart');

  try {
    const run = operation === 'restart' ? deps.restart : deps.start;
    await run(service.id);
  } catch (error) {
    deps.log?.(`Could not restart the ${service.label}.`, error);
    return 'still-down';
  }

  const state = await deps.getState(service.id);
  return state === 'running' || state === 'starting' ? 'recovered' : 'still-down';
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
  if (deps.isIntentionallyStopped?.(service.id)) {
    deps.clearDead?.(service.id);
    return 'left-alone';
  }

  const probe = deps.probePort ?? isPortAnswered;
  const probePorts = service.probePorts ?? service.ports;

  // A service with nothing to connect to (a static site has no process) is
  // not watched here at all — it has no ports in the list.
  const silent = await allPortsSilent(probePorts, probe);

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
        `${probePorts.length === 1 ? 'port' : 'ports'} (${probePorts.join(', ')}). ` +
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
  const { ours } = partitionHolders(await listHolders(portsForRecovery(service)), service.images);

  deps.log?.(
    `The ${service.label} reports running but nothing answered on its ` +
      `${probePorts.length === 1 ? 'port' : 'ports'} (${probePorts.join(', ')}). ` +
      'Restarting it.',
    { service: service.id },
  );

  const outcome = await clearOursAndStart(service, ours, deps, 'restart');
  return outcome === 'recovered' ? 'revived' : outcome;
}

export async function recoverStalledService(
  service: WatchedService,
  deps: WatchdogDeps,
): Promise<WatchdogOutcome> {
  const state = await deps.getState(service.id);
  if (state === 'not-installed') {
    deps.clearDead?.(service.id);
    return 'not-installed';
  }
  // `stopping` is a transition, not a stall: acting on it would race Windows.
  if (state === 'stopping') {
    deps.clearDead?.(service.id);
    return 'running';
  }

  /*
   * A running service is not assumed healthy. Its state describes the wrapper
   * process; the application behind it can be dead with the wrapper none the
   * wiser. Probe the ports before believing it.
   */
  if (state === 'running' || state === 'starting') {
    return await reviveDeadService(service, deps);
  }

  deps.clearDead?.(service.id);
  const listHolders = deps.listHolders ?? listPortHolders;
  const { ours, foreign } = partitionHolders(
    await listHolders(portsForRecovery(service)),
    service.images,
  );
  // Direct callers retain the old orphan-recovery behavior. The watchdog
  // supplies an explicit decision for a clean running-to-stopped transition.
  const shouldRestart = deps.shouldRestartStopped?.(service.id) ?? ours.length > 0;
  const requiredPorts = new Set(service.ports);
  const requiredForeign = foreign.filter((holder) => requiredPorts.has(holder.port));

  if (ours.length === 0) {
    if (requiredForeign.length === 0) {
      if (!shouldRestart) return 'left-alone';

      deps.log?.(
        `The ${service.label} is stopped but should be running. Restarting it.`,
        { service: service.id },
      );
      return await clearOursAndStart(service, [], deps);
    }

    /*
     * Reported every sweep on purpose. A port collision does not heal itself,
     * and a service that is down because something else took its port is
     * indistinguishable from one that was stopped deliberately unless the
     * panel says so.
     */
    deps.log?.(
      `The ${service.label} is stopped and cannot start: ${requiredForeign
        .map(describeHolder)
        .join(', ')} is holding a port it needs. That program is not the panel's to end.`,
      { service: service.id, holders: requiredForeign },
    );
    return 'blocked';
  }

  if (!shouldRestart) {
    // A requested stop still gets its own orphan cleaned up, but it is never
    // started again by the watchdog.
    await clearOurs(service, ours, deps, false);
    return 'left-alone';
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
  /** Last observed Windows state; a missing entry is the first sweep after boot. */
  readonly #lastState = new Map<string, ServiceState>();

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

      const currentIds = new Set(services.map((service) => service.id));
      for (const id of this.#silentLastSweep.keys()) {
        if (!currentIds.has(id)) this.#silentLastSweep.delete(id);
      }
      for (const id of this.#lastState.keys()) {
        if (!currentIds.has(id)) this.#lastState.delete(id);
      }

      const sharedDeps: WatchdogDeps = {
        ...this.deps,
        confirmDead: this.#confirmDead,
        clearDead: (id) => this.#silentLastSweep.delete(id),
      };

      for (const service of services) {
        let observedState: ServiceState | undefined;
        const deps: WatchdogDeps = {
          ...sharedDeps,
          getState: async (id) => {
            const state = await this.deps.getState(id);
            if (id === service.id && observedState === undefined) observedState = state;
            return state;
          },
          shouldRestartStopped: (id) => {
            const previous = this.#lastState.get(id);
            return (
              (previous === undefined || previous === 'running' || previous === 'starting') &&
              !this.deps.isIntentionallyStopped?.(id)
            );
          },
        };

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
        } finally {
          if (observedState !== undefined) this.#lastState.set(service.id, observedState);
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
