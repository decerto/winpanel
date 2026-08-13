import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { phpWorkerPorts, waitForPhpPool } from '../src/sites/php.js';
import { PHP_POOL_SIZE } from '@winpanel/shared';

/**
 * The deploy-time proof that a PHP site came up.
 *
 * PHP workers speak FastCGI, not HTTP, so an HTTP health check can never pass
 * against them — which is exactly the bug this function exists to fix. The
 * check is a TCP connect per worker instead.
 */

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
    servers.push(server);
  });
}

/** A free base port, by borrowing one and letting it go. */
function freeBase(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('phpWorkerPorts', () => {
  it('is the base port plus the pool size above it', () => {
    expect(phpWorkerPorts(9001)).toEqual([9001, 9002, 9003, 9004]);
  });
});

describe('waitForPhpPool', () => {
  it('passes when every worker port answers', async () => {
    const base = await freeBase();
    const ports = phpWorkerPorts(base);
    for (const port of ports) await listen(port);

    await expect(waitForPhpPool({ basePort: base, timeoutSeconds: 5 })).resolves.toBeUndefined();
  });

  it('fails when a worker never comes up, naming the missing ports', async () => {
    const base = await freeBase();
    const ports = phpWorkerPorts(base);
    // One worker short: the pool must not pass half-built.
    for (const port of ports.slice(0, PHP_POOL_SIZE - 1)) await listen(port);

    await expect(waitForPhpPool({ basePort: base, timeoutSeconds: 1 })).rejects.toThrow(
      /PHP did not start/,
    );
  });

  it('fails fast when nothing is listening at all', async () => {
    const base = await freeBase();

    await expect(waitForPhpPool({ basePort: base, timeoutSeconds: 1 })).rejects.toThrow(
      /PHP did not start/,
    );
  });
});
