import { describe, expect, it } from 'vitest';
import { buildServiceXml } from '../src/windows/service-manager.js';

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
