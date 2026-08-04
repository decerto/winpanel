import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import { PANEL_PORT } from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import { listPanelServices } from '../windows/panel-services.js';
import { readServiceState } from '../windows/service-manager.js';
import type { CheckDefinition, CheckOutcome } from './engine.js';

/**
 * Server-level checks.
 *
 * These exist because a Windows Server that has never hosted Node before has a
 * handful of specific, unobvious problems, and every one of them produces a
 * symptom that points somewhere other than the cause. Detecting them up front
 * is worth far more than any amount of troubleshooting documentation.
 */

/** True when nothing is currently listening on the port. */
export async function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Ranges Windows has reserved for its own use.
 *
 * Hyper-V and WSL quietly reserve blocks of TCP ports. Binding inside one
 * fails with "permission denied" while `netstat` shows nothing listening,
 * which is one of the more baffling failures on Windows. Checking up front
 * turns an hour of confusion into a sentence.
 *
 * The result is cached for the process lifetime. These ranges are established
 * at boot and do not change while the server is running, so shelling out to
 * netsh on every port allocation is pure cost — noticeable on a slow machine,
 * where each process start is measured in seconds rather than milliseconds.
 */
let excludedRangeCache: Array<{ start: number; end: number }> | null = null;

export async function excludedPortRanges(): Promise<Array<{ start: number; end: number }>> {
  if (excludedRangeCache) return excludedRangeCache;
  if (process.platform !== 'win32') {
    excludedRangeCache = [];
    return excludedRangeCache;
  }

  const result = await runCommand({
    exe: 'netsh.exe',
    args: ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    // Not cached: a transient failure should not poison the whole run.
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    ranges.push({ start: Number.parseInt(match[1], 10), end: Number.parseInt(match[2], 10) });
  }

  excludedRangeCache = ranges;
  return ranges;
}

/** Clears the cache. Used after a reboot-related change, and by tests. */
export function clearExcludedPortRangeCache(): void {
  excludedRangeCache = null;
}

export function isPortExcluded(
  port: number,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => port >= range.start && port <= range.end);
}

