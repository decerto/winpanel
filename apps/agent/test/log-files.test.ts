import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLogFiles, readLogFile } from '../src/logs/log-files.js';

let tmpDir: string;
let logDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-log-files-'));
  logDir = path.join(tmpDir, 'logs');
  await fs.mkdir(logDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('log file catalogue', () => {
  it('lists log files and reads a bounded, newest tail', async () => {
    await fs.writeFile(
      path.join(logDir, 'winpanel-agent.out.log'),
      [
        JSON.stringify({ time: Date.now() - 2_000, level: 30, msg: 'started' }),
        JSON.stringify({ time: Date.now() - 1_000, level: 40, msg: 'slow request' }),
        'plain diagnostic line',
      ].join('\n'),
      'utf8',
    );

    const listed = await listLogFiles(logDir);
    expect(listed.map((log) => log.id)).toEqual(['winpanel-agent.out.log']);

    const result = await readLogFile(logDir, 'winpanel-agent.out.log', 2);
    expect(result?.lines.map((line) => line.message)).toEqual(['slow request', 'plain diagnostic line']);
    expect(result?.lines[0]).toMatchObject({ level: 'warn' });
    expect(result?.truncated).toBe(true);
  });

  it('reads severity and time out of unstructured application output', async () => {
    await fs.writeFile(
      path.join(logDir, 'winpanel-site-example-blue.err.log'),
      [
        '2026-08-27T10:15:00.000Z Listening on port 4100',
        'Error: connect ECONNREFUSED 127.0.0.1:5432',
        'npm WARN deprecated request@2.88.2',
        'a line about errorless behaviour',
      ].join('\n'),
      'utf8',
    );

    const result = await readLogFile(logDir, 'winpanel-site-example-blue.err.log', 10);

    expect(result?.lines.map((line) => line.level)).toEqual(['info', 'error', 'warn', 'info']);
    expect(result?.lines[0]?.at).toBe(Date.parse('2026-08-27T10:15:00.000Z'));
  });

  it('refuses unknown ids and traversal attempts', async () => {
    await fs.writeFile(path.join(logDir, 'known.log'), 'private output\n', 'utf8');

    for (const id of [
      '../panel.db',
      '..\\panel.db',
      'C:\\Windows\\System32\\config\\SAM',
      '..%2fknown.log',
      'unknown.log',
    ]) {
      expect(await readLogFile(logDir, id, 10), id).toBeNull();
    }
  });

  it('does not list a symlink outside the log directory', async () => {
    const outside = path.join(tmpDir, 'outside.log');
    const link = path.join(logDir, 'outside.log');
    await fs.writeFile(outside, 'secret output\n', 'utf8');

    try {
      await fs.symlink(outside, link, 'file');
    } catch {
      // Symlink creation may be disabled on a Windows CI worker.
      return;
    }

    expect(await listLogFiles(logDir)).toEqual([]);
    expect(await readLogFile(logDir, 'outside.log', 10)).toBeNull();
  });

  it('keeps the website access-log subtree out of the panel catalogue', async () => {
    const accessDir = path.join(logDir, 'access');
    await fs.mkdir(accessDir, { recursive: true });
    await fs.writeFile(path.join(accessDir, 'example.log'), 'request record\n', 'utf8');

    expect(await listLogFiles(logDir, [accessDir])).toEqual([]);
    expect(await readLogFile(logDir, 'access/example.log', 10, [accessDir])).toBeNull();
  });
});