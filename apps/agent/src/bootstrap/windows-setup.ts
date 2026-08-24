import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PANEL_PORT,
  CADDY_ADMIN_PORT,
  PREVIEW_PORT_RANGE_END,
  PREVIEW_PORT_RANGE_START,
  STALWART_HTTP_PORT,
} from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import { DATABASE_FIREWALL_ENGINES, databaseFirewallRuleName } from '../databases/network.js';

/**
 * Windows Firewall rules.
 *
 * Two jobs. Open the ports the panel and the websites genuinely need, and
 * explicitly *deny* the administrative ports from anything but this machine.
 *
 * The deny rules matter more than they look. Caddy's admin API can rewrite
 * every site on the box and has no authentication of its own; it binds to
 * loopback, but a firewall rule means a future misconfiguration cannot quietly
 * expose it.
 */

export interface FirewallRule {
  name: string;
  /** A single port, or a `start-end` range in netsh's own syntax. */
  port: number | string;
  protocol: 'TCP' | 'UDP';
  action: 'allow' | 'block';
  /** Optional source address or comma-separated list of sources. */
  remoteIp?: string;
  /** Human-readable reason, shown in the panel. */
  purpose: string;
}

const RULE_PREFIX = 'WinPanel';

export function requiredFirewallRules(): FirewallRule[] {
  return [
    {
      name: `${RULE_PREFIX} - Control panel`,
      port: PANEL_PORT,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'Lets you reach this control panel.',
    },
    {
      name: `${RULE_PREFIX} - Websites (HTTP)`,
      port: 80,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'Visitors reaching your websites, and certificate renewal.',
    },
    {
      name: `${RULE_PREFIX} - Websites (HTTPS)`,
      port: 443,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'Visitors reaching your websites securely.',
    },
    {
      name: `${RULE_PREFIX} - Websites (HTTP/3)`,
      port: 443,
      protocol: 'UDP',
      action: 'allow',
      purpose: 'Faster connections for visitors whose browsers support it.',
    },
    {
      // Every site gets one of these, so it can be opened in a browser before
      // a domain is bought or DNS has propagated. Without it a new site can
      // only be reached from the server's own desktop.
      name: `${RULE_PREFIX} - Website previews`,
      port: `${PREVIEW_PORT_RANGE_START}-${PREVIEW_PORT_RANGE_END}`,
      protocol: 'TCP',
      action: 'allow',
      purpose: 'Lets you open a website by IP address before its domain works.',
    },
    {
      // Blocked rather than merely unbound: this endpoint can reconfigure
      // every website on the server and has no password of its own.
      name: `${RULE_PREFIX} - Block web server admin`,
      port: CADDY_ADMIN_PORT,
      protocol: 'TCP',
      action: 'block',
      purpose: 'Keeps the web server\u2019s control interface private to this machine.',
    },
    {
      name: `${RULE_PREFIX} - Block mail server admin`,
      port: STALWART_HTTP_PORT,
      protocol: 'TCP',
      action: 'block',
      purpose: 'Keeps the mail server\u2019s control interface private to this machine.',
    },
  ];
}

/** Mail ports, applied only once mail is actually set up. */
export function mailFirewallRules(): FirewallRule[] {
  return [
    { name: `${RULE_PREFIX} - Mail (SMTP)`, port: 25, protocol: 'TCP', action: 'allow', purpose: 'Receiving email from other servers.' },
    { name: `${RULE_PREFIX} - Mail (submission)`, port: 587, protocol: 'TCP', action: 'allow', purpose: 'Sending email from your devices.' },
    { name: `${RULE_PREFIX} - Mail (secure submission)`, port: 465, protocol: 'TCP', action: 'allow', purpose: 'Sending email securely.' },
    { name: `${RULE_PREFIX} - Mail (IMAP)`, port: 993, protocol: 'TCP', action: 'allow', purpose: 'Reading email in Outlook.' },
    { name: `${RULE_PREFIX} - Mail (POP3)`, port: 995, protocol: 'TCP', action: 'allow', purpose: 'Reading email in clients that cannot use IMAP.' },
  ];
}

/** Builds the netsh arguments for a rule. Separated out so it can be tested. */
export function buildFirewallArgs(rule: FirewallRule): string[] {
  return [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    `name=${rule.name}`,
    'dir=in',
    `action=${rule.action}`,
    `protocol=${rule.protocol}`,
    `localport=${rule.port}`,
    // Block rules apply to everything remote; the loopback interface is not
    // affected, so the service still reaches itself. Allow rules may be
    // narrowed to the sources selected by the administrator.
    ...(rule.remoteIp || rule.action === 'block' ? [`remoteip=${rule.remoteIp ?? 'any'}`] : []),
    'profile=any',
    'enable=yes',
  ];
}

