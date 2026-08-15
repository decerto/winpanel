import net from 'node:net';

/**
 * Answers the one question a service's state never can: is anything actually
 * answering on this port?
 *
 * Windows reports a service as RUNNING when its wrapper process is alive. The
 * program the wrapper is meant to be supervising can be long dead — killed,
 * crashed on a port its own orphan still holds, never started at all — and the
 * state goes on saying RUNNING, because that state describes the wrapper, not
 * the work. Every "the panel says it's fine but the site is down" report is
 * this gap.
 *
 * The only honest test is to try the port. A real HTTP request would be
 * better still, but it needs a path, a timeout budget per site, and an answer
 * to "what about the app that takes thirty seconds to warm up" — none of
 * which a watchdog that sweeps every minute can afford. A TCP connect is the
 * floor: if nothing will even accept the connection, nothing is serving.
 */

export type PortProbe = (port: number, host?: string) => Promise<boolean>;

/** True when something accepts a TCP connection on the port, else false. */
export async function isPortAnswered(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };

    socket.setTimeout(3_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * True when none of the service's own ports are answered.
 *
 * A website owns exactly one application port, so this is simply "is its port
 * dead" for the case that matters. A component with several ports (the web
 * server, the mail server) is only counted dead when every one is silent —
 * one port down out of many is a different fault, not a dead child.
 */
export async function allPortsSilent(
  ports: readonly number[],
  probe: PortProbe = isPortAnswered,
): Promise<boolean> {
  if (ports.length === 0) return false;

  const answered = await Promise.all(ports.map((port) => probe(port)));
  return answered.every((result) => !result);
}
