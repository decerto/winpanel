import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.hoisted(() => vi.fn());
vi.mock('../src/process/run-command.js', () => ({ runCommand: runCommandMock }));

import { killServiceProcess, processesInsideFolder } from '../src/windows/stray-processes.js';

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
describe('processesInsideFolder', () => {
  const listing = JSON.stringify([
    { ProcessId: 10, Name: 'node.exe', ExecutablePath: 'C:\\WinPanel\\bin\\node\\node.exe', CommandLine: '"C:\\WinPanel\\bin\\node\\node.exe" C:\\WinPanel\\sites\\ds\\release\\cluster.js 2 index.js' },
    { ProcessId: 11, Name: 'app.exe', ExecutablePath: 'C:\\WinPanel\\sites\\ds\\release\\app.exe', CommandLine: null },
    { ProcessId: 12, Name: 'php-cgi.exe', ExecutablePath: 'C:\\WinPanel\\bin\\php\\php-cgi.exe', CommandLine: 'php-cgi.exe -c C:/WinPanel/sites/ds/logs/php.ini' },
    { ProcessId: 13, Name: 'node.exe', ExecutablePath: 'C:\\WinPanel\\bin\\node\\node.exe', CommandLine: 'node.exe C:\\WinPanel\\sites\\ds-shop\\release\\cluster.js' },
    { ProcessId: 14, Name: 'svchost.exe', ExecutablePath: null, CommandLine: null },
    { ProcessId: process.pid, Name: 'node.exe', ExecutablePath: 'C:\\WinPanel\\sites\\ds\\x.exe', CommandLine: null },
  ]);

  it('finds programs that live in the folder or name it on their command line', () => {
    expect(processesInsideFolder(listing, 'C:\\WinPanel\\sites\\ds').map((one) => one.pid)).toEqual([
      10, 11, 12,
    ]);
  });

  it('accepts a single process, which PowerShell prints without an array', () => {
    const single = JSON.stringify({ ProcessId: 11, Name: 'app.exe', ExecutablePath: 'C:\\WinPanel\\sites\\ds\\app.exe' });
    expect(processesInsideFolder(single, 'C:\\WinPanel\\sites\\ds\\')).toEqual([{ pid: 11, name: 'app.exe' }]);
  });

  it('finds nothing in output it cannot read', () => {
    expect(processesInsideFolder('', 'C:\\WinPanel\\sites\\ds')).toEqual([]);
  });
});
