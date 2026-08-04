import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceManager,
  buildServiceXml,
  readServiceState,
  replaceEnvironmentInXml,
  waitUntilGone,
  type ServiceState,
} from '../src/windows/service-manager.js';

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
      workingDirectory: 'C:\\Sites\\kitora\\current\\backend',
    });
    expect(xml).toContain(
      '<workingdirectory>C:\\Sites\\kitora\\current\\backend</workingdirectory>',
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

    expect(xml).toContain('<username>.\\winpanel-run</username>');
    expect(xml).toContain('<allowservicelogon>true</allowservicelogon>');
  });

  it('omits the account block entirely when none is given', () => {
    expect(buildServiceXml(base)).not.toContain('<serviceaccount>');
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
