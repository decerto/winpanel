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
): Array<{ port: number; pid: number }> {
  const wanted = new Set(ports);
  const found: Array<{ port: number; pid: number }> = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+(?:\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+(\d+)\s*$/i.exec(
      line,
    );
    if (!match?.[1] || !match[3]) continue;
    if (match[2] !== '0') continue;

    const port = Number.parseInt(match[1], 10);
    const pid = Number.parseInt(match[3], 10);
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
  if (process.platform !== 'win32' || ports.length === 0 || images.length === 0) return [];

  const result = await runCommand({
    exe: 'netstat.exe',
    args: ['-ano', '-p', 'TCP'],
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) return [];

  const wanted = new Set(images.map((image) => path.basename(image).toLowerCase()));
  const strays: StrayProcess[] = [];

  for (const { port, pid } of parseListeningPids(result.stdout, ports)) {
    if (pid === process.pid) continue;

    const name = await imageNameFor(pid);
    if (name && wanted.has(path.basename(name).toLowerCase())) {
      strays.push({ pid, port, image: name });
    }
  }

  return strays;
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
