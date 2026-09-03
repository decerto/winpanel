import { describe, expect, it } from 'vitest';
import { CommandCancelledError, runCommand } from '../src/process/run-command.js';

describe('runCommand cancellation', () => {
  it('terminates a running child when its signal is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const command = runCommand({
      exe: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(command).rejects.toBeInstanceOf(CommandCancelledError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects immediately when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCommand({ exe: process.execPath, args: ['-e', 'process.exit(0)'], signal: controller.signal }),
    ).rejects.toBeInstanceOf(CommandCancelledError);
  });
});