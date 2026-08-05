import { describe, expect, it } from 'vitest';
import { PANEL_PORT } from '@winpanel/shared';
import {
  buildDeleteArgs,
  buildFirewallArgs,
  mailFirewallRules,
  panelUrlFor,
  requiredFirewallRules,
} from '../src/bootstrap/windows-setup.js';

describe('required firewall rules', () => {
  const rules = requiredFirewallRules();

  it('opens the control panel port', () => {
    const panel = rules.find((rule) => rule.port === PANEL_PORT);
    expect(panel?.action).toBe('allow');
    expect(panel?.protocol).toBe('TCP');
  });

  it('opens both website ports, including HTTP/3 over UDP', () => {
    expect(rules.some((r) => r.port === 80 && r.protocol === 'TCP' && r.action === 'allow')).toBe(true);
    expect(rules.some((r) => r.port === 443 && r.protocol === 'TCP' && r.action === 'allow')).toBe(true);
    expect(rules.some((r) => r.port === 443 && r.protocol === 'UDP' && r.action === 'allow')).toBe(true);
  });

  it('keeps port 80 open, which certificate renewal depends on', () => {
    // Closing 80 as "unused" is a classic way to break renewals months later.
    const http = rules.find((rule) => rule.port === 80);
    expect(http?.action).toBe('allow');
    expect(http?.purpose).toMatch(/certificate/i);
  });

  it('explicitly blocks the web server admin interface', () => {
    // It binds to loopback already, but a rule means a future
    // misconfiguration cannot quietly expose something that can rewrite
    // every site on the box and has no password of its own.
    const admin = rules.find((rule) => rule.port === 2019);
    expect(admin?.action).toBe('block');
  });

  it('explicitly blocks the mail server admin interface', () => {
    expect(rules.find((rule) => rule.port === 8080)?.action).toBe('block');
  });

  it('does not open the mail ports by default', () => {
    // Mail ports open only once mail is actually configured.
    for (const port of [25, 465, 587, 993]) {
      expect(rules.some((rule) => rule.port === port), `port ${port}`).toBe(false);
    }
  });

  it('explains each rule in plain English', () => {
    for (const rule of rules) {
      expect(rule.purpose.length, rule.name).toBeGreaterThan(15);
      expect(rule.purpose, rule.name).not.toMatch(/netsh|advfirewall|TCP\/|inbound rule/i);
    }
  });

  it('names every rule so the uninstaller can find them', () => {
    for (const rule of [...rules, ...mailFirewallRules()]) {
      expect(rule.name, rule.name).toMatch(/^WinPanel - /);
    }
  });
});

describe('mail firewall rules', () => {
  const rules = mailFirewallRules();

  it('covers receiving and sending', () => {
    const ports = rules
      .map((rule) => rule.port)
      .filter((port): port is number => typeof port === 'number')
      .sort((a, b) => a - b);
    expect(ports).toEqual([25, 465, 587, 993, 995]);
  });

  it('allows rather than blocks', () => {
    for (const rule of rules) expect(rule.action, rule.name).toBe('allow');
  });
});

describe('buildFirewallArgs', () => {
  it('builds a well-formed allow rule', () => {
    const args = buildFirewallArgs({
      name: 'WinPanel - Test',
      port: 8443,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'testing',
    });

    expect(args).toContain('advfirewall');
    expect(args).toContain('name=WinPanel - Test');
    expect(args).toContain('dir=in');
    expect(args).toContain('action=allow');
    expect(args).toContain('protocol=TCP');
    expect(args).toContain('localport=8443');
    expect(args).toContain('enable=yes');
  });

  it('passes the rule name as one argument, spaces and all', () => {
    // Split across two arguments, netsh would create a rule with the wrong
    // name and the uninstaller would never find it.
    const args = buildFirewallArgs({
      name: 'WinPanel - Websites (HTTPS)',
      port: 443,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'x',
    });

    expect(args).toContain('name=WinPanel - Websites (HTTPS)');
  });

  it('scopes block rules to remote traffic so loopback still works', () => {
    const args = buildFirewallArgs({
      name: 'WinPanel - Block admin',
      port: 2019,
      protocol: 'TCP',
      action: 'block',
      purpose: 'x',
    });

    expect(args).toContain('action=block');
    expect(args).toContain('remoteip=any');
  });

  it('builds a matching delete rule', () => {
    expect(buildDeleteArgs('WinPanel - Test')).toEqual([
      'advfirewall',
      'firewall',
      'delete',
      'rule',
      'name=WinPanel - Test',
    ]);
  });
});

describe('panelUrlFor', () => {
  it('uses the fixed panel port', () => {
    expect(panelUrlFor('203.0.113.10', true)).toBe(`https://203.0.113.10:${PANEL_PORT}`);
  });

  it('reflects the chosen scheme', () => {
    expect(panelUrlFor('203.0.113.10', false)).toBe(`http://203.0.113.10:${PANEL_PORT}`);
  });
});
