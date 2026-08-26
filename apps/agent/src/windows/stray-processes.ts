import path from 'node:path';
import { runCommand } from '../process/run-command.js';

/**
 * Finding processes that are still holding a port they should have released.
 *
 * A supervised service is meant to own its ports for exactly as long as its
 * wrapper is alive. That breaks when the wrapper dies without running its stop
 * path — which is what a sleep/wake cycle or a killed wrapper does. The child
 * keeps running, keeps its listeners bound, and every restart Windows attempts
 * fails on the first bind. The service then flaps forever with no one able to
 * see why, because the port looks busy and the service looks stopped.
 *
 * Everything here identifies the culprit by *both* port and executable name
 * before touching it. Killing whatever happens to hold port 80 would be a
 * remote-code-execution-grade footgun on a machine that also runs something
 * else; killing a process named caddy.exe that is squatting on Caddy's ports
 * while Caddy's service is down is the repair the operator would do by hand.
 */

export interface StrayProcess {
  pid: number;
  port: number;
  image: string;
}

/**
 * Reads listening sockets out of `netstat -ano` output.
 *
 * The `LISTENING` word is deliberately not matched: `netstat` translates its
 * state column, so a German or Japanese server prints something else entirely.
 * A foreign address with port 0 means the same thing in every locale.
 */
export function parseListeningPids(
  output: string,
  ports: readonly number[],
  protocol: 'tcp' | 'udp' = 'tcp',
): Array<{ port: number; pid: number }> {
  const wanted = new Set(ports);
  const found: Array<{ port: number; pid: number }> = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = protocol === 'udp'
      ? /^\s*UDP\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+(\d+)\s*$/i.exec(line)
      : /^\s*TCP\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!match?.[1]) continue;
    if (protocol === 'tcp' && match[2] !== '0') continue;

    const port = Number.parseInt(match[1], 10);
    const pidText = protocol === 'udp' ? match[2] : match[3];
    if (!pidText) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!wanted.has(port) || pid <= 0) continue;

    // The same process listens on IPv4 and IPv6 for one port; report it once.
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ port, pid });
  }

  return found;
}

/**
 * Reads the executable name out of `tasklist /FO CSV /NH` output.
 *
 * Returns null for the "no tasks are running" line, which is what a PID that
 * has exited between the netstat call and this one produces.
 */
export function parseTasklistImage(output: string): string | null {
  const match = /^"([^"]+)","(\d+)"/m.exec(output.trim());
  return match?.[1] ?? null;
}

async function imageNameFor(pid: number): Promise<string | null> {
  const result = await runCommand({
    exe: 'tasklist.exe',
    args: ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) return null;
  return parseTasklistImage(result.stdout);
}

/**
 * Everything listening on `ports`, whatever it is.
 *
 * Nothing here decides anything; it is the raw answer to "who has this port",
 * which is the question an operator asks first and the one the panel could
 * not previously answer.
 */
export async function listPortHolders(ports: readonly number[]): Promise<StrayProcess[]> {
  if (process.platform !== 'win32' || ports.length === 0) return [];

  const results = await Promise.all(
    (['tcp', 'udp'] as const).map(async (protocol) => ({
      protocol,
      result: await runCommand({
        exe: 'netstat.exe',
        args: ['-ano', '-p', protocol.toUpperCase()],
        timeoutMs: 30_000,
      }),
    })),
  );

  const holders: StrayProcess[] = [];
  const seen = new Set<string>();

  for (const { protocol, result } of results) {
    if (result.exitCode !== 0) continue;

    for (const { port, pid } of parseListeningPids(result.stdout, ports, protocol)) {
      if (pid === process.pid) continue;
      const key = `${port}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const image = await imageNameFor(pid);
      if (image) holders.push({ pid, port, image });
    }
  }

  return holders;
}

/**
 * Processes listening on any of `ports` whose executable is one of `images`.
 *
 * Names are compared as bare file names, case-insensitively, because that is
 * all `tasklist` reports. Several are accepted because a component can ship
 * under more than one name across versions.
 */
export async function findStrayListeners(
  ports: readonly number[],
  images: readonly string[],
): Promise<StrayProcess[]> {
  if (images.length === 0) return [];

  return partitionHolders(await listPortHolders(ports), images).ours;
}

/** Ends a process and anything it started. */
export async function killProcessTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const result = await runCommand({
    exe: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', '/F'],
    timeoutMs: 30_000,
  });

  return result.exitCode === 0;
}

/** Splits port holders into ones we own and ones we must not touch. */
export function partitionHolders(
  holders: readonly StrayProcess[],
  images: readonly string[],
): { ours: StrayProcess[]; foreign: StrayProcess[] } {
  const wanted = new Set(images.map((image) => path.basename(image).toLowerCase()));

  const ours: StrayProcess[] = [];
  const foreign: StrayProcess[] = [];

  for (const holder of holders) {
    (wanted.has(path.basename(holder.image).toLowerCase()) ? ours : foreign).push(holder);
  }

  return { ours, foreign };
}

export interface PortClearance {
  /** Processes that matched one of `images` and have been ended. */
  killed: StrayProcess[];
  /** Matching listeners that remained after the kill attempt. */
  remaining: StrayProcess[];
  /**
   * Processes still holding a port that are nothing to do with the panel.
   * Never killed: the port is ours to allocate, not ours to enforce, and
   * ending an unrelated program is not a repair anyone asked for.
   */
  foreign: StrayProcess[];
}

/**
 * Frees ports that should be unoccupied, and reports what it could not free.
 *
 * The distinction is the point. An orphan of the service being started is a
 * fault the panel caused and must clear; anything else on the port is a
 * collision the user has to be told about, because the alternative is the
 * panel quietly proxying a website to a stranger's program.
 */
export async function clearStrayListeners(
  ports: readonly number[],
  images: readonly string[],
): Promise<PortClearance> {
  const { ours, foreign } = partitionHolders(await listPortHolders(ports), images);

  const killed: StrayProcess[] = [];

  for (const pid of new Set(ours.map((stray) => stray.pid))) {
    if (await killProcessTree(pid)) {
      killed.push(...ours.filter((stray) => stray.pid === pid));
    }
  }

  const remaining = ours.length > 0 ? await findStrayListeners(ports, images) : [];
  return { killed, foreign, remaining };
}

/** Names a process in a sentence a person can act on. */
export function describeHolder(holder: StrayProcess): string {
  return `${holder.image} (process ${holder.pid}) on port ${holder.port}`;
}
