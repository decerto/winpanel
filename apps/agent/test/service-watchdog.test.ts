import { describe, expect, it } from 'vitest';
import {
  ServiceWatchdog,
  WATCHED_SERVICES,
  recoverStalledService,
  type WatchedService,
} from '../src/windows/service-watchdog.js';
import { parseListeningPids, parseTasklistImage } from '../src/windows/stray-processes.js';
import type { ServiceState } from '../src/windows/service-manager.js';

const caddy: WatchedService = {
  id: 'winpanel-caddy',
  label: 'web server',
  images: ['caddy.exe'],
  ports: [80, 443, 2019],
};

function deps(overrides: {
  states?: ServiceState[];
  holders?: Array<{ pid: number; port: number; image: string }>;
  /** What the port probe answers. Defaults to "answering", i.e. healthy. */
  answered?: boolean;
  start?: () => Promise<void>;
}): {
  getState: (id: string) => Promise<ServiceState>;
  start: (id: string) => Promise<void>;
  listHolders: () => Promise<Array<{ pid: number; port: number; image: string }>>;
  kill: (pid: number) => Promise<boolean>;
  probePort: () => Promise<boolean>;
  killed: number[];
  started: string[];
} {
  const states = overrides.states ?? ['stopped'];
  const killed: number[] = [];
  const started: string[] = [];

  return {
    getState: async () => states.shift() ?? states.at(-1) ?? 'stopped',
    start: async (id) => {
      started.push(id);
      if (overrides.start) await overrides.start();
    },
    listHolders: async () => overrides.holders ?? [],
    kill: async (pid) => {
      killed.push(pid);
      return true;
    },
    // Injected so a running service is never tested against a real socket.
    probePort: async () => overrides.answered ?? true,
    killed,
    started,
  };
}

