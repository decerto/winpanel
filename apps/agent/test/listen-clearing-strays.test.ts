import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * The panel's boot retry for a port still held by its own previous copy.
 *
 * This is the difference between an update that heals itself and an update
 * that leaves the whole server refusing connections: `net stop` reports the
 * service stopped while the old agent's node.exe is still mid-shutdown, so
 * the new agent can boot into EADDRINUSE more than once before the port is
 * truly free. One retry is not enough — that was a real outage.
 */

const state = vi.hoisted(() => ({
  strays: [] as Array<Array<{ pid: number; port: number; image: string }>>,
  killed: [] as number[],
}));

vi.mock('../src/windows/stray-processes.js', () => ({
  findStrayListeners: vi.fn(async () => state.strays.shift() ?? []),
  killProcessTree: vi.fn(async (pid: number) => {
    state.killed.push(pid);
    return true;
  }),
}));

vi.mock('../src/config.js', () => ({
  config: { port: 8443, host: '0.0.0.0' },
}));

const { listenClearingStrays } = await import('../src/index.js');

function eaddrinuse(): NodeJS.ErrnoException {
  return Object.assign(new Error('listen EADDRINUSE 0.0.0.0:8443'), { code: 'EADDRINUSE' });
}

/** A fake Fastify-like server whose listen() runs a scripted set of outcomes. */
function fakeServer(outcomes: Array<'ok' | Error>) {
  const remaining = [...outcomes];
  return {
    calls: 0,
    log: { warn: vi.fn(), info: vi.fn() },
    async listen(): Promise<void> {
      this.calls += 1;
      const next = remaining.shift() ?? 'ok';
      if (next !== 'ok') throw next;
    },
  };
}

const STRAY = [{ pid: 4321, port: 8443, image: 'node.exe' }];

beforeEach(() => {
  state.strays = [];
  state.killed = [];
  // The retry loop waits a real second between attempts; the test clock does not.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs the function while the fake clock is advanced past every 1 s wait. */
async function run(server: ReturnType<typeof fakeServer>): Promise<void> {
  const pending = listenClearingStrays(server as never, 8443, '0.0.0.0');
  const assertion = expect(pending).resolves.toBeUndefined();

  // Each rejection costs one kill + one 1 s wait; advance generously.
  for (let i = 0; i < 60; i += 1) await vi.advanceTimersByTimeAsync(1_000);

  await assertion;
}

describe('listenClearingStrays', () => {
  it('does nothing at all when the port is free', async () => {
    const server = fakeServer(['ok']);
    await run(server);

    expect(server.calls).toBe(1);
    expect(state.killed).toEqual([]);
  });

  it('kills the old copy and retries until the port is really free', async () => {
    // The update race: the first kill lands while the old process is between
    // "ended" and "port released", so the retry meets EADDRINUSE again. A
    // boot that only retried once dies here; this one must not.
    const server = fakeServer([eaddrinuse(), eaddrinuse(), 'ok']);
    state.strays = [[...STRAY], [...STRAY]];

    await run(server);

    expect(server.calls).toBe(3);
    expect(state.killed).toEqual([4321, 4321]);
  });

  it('never touches a squatter that is not the panel itself', async () => {
    const server = fakeServer([eaddrinuse()]);
    state.strays = [[]]; // the holder is somebody else's program

    const pending = listenClearingStrays(server as never, 8443, '0.0.0.0');
    await expect(pending).rejects.toThrow('EADDRINUSE');

    expect(state.killed).toEqual([]);
    expect(server.calls).toBe(1);
  });

  it('does not retry errors that are not a busy port', async () => {
    const permission = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const server = fakeServer([permission]);

    await expect(listenClearingStrays(server as never, 8443, '0.0.0.0')).rejects.toThrow(
      'EACCES',
    );
    expect(server.calls).toBe(1);
  });
});
