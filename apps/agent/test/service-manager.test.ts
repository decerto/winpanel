import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceManager,
  buildServiceXml,
  describeCrashLog,
  readServiceAccount,
  readServiceState,
  replaceEnvironmentInXml,
  splitAccountName,
  waitUntilGone,
  type ServiceState,
} from '../src/windows/service-manager.js';

describe('describeCrashLog', () => {
  it('picks the reason out of a Node crash rather than the version banner', () => {
    const log = [
      'node:internal/modules/cjs/loader:1215',
      '  throw err;',
      '  ^',
      '',
      "Error: Cannot find module 'C:\\WinPanel\\sites\\demo\\release\\index.js'",
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1212:15)',
      '    at Module._load (node:internal/modules/cjs/loader:1043:27) {',
      "  code: 'MODULE_NOT_FOUND',",
      '  requireStack: []',
      '}',
      '',
      'Node.js v24.18.1',
    ].join('\r\n');

    expect(describeCrashLog(log)).toBe(
      "Error: Cannot find module 'C:\\WinPanel\\sites\\demo\\release\\index.js'",
    );
  });

  it('finds a namespaced error class', () => {
    const log = 'starting up\nTypeError: handler is not a function\n    at run (app.js:3:1)\nNode.js v22.0.0';
    expect(describeCrashLog(log)).toBe('TypeError: handler is not a function');
  });

  it('falls back to the last meaningful line when nothing names an error', () => {
    const log = '{"level":30,"msg":"ready"}\nport 3001 is already taken\n\n';
    expect(describeCrashLog(log)).toBe('port 3001 is already taken');
  });

  it('has nothing to say about an empty log', () => {
    expect(describeCrashLog('\n\n   \n')).toBeNull();
  });
});

describe('replaceEnvironmentInXml', () => {
  const base = {
    id: 'winpanel-caddy',
    displayName: 'WinPanel Web server',
    description: 'Serves your websites',
    executable: 'C:\\WinPanel\\bin\\caddy.exe',
    args: ['run', '--resume'],
    logPath: 'C:\\WinPanel\\logs\\caddy',
  };

  it('adds a variable to a service that had none', () => {
    const updated = replaceEnvironmentInXml(buildServiceXml(base), { CF_API_TOKEN: 'secret' });
    expect(updated).toContain('<env name="CF_API_TOKEN" value="secret"/>');
  });

  it('removes variables that are no longer wanted', () => {
    /*
     * The whole environment is replaced rather than merged, so disconnecting
     * Cloudflare genuinely takes the token out. Merging would leave a revoked
     * secret sitting in a config file forever.
     */
    const withToken = buildServiceXml({ ...base, env: { XDG_DATA_HOME: 'C:\\x', CF_API_TOKEN: 'secret' } });
    const updated = replaceEnvironmentInXml(withToken, { XDG_DATA_HOME: 'C:\\x' });

    expect(updated).not.toContain('CF_API_TOKEN');
    expect(updated).toContain('<env name="XDG_DATA_HOME" value="C:\\x"/>');
  });

  it('matches what a fresh install would have written', () => {
    // If a rewrite produced a different-but-equivalent file, every panel
    // start would see a change and restart the web server for nothing.
    const env = { XDG_DATA_HOME: 'C:\\WinPanel\\caddy', CF_API_TOKEN: 'secret' };

    expect(replaceEnvironmentInXml(buildServiceXml(base), env)).toBe(
      buildServiceXml({ ...base, env }),
    );
  });

  it('leaves everything else in the file alone', () => {
    const updated = replaceEnvironmentInXml(buildServiceXml(base), { A: '1' });

    expect(updated).toContain('<executable>C:\\WinPanel\\bin\\caddy.exe</executable>');
    expect(updated).toContain('<argument>--resume</argument>');
    expect(updated).toContain('<onfailure action="restart" delay="5 sec"/>');
    expect(updated).toContain('</service>');
  });

  it('escapes a token containing XML syntax', () => {
    // A token is opaque text from another system; it must not be able to
    // reshape the document it lands in.
    const updated = replaceEnvironmentInXml(buildServiceXml(base), {
      CF_API_TOKEN: '"/><evil a="',
    });

    expect(updated).not.toContain('<evil');
    expect(updated).toContain('&quot;/&gt;&lt;evil a=&quot;');
  });
});