describe('recoverStalledService', () => {
  it('leaves a running service alone', async () => {
    const d = deps({ states: ['running'], holders: [{ pid: 9, port: 80, image: 'caddy.exe' }] });

    expect(await recoverStalledService(caddy, d)).toBe('running');
    expect(d.killed).toEqual([]);
    expect(d.started).toEqual([]);
  });

  it('restarts a running service that was already silent last sweep', async () => {
    // The dead-child case, confirmed: the wrapper reports running and nothing
    // listened this sweep OR last. Two silent readings are what separates a
    // dead child from a slow start.
    const d = {
      ...deps({ states: ['running', 'running'], answered: false, holders: [] }),
      confirmDead: () => true, // it was already silent last time
    };

    expect(await recoverStalledService(caddy, d)).toBe('recovered');
    expect(d.started).toEqual(['winpanel-caddy']);
    // No stray to kill — the child was already gone.
    expect(d.killed).toEqual([]);
  });

  it('does not restart a running service on a single silent reading', async () => {
    // A slow start (PHP workers spawning, a Node app warming) is silent for a
    // few seconds and then answers. Restarting in that window would kill the
    // start — so one silent sweep is watched, not acted on.
    const d = deps({ states: ['running'], answered: false, holders: [] });

    expect(await recoverStalledService(caddy, d)).toBe('running');
    expect(d.started).toEqual([]);
    expect(d.killed).toEqual([]);
  });

  it('clears the orphan before restarting a confirmed-dead service, so it can rebind', async () => {
    // The full boot-after-crash shape: the service says running, the port is
    // silent to a real connect (and was last sweep), yet our own orphan still
    // holds it.
    const d = {
      ...deps({
        states: ['running', 'running'],
        answered: false,
        holders: [{ pid: 6792, port: 3007, image: 'node.exe' }],
      }),
      confirmDead: () => true,
    };
    const site: WatchedService = {
      id: 'winpanel-site-forgeandfilter-com-blue',
      label: 'forgeandfilter-com website',
      images: ['node.exe'],
      ports: [3007],
    };

    expect(await recoverStalledService(site, d)).toBe('recovered');
    expect(d.killed).toEqual([6792]);
    expect(d.started).toEqual(['winpanel-site-forgeandfilter-com-blue']);
  });

  it('does not treat a service that answers on one of several ports as dead', async () => {
    // The web server owns 80, 443 and 2019; one being down is not a dead child.
    let calls = 0;
    const d = {
      ...deps({ states: ['running'] }),
      probePort: async () => ++calls === 1, // only the first port answers
    };

    expect(await recoverStalledService(caddy, d)).toBe('running');
    expect(d.started).toEqual([]);
  });

  it('does not restart a service somebody stopped on purpose', async () => {
    // The distinguishing evidence is the absence of a stray listener. Without
    // this rule the panel would fight the operator every minute.
    const d = deps({ states: ['stopped'], holders: [] });

    expect(await recoverStalledService(caddy, d)).toBe('left-alone');
    expect(d.started).toEqual([]);
  });

  it('kills an orphan holding the ports and starts the service', async () => {
    const d = deps({
      states: ['stopped', 'running'],
      holders: [
        { pid: 11372, port: 2019, image: 'caddy.exe' },
        { pid: 11372, port: 443, image: 'caddy.exe' },
      ],
    });

    expect(await recoverStalledService(caddy, d)).toBe('recovered');
    // One kill, even though the same process held two of the ports.
    expect(d.killed).toEqual([11372]);
    expect(d.started).toEqual(['winpanel-caddy']);
  });

  it('refuses to end a program that is not ours, and says so', async () => {
    const logged: string[] = [];
    const d = {
      ...deps({ states: ['stopped'], holders: [{ pid: 700, port: 80, image: 'httpd.exe' }] }),
      log: (message: string) => logged.push(message),
    };

    expect(await recoverStalledService(caddy, d)).toBe('blocked');
    expect(d.killed).toEqual([]);
    expect(d.started).toEqual([]);
    expect(logged[0]).toContain('httpd.exe');
  });

  it('clears its own orphan even when a foreign process holds another port', async () => {
    const d = deps({
      states: ['stopped', 'running'],
      holders: [
        { pid: 700, port: 80, image: 'httpd.exe' },
        { pid: 11372, port: 2019, image: 'caddy.exe' },
      ],
    });

    expect(await recoverStalledService(caddy, d)).toBe('recovered');
    expect(d.killed).toEqual([11372]);
  });

  it('reports a service that stays down after the ports were cleared', async () => {
    const d = deps({
      states: ['stopped', 'stopped'],
      holders: [{ pid: 5, port: 80, image: 'caddy.exe' }],
    });

    expect(await recoverStalledService(caddy, d)).toBe('still-down');
  });

  it('reports a start that threw rather than letting it escape', async () => {
    const d = deps({
      states: ['stopped'],
      holders: [{ pid: 5, port: 80, image: 'caddy.exe' }],
      start: async () => {
        throw new Error('access denied');
      },
    });

    expect(await recoverStalledService(caddy, d)).toBe('still-down');
  });

  it('ignores a service that is not installed', async () => {
    const d = deps({ states: ['not-installed'] });

    expect(await recoverStalledService(caddy, d)).toBe('not-installed');
    expect(d.killed).toEqual([]);
  });
});

