import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/*
 * These run the real supervisor against small apps. The supervisor is
 * TypeScript here (Node strips the types), so the test exercises the same file
 * that the agent build copies into each site.
 */

const runner = path.join(import.meta.dirname, '..', 'src', 'sites', 'node-cluster-standalone.ts');

const APP = `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync(process.env.PID_LOG, process.pid + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`;

const CRASHING_APP = `
import fs from 'node:fs';
fs.appendFileSync(process.env.PID_LOG, process.pid + '\\n');
process.exit(1);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

describe('node cluster supervisor', () => {
  let dir: string;
  let pidLog: string;
  let supervisor: ChildProcess | undefined;

  const loggedPids = async (): Promise<number[]> => {
    const text = await fs.readFile(pidLog, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map(Number);
  };

  const start = (entry: string, workers: number, port: number): ChildProcess => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', runner, String(workers), entry],
      {
        cwd: dir,
        env: { ...process.env, PORT: String(port), PID_LOG: pidLog },
        stdio: 'ignore',
      },
    );
    supervisor = child;
    return child;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-cluster-'));
    pidLog = path.join(dir, 'pids.log');
    await fs.writeFile(path.join(dir, 'app.mjs'), APP);
    await fs.writeFile(path.join(dir, 'crashing.mjs'), CRASHING_APP);
  });

  afterEach(async () => {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill('SIGKILL');
    }
    for (const pid of await loggedPids()) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('shares one port across the workers, replaces one that dies, and exits with the supervisor', async () => {
    const port = await freePort();
    start('app.mjs', 3, port);

    await waitFor(async () => (await loggedPids()).length >= 3, 20_000, 'three workers');
    await waitFor(async () => (await get(port).catch(() => '')) === 'ok', 20_000, 'the site to answer');

    const [first, second, third] = await loggedPids();
    expect(new Set([first, second, third]).size).toBe(3);

    process.kill(first as number, 'SIGKILL');
    await waitFor(async () => (await loggedPids()).length >= 4, 20_000, 'a replacement worker');
    const replacement = (await loggedPids())[3] as number;
    expect(isAlive(replacement)).toBe(true);
    expect(await get(port)).toBe('ok');

    const running = [second, third, replacement] as number[];
    supervisor?.kill('SIGKILL');
    await waitFor(() => running.every((pid) => !isAlive(pid)), 15_000, 'the workers to exit');
  }, 90_000);

  it('stops the website when its workers keep crashing', async () => {
    const child = start('crashing.mjs', 2, await freePort());
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

    expect(code).toBe(1);
    expect((await loggedPids()).length).toBeGreaterThan(10);
  }, 60_000);
});
