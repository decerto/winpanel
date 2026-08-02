import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../process/run-command.js';

/**
 * Windows service management via WinSW.
 *
 * WinSW v2.12.0 is the pinned version: v3 has only ever been a pre-release,
 * and Caddy's own documentation targets the v2 configuration format.
 *
 * Every supervised process on the box — the panel itself, Caddy, Stalwart, and
 * each hosted site — is registered the same way, so there is one mechanism to
 * understand and one place for start/stop/restart/logs to go wrong.
 */

export type ServiceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'not-installed';

export interface ServiceDefinition {
  /** Windows service id. Prefixed `winpanel-` so ours are identifiable. */
  id: string;
  /** Name shown in services.msc. */
  displayName: string;
  description: string;
  executable: string;
  args?: readonly string[];
  workingDirectory?: string;
  env?: Readonly<Record<string, string>>;
  /** Where rotating logs are written. */
  logPath: string;
  /** Account the service runs as. Omit for LocalSystem. */
  account?: { username: string; password: string };
}

/** Escapes text for inclusion in an XML text node or attribute. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds the WinSW configuration file.
 *
 * Note the restart policy: sites are expected to crash occasionally, and a
 * process that stays down after one bad request would turn a transient error
 * into an outage. The reset period stops a genuinely broken app from
 * restarting forever in a tight loop.
 */
export function buildServiceXml(definition: ServiceDefinition): string {
  const lines: string[] = [
    '<service>',
    `  <id>${escapeXml(definition.id)}</id>`,
    `  <name>${escapeXml(definition.displayName)}</name>`,
    `  <description>${escapeXml(definition.description)}</description>`,
    `  <executable>${escapeXml(definition.executable)}</executable>`,
  ];

  if (definition.args && definition.args.length > 0) {
    for (const arg of definition.args) {
      lines.push(`  <argument>${escapeXml(arg)}</argument>`);
    }
  }

  if (definition.workingDirectory) {
    lines.push(`  <workingdirectory>${escapeXml(definition.workingDirectory)}</workingdirectory>`);
  }

  for (const [key, value] of Object.entries(definition.env ?? {})) {
    lines.push(`  <env name="${escapeXml(key)}" value="${escapeXml(value)}"/>`);
  }

  if (definition.account) {
    lines.push('  <serviceaccount>');
    lines.push(`    <username>${escapeXml(definition.account.username)}</username>`);
    lines.push(`    <password>${escapeXml(definition.account.password)}</password>`);
    lines.push('    <allowservicelogon>true</allowservicelogon>');
    lines.push('  </serviceaccount>');
  }

  lines.push('  <startmode>Automatic</startmode>');
  lines.push('  <onfailure action="restart" delay="5 sec"/>');
  lines.push('  <onfailure action="restart" delay="15 sec"/>');
  lines.push('  <onfailure action="restart" delay="60 sec"/>');
  lines.push('  <resetfailure>1 hour</resetfailure>');
  lines.push(`  <logpath>${escapeXml(definition.logPath)}</logpath>`);
  lines.push('  <log mode="roll-by-size-time">');
  lines.push('    <sizeThreshold>10240</sizeThreshold>');
  lines.push('    <pattern>yyyyMMdd</pattern>');
  lines.push('    <autoRollAtTime>00:00:00</autoRollAtTime>');
  lines.push('    <keepFiles>14</keepFiles>');
  lines.push('  </log>');
  lines.push('</service>');

  return `<?xml version="1.0" encoding="UTF-8"?>\n${lines.join('\n')}\n`;
}

export class ServiceManager {
  constructor(
    private readonly winswPath: string,
    private readonly configDir: string,
  ) {}

  private configPathFor(id: string): string {
    return path.join(this.configDir, `${id}.xml`);
  }

  /** Writes the config and registers the service. */
  async install(definition: ServiceDefinition): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.mkdir(definition.logPath, { recursive: true });

    const configPath = this.configPathFor(definition.id);
    // The file may hold a service account password, so restrict it before it
    // ever contains one.
    await fs.writeFile(configPath, buildServiceXml(definition), { mode: 0o600 });

    await runCommand({
      exe: this.winswPath,
      args: ['install', configPath],
      timeoutMs: 60_000,
    });
  }

  async uninstall(id: string): Promise<void> {
    const configPath = this.configPathFor(id);
    await runCommand({ exe: this.winswPath, args: ['stop', configPath], timeoutMs: 60_000 });
    await runCommand({ exe: this.winswPath, args: ['uninstall', configPath], timeoutMs: 60_000 });
    await fs.rm(configPath, { force: true });
  }

  async start(id: string): Promise<void> {
    await runCommand({
      exe: this.winswPath,
      args: ['start', this.configPathFor(id)],
      timeoutMs: 120_000,
    });
  }

  async stop(id: string): Promise<void> {
    await runCommand({
      exe: this.winswPath,
      args: ['stop', this.configPathFor(id)],
      timeoutMs: 120_000,
    });
  }

  async restart(id: string): Promise<void> {
    await runCommand({
      exe: this.winswPath,
      args: ['restart', this.configPathFor(id)],
      timeoutMs: 120_000,
    });
  }

  /**
   * Queries service state through sc.exe rather than WinSW, because it works
   * even when the WinSW config file is missing or damaged.
   */
  async getState(id: string): Promise<ServiceState> {
    const result = await runCommand({
      exe: 'sc.exe',
      args: ['query', id],
      timeoutMs: 15_000,
    });

    if (result.exitCode !== 0) return 'not-installed';

    const output = result.stdout.toUpperCase();
    if (output.includes('START_PENDING')) return 'starting';
    if (output.includes('STOP_PENDING')) return 'stopping';
    if (output.includes('RUNNING')) return 'running';
    if (output.includes('STOPPED')) return 'stopped';
    return 'not-installed';
  }

  async isInstalled(id: string): Promise<boolean> {
    return (await this.getState(id)) !== 'not-installed';
  }
}