export function buildDeleteArgs(ruleName: string): string[] {
  return ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`];
}

export class FirewallManager {
  /** Removes any existing rule of the same name, then adds it. */
  async apply(rule: FirewallRule): Promise<void> {
    // netsh appends rather than replacing, so repeated installs would
    // otherwise pile up duplicates.
    await runCommand({ exe: 'netsh.exe', args: buildDeleteArgs(rule.name), timeoutMs: 30_000 });

    const result = await runCommand({
      exe: 'netsh.exe',
      args: buildFirewallArgs(rule),
      timeoutMs: 30_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Could not create the firewall rule "${rule.name}". ` +
          'Administrator rights are needed.',
      );
    }
  }

  async applyAll(rules: readonly FirewallRule[]): Promise<void> {
    for (const rule of rules) await this.apply(rule);
  }

  async remove(ruleName: string): Promise<void> {
    await runCommand({ exe: 'netsh.exe', args: buildDeleteArgs(ruleName), timeoutMs: 30_000 });
  }

  /** Removes every rule this panel created. Used by the uninstaller. */
  async removeAll(): Promise<void> {
    for (const rule of [...requiredFirewallRules(), ...mailFirewallRules()]) {
      await this.remove(rule.name);
    }
    for (const engine of DATABASE_FIREWALL_ENGINES) await this.remove(databaseFirewallRuleName(engine));
  }

  /** Lists the panel's rules that are currently present. */
  async listInstalled(): Promise<string[]> {
    const result = await runCommand({
      exe: 'netsh.exe',
      args: ['advfirewall', 'firewall', 'show', 'rule', `name=all`],
      timeoutMs: 30_000,
    });

    if (result.exitCode !== 0) return [];

    return result.stdout
      .split(/\r?\n/)
      .map((line) => /^Rule Name:\s*(.+)$/i.exec(line)?.[1]?.trim())
      .filter((name): name is string => Boolean(name?.startsWith(RULE_PREFIX)));
  }
}

/**
 * Creates the low-privilege account that builds and runs websites.
 *
 * Build steps execute whatever is in a project's package scripts, so they must
 * never run as the system account. This account can log on as a service and
 * write to the sites folder, and nothing else.
 */
export async function ensureBuildAccount(
  username: string,
  password: string,
  sitesRoot: string,
): Promise<void> {
  const exists = await runCommand({
    exe: 'net.exe',
    args: ['user', username],
    timeoutMs: 30_000,
  });

  if (exists.exitCode !== 0) {
    const created = await runCommand({
      exe: 'net.exe',
      args: ['user', username, password, '/add', '/comment:WinPanel website build account', '/expires:never'],
      timeoutMs: 60_000,
    });

    if (created.exitCode !== 0) {
      throw new Error('Could not create the account used to build websites.');
    }
  }

  // Deliberately not added to any group: membership in Users is enough to log
  // on as a service, and anything more would defeat the point.
  await runCommand({
    exe: 'wmic.exe',
    args: ['useraccount', 'where', `name='${username}'`, 'set', 'PasswordExpires=false'],
    timeoutMs: 30_000,
  });

  await fs.mkdir(sitesRoot, { recursive: true });

  // Grant the account control of the sites folder only.
  await runCommand({
    exe: 'icacls.exe',
    args: [sitesRoot, '/grant', `${username}:(OI)(CI)M`, '/T'],
    timeoutMs: 120_000,
  });
}

/** Locks the panel's own data folder down to administrators and the system. */
export async function secureDataFolder(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  // The vault key and the database live here. Inheritance is removed so a
  // permissive ACL higher up the tree cannot widen access.
  await runCommand({
    exe: 'icacls.exe',
    args: [dataDir, '/inheritance:r'],
    timeoutMs: 60_000,
  });

  for (const principal of ['SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F']) {
    await runCommand({
      exe: 'icacls.exe',
      args: [dataDir, '/grant', principal],
      timeoutMs: 60_000,
    });
  }
}

export function panelUrlFor(ipAddress: string, https: boolean): string {
  return `${https ? 'https' : 'http'}://${ipAddress}:${PANEL_PORT}`;
}

export { path };
