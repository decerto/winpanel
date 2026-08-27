import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPanelLogs, readPanelLog } from '../src/logs/panel-logs.js';

let tmpDir: string;
let logDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-panel-logs-'));
  logDir = path.join(tmpDir, 'logs');
  await fs.mkdir(logDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('panel log catalogue', () => {
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

    const listed = await listPanelLogs(logDir);
    expect(listed.map((log) => log.id)).toEqual(['winpanel-agent.out.log']);

    const result = await readPanelLog(logDir, 'winpanel-agent.out.log', 2);
    expect(result?.lines.map((line) => line.message)).toEqual(['slow request', 'plain diagnostic line']);
    expect(result?.lines[0]).toMatchObject({ level: 'warn' });
    expect(result?.truncated).toBe(true);
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
      expect(await readPanelLog(logDir, id, 10), id).toBeNull();
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

    expect(await listPanelLogs(logDir)).toEqual([]);
    expect(await readPanelLog(logDir, 'outside.log', 10)).toBeNull();
  });

  it('keeps the website access-log subtree out of the panel catalogue', async () => {
    const accessDir = path.join(logDir, 'access');
    await fs.mkdir(accessDir, { recursive: true });
    await fs.writeFile(path.join(accessDir, 'example.log'), 'request record\n', 'utf8');

    expect(await listPanelLogs(logDir, [accessDir])).toEqual([]);
    expect(await readPanelLog(logDir, 'access/example.log', 10, [accessDir])).toBeNull();
  });
});