describe('buildServiceXml', () => {
  const base = {
    id: 'winpanel-site-kitora',
    displayName: 'kitora.io',
    description: 'Website: kitora.io',
    executable: 'C:\\WinPanel\\bin\\node\\node.exe',
    logPath: 'C:\\Sites\\kitora\\logs',
  };

  it('produces valid XML with the service identity', () => {
    const xml = buildServiceXml(base);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<id>winpanel-site-kitora</id>');
    expect(xml).toContain('<name>kitora.io</name>');
    expect(xml).toContain('<executable>C:\\WinPanel\\bin\\node\\node.exe</executable>');
  });

  it('emits each argument as its own element', () => {
    // One element per argument, never a single joined string: that is what
    // keeps a path containing spaces from being split into two arguments.
    const xml = buildServiceXml({
      ...base,
      args: ['.output/server/index.mjs', '--enable-source-maps'],
    });

    expect(xml).toContain('<argument>.output/server/index.mjs</argument>');
    expect(xml).toContain('<argument>--enable-source-maps</argument>');
  });

  it('sets the working directory, which differs from the repo root for monorepos', () => {
    // For the common "frontend builds into backend" layout the process must
    // run in backend/, not at the repository root.
    const xml = buildServiceXml({
      ...base,
      workingDirectory: 'C:\\Sites\\kitora\\release\\backend',
    });
    expect(xml).toContain(
      '<workingdirectory>C:\\Sites\\kitora\\release\\backend</workingdirectory>',
    );
  });

  it('writes environment variables', () => {
    const xml = buildServiceXml({
      ...base,
      env: { PORT: '3001', NITRO_HOST: '127.0.0.1' },
    });
    expect(xml).toContain('<env name="PORT" value="3001"/>');
    expect(xml).toContain('<env name="NITRO_HOST" value="127.0.0.1"/>');
  });

  it('escapes XML metacharacters so values cannot break the document', () => {
    // A site name or environment value containing & or < would otherwise
    // produce a malformed config that WinSW refuses, or worse, injects.
    const xml = buildServiceXml({
      ...base,
      displayName: 'Tom & Jerry <test>',
      env: { MOTTO: 'a "quoted" value & more' },
    });

    expect(xml).toContain('<name>Tom &amp; Jerry &lt;test&gt;</name>');
    expect(xml).toContain('&quot;quoted&quot;');
    expect(xml).not.toMatch(/<name>[^<]*<test>/);
  });

  it('restarts on failure with escalating delays', () => {
    // Sites crash occasionally; staying down after one bad request would turn
    // a transient fault into an outage.
    const xml = buildServiceXml(base);
    expect(xml).toContain('<onfailure action="restart" delay="5 sec"/>');
    expect(xml).toContain('<onfailure action="restart" delay="15 sec"/>');
    expect(xml).toContain('<onfailure action="restart" delay="60 sec"/>');
    expect(xml).toContain('<resetfailure>1 hour</resetfailure>');
  });

  it('starts automatically so sites come back after a reboot', () => {
    expect(buildServiceXml(base)).toContain('<startmode>Automatic</startmode>');
  });

  it('supports manual startup for user-controlled services', () => {
    expect(buildServiceXml({ ...base, startMode: 'manual' })).toContain('<startmode>Manual</startmode>');
  });

  it('rotates logs and keeps a bounded history', () => {
    const xml = buildServiceXml(base);
    expect(xml).toContain('roll-by-size-time');
    expect(xml).toContain('<keepFiles>14</keepFiles>');
  });

  it('supports running as a low-privilege account', () => {
    // Build steps run arbitrary package scripts, so they must not run as
    // LocalSystem.
    const xml = buildServiceXml({
      ...base,
      account: { username: '.\\winpanel-run', password: 'generated-secret' },
    });

    expect(xml).toContain('<domain>.</domain>');
    expect(xml).toContain('<user>winpanel-run</user>');
    expect(xml).toContain('<password>generated-secret</password>');
    expect(xml).toContain('<allowservicelogon>true</allowservicelogon>');
  });

  it('names the account the way WinSW v2 reads it, not the way v3 does', () => {
    /*
     * WinSW v2 reads <domain> and <user>. It accepts the <username> of v3
     * without complaint and ignores it, registering the service as
     * LocalSystem - which is how PostgreSQL came to be started with an
     * administrator token and refused to run at all.
     */
    const xml = buildServiceXml({
      ...base,
      account: { username: 'NT AUTHORITY\\NetworkService', password: '' },
    });

    expect(xml).toContain('<domain>NT AUTHORITY</domain>');
    expect(xml).toContain('<user>NetworkService</user>');
    expect(xml).not.toContain('<username>');
  });

  it('leaves out the password of an account that has none', () => {
    // The built-in accounts have no password, and an empty element is not the
    // same as no element to every reader of this file.
    const xml = buildServiceXml({
      ...base,
      account: { username: 'NT AUTHORITY\\NetworkService', password: '' },
    });

    expect(xml).not.toContain('<password>');
  });

  it('omits the account block entirely when none is given', () => {
    expect(buildServiceXml(base)).not.toContain('<serviceaccount>');
  });

  it('lays out a service account configuration before registering it', async () => {
    const configDir = path.join(os.tmpdir(), `winpanel-account-${Date.now()}`);
    await fs.mkdir(configDir, { recursive: true });
    const template = path.join(configDir, 'WinSW.exe');
    await fs.writeFile(template, 'stand-in for the wrapper binary');

    try {
      const manager = new ServiceManager(template, path.join(configDir, 'services'));

      await expect(
        manager.install({
          ...base,
          id: 'winpanel-postgres',
          account: { username: 'NT AUTHORITY\\NetworkService', password: '' },
        }),
      ).rejects.toThrow();

      await expect(fs.access(manager.wrapperPathFor('winpanel-postgres'))).resolves.toBeUndefined();
      await expect(
        fs.readFile(path.join(configDir, 'services', 'winpanel-postgres.xml'), 'utf8'),
      ).resolves.toContain('<user>NetworkService</user>');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('readServiceAccount', () => {
  const qc = (account: string) =>
    [
      '[SC] QueryServiceConfig SUCCESS',
      '',
      'SERVICE_NAME: winpanel-postgres',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      '        BINARY_PATH_NAME   : C:\\WinPanel\\data\\services\\winpanel-postgres.exe',
      `        SERVICE_START_NAME : ${account}`,
    ].join('\r\n');

  it('reads the account a service is registered to run as', () => {
    expect(readServiceAccount(qc('NT AUTHORITY\\NetworkService'))).toBe(
      'NT AUTHORITY\\NetworkService',
    );
  });

  it('spots a service that silently fell back to LocalSystem', () => {
    // The failure this exists to catch: PostgreSQL will not run under an
    // administrator token, and LocalSystem is one.
    expect(readServiceAccount(qc('LocalSystem'))).toBe('LocalSystem');
  });

  it('has nothing to report when the service is not there', () => {
    expect(readServiceAccount('The specified service does not exist.')).toBeNull();
  });
});

describe('splitAccountName', () => {
  it('separates a built-in account from its authority', () => {
    expect(splitAccountName('NT AUTHORITY\\NetworkService')).toEqual({
      domain: 'NT AUTHORITY',
      user: 'NetworkService',
    });
  });

  it('treats a bare name as having no domain', () => {
    expect(splitAccountName('LocalSystem')).toEqual({ domain: null, user: 'LocalSystem' });
  });
});

describe('readServiceState', () => {
  const block = (code: string, word: string) =>
    [
      'SERVICE_NAME: winpanel-site-running-late-blue',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      `        STATE              : ${code}  ${word}`,
      '        WIN32_EXIT_CODE    : 0  (0x0)',
    ].join('\r\n');

  it('reads the state of a service whose own name contains a state word', () => {
    // Searching the whole output for "RUNNING" matched the service name, so a
    // stopped website reported itself as running.
    expect(readServiceState(block('1', 'STOPPED'))).toBe('stopped');
  });

  it('trusts the number rather than the word, which is translated', () => {
    expect(readServiceState(block('4', 'WIRD_AUSGEF\u00dcHRT'))).toBe('running');
  });

  it('treats output with no state line as nothing installed', () => {
    expect(readServiceState('The specified service does not exist.')).toBe('not-installed');
  });
});

describe('waitUntilGone', () => {
  it('gives a deleted service time to disappear', async () => {
    // sc delete only marks the service; Windows reports it as stopped until
    // the last handle to it closes. Checking once fails a deploy needlessly.
    const states: ServiceState[] = ['stopped', 'stopped', 'not-installed'];
    let seen = 0;

    const gone = await waitUntilGone(
      async () => states[seen++] ?? 'not-installed',
      1_000,
      1,
    );

    expect(gone).toBe(true);
    expect(seen).toBe(3);
  });

  it('gives up on a service that never goes away', async () => {
    expect(await waitUntilGone(async () => 'running', 5, 1)).toBe(false);
  });
});

describe('ServiceManager layout', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-services-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('gives each service its own copy of the wrapper, named to match its config', async () => {
    /*
     * WinSW v2 cannot be told where its configuration is. It loads
     * `<its own filename>.xml` from its own directory, and a config path on
     * the command line is accepted and ignored. Registering the panel by
     * passing the config path therefore produced a service that exited at
     * once looking for `WinSW.xml`, and the installed panel never ran.
     */
    const template = path.join(root, 'WinSW.exe');
    await fs.writeFile(template, 'stand-in for the wrapper binary');

    const configDir = path.join(root, 'services');
    const manager = new ServiceManager(template, configDir);

    // The stand-in cannot actually execute, so registration fails - after the
    // files have been laid out, which is what matters here.
    await expect(
      manager.install({
        id: 'winpanel-agent',
        displayName: 'WinPanel',
        description: 'Website and email control panel.',
        executable: 'C:\\WinPanel\\bin\\node\\node.exe',
        logPath: path.join(root, 'logs'),
      }),
    ).rejects.toThrow();

    expect(manager.wrapperPathFor('winpanel-agent')).toBe(
      path.join(configDir, 'winpanel-agent.exe'),
    );
    await expect(fs.readFile(path.join(configDir, 'winpanel-agent.xml'), 'utf8')).resolves.toContain(
      '<id>winpanel-agent</id>',
    );
    await expect(fs.access(path.join(configDir, 'winpanel-agent.exe'))).resolves.toBeUndefined();
  });
});

/**
 * A wrapper that exits without taking its child with it leaves the program
 * running while Windows reports the service as stopped: still serving, still
 * holding its port, still holding its files. Stopping and restarting have to
 * account for that, or "Stop app" does not stop the app and "Restart" hands
 * the port straight back to the copy that should have died.
 */
describe.runIf(process.platform === 'win32')('ServiceManager recovery', () => {
  const SERVICE_ID = 'winpanel-site-shop-blue';

  let root: string;
  let configDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-recovery-'));
    configDir = path.join(root, 'services');
    await fs.mkdir(configDir, { recursive: true });

    /*
     * A stand-in for the WinSW wrapper that is a real Windows program, so the
     * commands genuinely run and genuinely fail. Linked rather than copied:
     * the interpreter is a hundred megabytes and none of it is read.
     */
    const wrapper = path.join(configDir, `${SERVICE_ID}.exe`);
    await fs.link(process.execPath, wrapper).catch(() => fs.copyFile(process.execPath, wrapper));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('frees the port when stopping, so a stopped app is really stopped', async () => {
    const cleared: string[] = [];

    const manager = new ServiceManager(path.join(root, 'WinSW.exe'), configDir, {
      unblock: async (id) => {
        cleared.push(id);
        return true;
      },
      describeBlockers: async () => null,
    });

    await manager.stop(SERVICE_ID);

    expect(cleared).toEqual([SERVICE_ID]);
  }, 30_000);

  it('clears the port on the way through a restart, and says what it will not end', async () => {
    const cleared: string[] = [];

    const manager = new ServiceManager(path.join(root, 'WinSW.exe'), configDir, {
      // Nothing of ours was in the way, so no second attempt is worth making.
      unblock: async (id) => {
        cleared.push(id);
        return false;
      },
      describeBlockers: async () => 'someone-elses-app.exe (process 4242) on port 3001',
    });

    await expect(manager.restart(SERVICE_ID)).rejects.toThrow(/someone-elses-app\.exe/);

    // Once on the way down, once when it would not come back up.
    expect(cleared).toEqual([SERVICE_ID, SERVICE_ID]);
  }, 30_000);
});
