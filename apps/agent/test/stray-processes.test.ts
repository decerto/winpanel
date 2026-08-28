import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.hoisted(() => vi.fn());
vi.mock('../src/process/run-command.js', () => ({ runCommand: runCommandMock }));

import { killServiceProcess } from '../src/windows/stray-processes.js';

describe('killServiceProcess', () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it('kills only a PID whose current image is the service wrapper', async () => {
    runCommandMock.mockImplementation(async ({ exe }: { exe: string }) => {
      if (exe === 'sc.exe') return { exitCode: 0, stdout: 'PID : 4321', stderr: '' };
      if (exe === 'tasklist.exe') return { exitCode: 0, stdout: '"winpanel-caddy.exe","4321"', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(killServiceProcess('winpanel-caddy')).resolves.toBe(true);
    expect(runCommandMock).toHaveBeenLastCalledWith(expect.objectContaining({
      exe: 'taskkill.exe',
      args: ['/PID', '4321', '/T', '/F'],
    }));
  });

  it('refuses a PID that has been reused by another executable', async () => {
    runCommandMock.mockImplementation(async ({ exe }: { exe: string }) => {
      if (exe === 'sc.exe') return { exitCode: 0, stdout: 'PID : 4321', stderr: '' };
      if (exe === 'tasklist.exe') return { exitCode: 0, stdout: '"other-service.exe","4321"', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(killServiceProcess('winpanel-caddy')).resolves.toBe(false);
    expect(runCommandMock).not.toHaveBeenCalledWith(expect.objectContaining({ exe: 'taskkill.exe' }));
  });

  it('does not trust output from a failed service query', async () => {
    runCommandMock.mockResolvedValue({
      exitCode: 1,
      stdout: 'PID : 4321',
      stderr: 'The specified service does not exist.',
    });

    await expect(killServiceProcess('winpanel-caddy')).resolves.toBe(false);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });
});