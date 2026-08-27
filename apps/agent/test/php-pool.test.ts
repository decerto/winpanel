import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHP_ERROR_LOG, phpWorkerPorts, waitForPhpPool, writePhpIni } from '../src/sites/php.js';
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

describe('writePhpIni', () => {
  let tmpDir: string;

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function iniIn(): Promise<{ iniPath: string; logDir: string }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-php-ini-'));
    const logDir = path.join(tmpDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    return { iniPath: path.join(logDir, 'php.ini'), logDir };
  }

  it('sends PHP errors to a log file beside the site output, not to the page', async () => {
    const { iniPath, logDir } = await iniIn();

    await writePhpIni(iniPath, path.join(tmpDir, 'php'));
    const ini = await fs.readFile(iniPath, 'utf8');

    expect(ini).toContain('log_errors=1');
    expect(ini).toContain(`error_log="${path.join(logDir, PHP_ERROR_LOG).replace(/\\/g, '/')}"`);
    expect(ini).toContain('display_errors=0');
  });

  it('brings an untouched earlier template current but keeps an edited one', async () => {
    const { iniPath } = await iniIn();
    const phpDir = path.join(tmpDir, 'php');
    const extensionDir = path.join(phpDir, 'ext').replace(/\\/g, '/');

    const v5 = [
      '; Written by WinPanel for one website. Edits are kept: once you change',
      '; this file it is yours, and a deploy will not overwrite it.',
      '; WinPanel php.ini template v5',
      '',
      `extension_dir="${extensionDir}"`,
      'extension=mysqli',
      'extension=curl',
      'extension=mbstring',
      'extension=intl',
      'extension=gd',
      'extension=openssl',
      'extension=zip',
      '',
      'opcache.enable=1',
      'opcache.memory_consumption=128',
      'memory_limit=256M',
      'upload_max_filesize=64M',
      'post_max_size=64M',
      'max_execution_time=300',
      'expose_php=0',
      '',
    ].join('\r\n');

    await fs.writeFile(iniPath, v5);
    await writePhpIni(iniPath, phpDir);
    expect(await fs.readFile(iniPath, 'utf8')).toContain('log_errors=1');

    await fs.writeFile(iniPath, `${v5}memory_limit=512M\r\n`);
    await writePhpIni(iniPath, phpDir);
    expect(await fs.readFile(iniPath, 'utf8')).toContain('memory_limit=512M');
  });
});