describe('ServiceWatchdog', () => {
  it('checks every watched service and survives one of them failing', async () => {
    const checked: string[] = [];
    const watchdog = new ServiceWatchdog(
      {
        getState: async (id) => {
          checked.push(id);
          if (id === 'winpanel-caddy') throw new Error('sc.exe is missing');
          return 'running';
        },
        start: async () => undefined,
        probePort: async () => true,
        log: () => undefined,
      },
      WATCHED_SERVICES,
    );

    await watchdog.sweep();
    expect(checked).toEqual(WATCHED_SERVICES.map((service) => service.id));
  });

  it('does not let sweeps overlap', async () => {
    let inFlight = 0;
    let peak = 0;
    const watchdog = new ServiceWatchdog(
      {
        getState: async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return 'running';
        },
        start: async () => undefined,
        probePort: async () => true,
      },
      [caddy],
    );

    await Promise.all([watchdog.sweep(), watchdog.sweep()]);
    expect(peak).toBe(1);
  });

  it('restarts a silent service only on the second consecutive silent sweep', async () => {
    // The confirmation that makes the dead-child check safe: the first silent
    // sweep is logged and watched, the second acts. This mirrors a service
    // that is dead rather than merely slow to start.
    const started: string[] = [];
    const watchdog = new ServiceWatchdog(
      {
        getState: async () => 'running',
        start: async (id) => {
          started.push(id);
        },
        probePort: async () => false, // never answers
        listHolders: async () => [],
      },
      [caddy],
    );

    await watchdog.sweep();
    expect(started).toEqual([]); // first silent sweep: watched, not restarted

    await watchdog.sweep();
    expect(started).toEqual(['winpanel-caddy']); // second silent sweep: restarted
  });

  it('forgets a service that answers again, so a later blip starts the count over', async () => {
    const started: string[] = [];
    let silent = true;
    const watchdog = new ServiceWatchdog(
      {
        getState: async () => 'running',
        start: async (id) => {
          started.push(id);
        },
        probePort: async () => !silent,
        listHolders: async () => [],
      },
      [caddy],
    );

    await watchdog.sweep(); // silent: watched
    silent = false;
    await watchdog.sweep(); // answers again: memory cleared
    silent = true;
    await watchdog.sweep(); // silent once more: a fresh first reading, not a restart
    expect(started).toEqual([]);
  });

  it('watches the web server on the ports a stray copy would hold', () => {
    const watched = WATCHED_SERVICES.find((service) => service.id === 'winpanel-caddy');
    expect(watched?.ports).toContain(2019);
    expect(watched?.ports).toContain(443);
  });

  it('re-reads the watched set each sweep, so a new website is picked up', async () => {
    const sets: WatchedService[][] = [
      [caddy],
      [caddy, { id: 'winpanel-site-new-blue', label: 'new website', images: ['node.exe'], ports: [3001] }],
    ];
    const checked: string[] = [];

    const watchdog = new ServiceWatchdog(
      {
        getState: async (id) => {
          checked.push(id);
          return 'running';
        },
        start: async () => undefined,
        probePort: async () => true,
      },
      () => sets.shift() ?? [],
    );

    await watchdog.sweep();
    await watchdog.sweep();

    expect(checked).toEqual(['winpanel-caddy', 'winpanel-caddy', 'winpanel-site-new-blue']);
  });

  it('keeps running when the watched set cannot be worked out', async () => {
    const logged: string[] = [];
    const watchdog = new ServiceWatchdog(
      {
        getState: async () => 'running',
        start: async () => undefined,
        probePort: async () => true,
        log: (message) => logged.push(message),
      },
      () => {
        throw new Error('the database is locked');
      },
    );

    await expect(watchdog.sweep()).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });
});

describe('parseListeningPids', () => {
  const output = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       11372',
    '  TCP    127.0.0.1:2019         0.0.0.0:0              LISTENING       11372',
    '  TCP    [::]:443               [::]:0                 LISTENING       11372',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    127.0.0.1:80           127.0.0.1:52144        ESTABLISHED     6600',
  ].join('\r\n');

  it('finds listeners on the ports asked for', () => {
    expect(parseListeningPids(output, [80, 2019])).toEqual([
      { port: 80, pid: 11372 },
      { port: 2019, pid: 11372 },
    ]);
  });

  it('ignores established connections to the same port', () => {
    // An outbound or inbound connection is not a bind, and killing whatever
    // owns one would take out an unrelated program.
    expect(parseListeningPids(output, [80])).toEqual([{ port: 80, pid: 11372 }]);
  });

  it('reads IPv6 listeners', () => {
    expect(parseListeningPids(output, [443])).toEqual([{ port: 443, pid: 11372 }]);
  });

  it('reports a port only once when both stacks are bound', () => {
    const both = [
      '  TCP    0.0.0.0:443            0.0.0.0:0              LISTENING       11372',
      '  TCP    [::]:443               [::]:0                 LISTENING       11372',
    ].join('\r\n');

    expect(parseListeningPids(both, [443])).toEqual([{ port: 443, pid: 11372 }]);
  });

  it('does not depend on the translated state column', () => {
    // netstat translates LISTENING; a server installed in another language
    // would otherwise never be repaired.
    const german = '  TCP    0.0.0.0:80             0.0.0.0:0              ABHÖREN         11372';
    expect(parseListeningPids(german, [80])).toEqual([{ port: 80, pid: 11372 }]);
  });
});

describe('parseTasklistImage', () => {
  it('reads the executable name', () => {
    expect(parseTasklistImage('"caddy.exe","11372","Services","0","41,268 K"')).toBe('caddy.exe');
  });

  it('returns null when the process has already gone', () => {
    expect(
      parseTasklistImage('INFO: No tasks are running which match the specified criteria.'),
    ).toBeNull();
  });
});