/** Detects whether IIS is installed and holding the web ports. */
export async function detectIis(): Promise<{ present: boolean; running: boolean }> {
  if (process.platform !== 'win32') return { present: false, running: false };

  const result = await runCommand({
    exe: 'sc.exe',
    args: ['query', 'W3SVC'],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) return { present: false, running: false };
  return { present: true, running: readServiceState(result.stdout) === 'running' };
}

/** Reads the registry flag that lets Windows handle paths beyond 260 chars. */
export async function longPathsEnabled(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;

  const result = await runCommand({
    exe: 'reg.exe',
    args: [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
      '/v',
      'LongPathsEnabled',
    ],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) return false;
  return /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(result.stdout);
}

/** Whether the Windows Time service is running and synchronising. */
export async function timeSyncHealthy(): Promise<{ healthy: boolean; detail: string }> {
  if (process.platform !== 'win32') {
    return { healthy: true, detail: 'Not applicable on this platform.' };
  }

  const result = await runCommand({
    exe: 'w32tm.exe',
    args: ['/query', '/status'],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    return { healthy: false, detail: 'The Windows Time service is not running.' };
  }

  const offsetMatch = /Phase Offset:\s*([-\d.]+)s/i.exec(result.stdout);
  if (offsetMatch?.[1]) {
    const offsetSeconds = Math.abs(Number.parseFloat(offsetMatch[1]));
    // TOTP tolerates ~30s either side; beyond that sign-in starts failing.
    if (offsetSeconds > 20) {
      return {
        healthy: false,
        detail: `The clock is ${offsetSeconds.toFixed(1)} seconds out.`,
      };
    }
    return { healthy: true, detail: `Clock is accurate to ${offsetSeconds.toFixed(2)}s.` };
  }

  return { healthy: true, detail: 'Time synchronisation is active.' };
}

export async function freeDiskBytes(driveLetter = 'C'): Promise<number | null> {
  if (process.platform !== 'win32') {
    try {
      const stats = await fs.statfs('/');
      return stats.bavail * stats.bsize;
    } catch {
      return null;
    }
  }

  const result = await runCommand({
    exe: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-PSDrive -Name ${driveLetter}).Free`,
    ],
    timeoutMs: 20_000,
  });

  if (result.exitCode !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function buildServerChecks(): CheckDefinition[] {
  return [
    {
      id: 'server.iis-conflict',
      category: 'network',
      name: 'Web ports are free',
      plainDescription:
        'Windows ships with its own web server (IIS). If it is running it holds ports 80 ' +
        'and 443, and your websites cannot start.',
      ttlSeconds: 60,
      run: async (): Promise<CheckOutcome> => {
        const iis = await detectIis();

        if (iis.running) {
          return {
            state: 'blocked',
            detail: 'The built-in Windows web server is running.',
            reason:
              'It is using ports 80 and 443, which your websites need. ' +
              'It can be turned off safely if you are not using it.',
            fix: {
              kind: 'automatic',
              action: 'server.disable-iis',
              label: 'Turn off the built-in web server',
              describesChange:
                'Stops the World Wide Web Publishing Service and sets it not to start ' +
                'automatically. Nothing is uninstalled, and this can be undone.',
              safeToBatch: true,
              reversible: true,
            },
          };
        }

        if (iis.present) {
          return {
            state: 'ok',
            detail: 'The built-in Windows web server is installed but not running.',
          };
        }
        return { state: 'ok', detail: 'Ports 80 and 443 are available.' };
      },
    },

    {
      id: 'server.long-paths',
      category: 'server',
      name: 'Long file names allowed',
      plainDescription:
        'Website projects create very deeply nested folders. Windows blocks paths longer ' +
        'than 260 characters unless this is switched on.',
      ttlSeconds: 300,
      run: async (): Promise<CheckOutcome> => {
        const enabled = await longPathsEnabled();

        if (enabled === null) {
          return { state: 'ok', detail: 'Not applicable on this platform.' };
        }
        if (enabled) {
          return { state: 'ok', detail: 'Long file names are allowed.' };
        }

        return {
          state: 'warning',
          detail: 'Long file names are currently blocked.',
          reason:
            'Installing website packages will fail with confusing errors when folder ' +
            'names get long.',
          fix: {
            kind: 'automatic',
            action: 'server.enable-long-paths',
            label: 'Allow long file names',
            describesChange:
              'Sets LongPathsEnabled to 1 in the Windows registry. Takes effect for new ' +
              'programs immediately, and can be undone.',
            safeToBatch: true,
            reversible: true,
          },
        };
      },
    },

    {
      id: 'server.time-sync',
      category: 'server',
      name: 'Server clock is accurate',
      plainDescription:
        'Sign-in codes and website security certificates both depend on the server ' +
        'knowing the correct time.',
      ttlSeconds: 300,
      run: async (): Promise<CheckOutcome> => {
        const status = await timeSyncHealthy();

        if (status.healthy) return { state: 'ok', detail: status.detail };

        return {
          state: 'warning',
          detail: status.detail,
          reason:
            'If the clock drifts, your sign-in codes stop being accepted and new ' +
            'security certificates may be rejected.',
          fix: {
            kind: 'automatic',
            action: 'server.resync-time',
            label: 'Correct the clock',
            describesChange:
              'Starts the Windows Time service and synchronises with an internet time ' +
              'server.',
            safeToBatch: true,
            reversible: false,
          },
        };
      },
    },

    {
      id: 'server.panel-port',
      category: 'network',
      name: 'Control panel port',
      plainDescription: `This control panel is reached on port ${PANEL_PORT}.`,
      ttlSeconds: 120,
      run: async (): Promise<CheckOutcome> => {
        const ranges = await excludedPortRanges();

        if (isPortExcluded(PANEL_PORT, ranges)) {
          return {
            state: 'blocked',
            detail: `Windows has reserved port ${PANEL_PORT}.`,
            reason:
              'Another Windows feature has claimed this port, so the panel cannot be ' +
              'reached reliably.',
          };
        }

        return { state: 'ok', detail: `Port ${PANEL_PORT} is in use by this panel.` };
      },
    },

    {
      id: 'server.background-services',
      category: 'server',
      name: 'Background programs',
      plainDescription:
        'This panel, the web server, the mail server and every website run in the ' +
        'background with no window of their own. Whatever is running here is what has to ' +
        'be stopped before the panel can be updated or removed.',
      ttlSeconds: 60,
      run: async (): Promise<CheckOutcome> => {
        if (process.platform !== 'win32') {
          return { state: 'ok', detail: 'Not applicable on this platform.' };
        }

        const services = await listPanelServices();
        const running = services.filter((service) => service.state === 'running');

        /*
         * No registered services at all means the panel is running as a plain
         * program. It works, right up until the machine restarts and nothing
         * comes back, and the uninstaller cannot stop something Windows was
         * never told about.
         */
        if (!services.some((service) => service.kind === 'panel')) {
          return {
            state: 'warning',
            detail: 'Windows is not managing this panel.',
            reason:
              'The panel is running, but not as a background program Windows knows about. ' +
              'It will not start again by itself after a restart, and removing it will ' +
              'leave it running.',
            fix: {
              kind: 'manual',
              label: 'Register it with Windows',
              instructions:
                'Run the WinPanel installer again. It registers the panel and everything ' +
                'it runs so Windows starts and stops them for you.',
            },
          };
        }

        const names = running.map((service) => service.label);
        const shown = names.slice(0, 5).join(', ');
        const rest = names.length > 5 ? `, and ${names.length - 5} more` : '';

        return {
          state: 'ok',
          detail: `${names.length} of ${services.length} running: ${shown}${rest}.`,
        };
      },
    },

    {
      id: 'server.disk-space',
      category: 'server',
      name: 'Free disk space',
      plainDescription:
        'Websites, their packages, backups and email all need room. Running out causes ' +
        'deployments and mail delivery to fail.',
      ttlSeconds: 300,
      run: async (): Promise<CheckOutcome> => {
        const free = await freeDiskBytes();
        if (free === null) {
          return { state: 'unknown', reason: 'Could not read the amount of free space.' };
        }

        const gigabytes = free / 1024 ** 3;

        if (gigabytes < 2) {
          return {
            state: 'blocked',
            detail: formatBytes(free),
            reason: 'The server is almost out of space. Deployments will fail.',
          };
        }
        if (gigabytes < 10) {
          return {
            state: 'warning',
            detail: formatBytes(free),
            reason: 'Space is getting low. Consider removing old releases or backups.',
          };
        }
        return { state: 'ok', detail: `${formatBytes(free)} free` };
      },
    },

    {
      id: 'server.memory',
      category: 'server',
      name: 'Available memory',
      plainDescription: 'Each website and the mail server need memory to run.',
      ttlSeconds: 60,
      run: async (): Promise<CheckOutcome> => {
        const totalGb = os.totalmem() / 1024 ** 3;
        const freeGb = os.freemem() / 1024 ** 3;

        if (freeGb < 0.5) {
          return {
            state: 'warning',
            detail: `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB`,
            reason: 'Very little memory is free. Apps may be shut down unexpectedly.',
          };
        }
        return {
          state: 'ok',
          detail: `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB`,
        };
      },
    },

    {
      id: 'server.internet',
      category: 'network',
      name: 'Internet connection',
      plainDescription:
        'The server needs internet access to download software and obtain security ' +
        'certificates for your websites.',
      ttlSeconds: 120,
      run: async (): Promise<CheckOutcome> => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const response = await fetch('https://acme-v02.api.letsencrypt.org/directory', {
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (response.ok) return { state: 'ok', detail: 'Connected.' };
          return {
            state: 'warning',
            reason: `The certificate service replied with ${response.status}.`,
          };
        } catch {
          return {
            state: 'blocked',
            reason:
              'The server cannot reach the internet. Software downloads and website ' +
              'security certificates will not work.',
          };
        }
      },
    },
  ];
}
