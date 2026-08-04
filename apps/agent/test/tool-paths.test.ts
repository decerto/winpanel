import { describe, expect, it } from 'vitest';
import { scriptFromShim } from '../src/sites/tool-paths.js';
import { explainSpawnFailure } from '../src/sites/deploy-pipeline.js';
import {
  installerArguments,
  scheduleInstallerArguments,
  updateTaskCommand,
  validateUpdateUrl,
} from '../src/components/panel-update.js';

/**
 * The pieces that decide how an external program is started.
 *
 * All three exist because of the same failure: a deployment that died with a
 * bare `spawn EINVAL` because a `.cmd` shim was handed to Windows, which since
 * Node 20.12 refuses to start one without a shell.
 */

describe('scriptFromShim', () => {
  const npmStyleShim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      '"%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*',
  ].join('\r\n');

  it('finds the JavaScript a package manager shim would have run', () => {
    expect(scriptFromShim(npmStyleShim)).toBe('node_modules\\pnpm\\bin\\pnpm.cjs');
  });

  it('reads the %~dp0 spelling as well', () => {
    expect(scriptFromShim('"%~dp0\\node_modules\\yarn\\bin\\yarn.js" %*')).toBe(
      'node_modules\\yarn\\bin\\yarn.js',
    );
  });

  it('gives back nothing when the shim runs a program rather than a script', () => {
    expect(scriptFromShim('@"%~dp0\\pnpm.exe" %*')).toBeNull();
  });
});

describe('explainSpawnFailure', () => {
  it('explains the shim failure in terms of what to do about it', () => {
    const error = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    const explained = explainSpawnFailure(error, 'pnpm', 'Install packages');

    expect(explained.message).toContain('pnpm');
    expect(explained.message).toContain('Components list');
    expect(explained.message).not.toContain('EINVAL');
    expect(explained.step).toBe('Install packages');
  });

  it('explains a missing program as a missing program', () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(explainSpawnFailure(error, 'bun', 'Install packages').message).toContain(
      'is not installed on this server',
    );
  });
});

describe('validateUpdateUrl', () => {
  it('accepts an https address', () => {
    expect(validateUpdateUrl('https://example.com/WinPanel-Setup-x64.exe').ok).toBe(true);
  });

  it.each(['http://example.com/setup.exe', 'file:///C:/setup.exe', 'not a url'])(
    'refuses %s',
    (candidate) => {
      expect(validateUpdateUrl(candidate).ok).toBe(false);
    },
  );
});

describe('installerArguments', () => {
  it('never lets the installer decide to reboot the server', () => {
    expect(installerArguments('C:\\logs\\update.log')).toContain('/NORESTART');
  });
});

describe('the update task', () => {
  const command = updateTaskCommand(
    'C:\\Program Files\\WinPanel\\bin\\.downloads\\winpanel-update.exe',
    'C:\\Program Files\\WinPanel\\logs\\winpanel-update.log',
  );

  it('quotes the installer path, which may contain spaces', () => {
    expect(command.startsWith('"C:\\Program Files\\')).toBe(true);
    expect(command).toContain('.exe" /VERYSILENT');
  });

  it('runs as SYSTEM and cannot fire on its own', () => {
    const args = scheduleInstallerArguments(command);

    expect(args[args.indexOf('/RU') + 1]).toBe('SYSTEM');
    expect(args[args.indexOf('/SD') + 1]).toBe('01/01/2099');
    // The command must be one argument, not split across several, or the task
    // scheduler is handed a truncated command line.
    expect(args[args.indexOf('/TR') + 1]).toBe(command);
  });
});
