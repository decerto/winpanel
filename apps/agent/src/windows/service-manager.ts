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
 *
 * WinSW v2 cannot be told where its configuration lives. It reads
 * `<its own filename>.xml` from its own directory and nothing else — a config
 * path on the command line is accepted and silently ignored, and the service
 * it registers points at the wrapper with no arguments at all. So each
 * service gets its own copy of the wrapper, named after the service, with its
 * config beside it. Passing the config path instead produced a wrapper that
 * exited immediately looking for `WinSW.xml`, which meant the panel installed
 * successfully and then had no service to run it.
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

/** Summarises a failed command for a message a person has to act on. */
function describeFailure(result: { stderr: string; stdout: string }): string {
  const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(' ');
  return output.length > 0 ? output : 'No output was produced.';
}

/** Gives a just-started service a moment to fall over before it is trusted. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 3_000));
}

export class ServiceManager {
  constructor(
    private readonly winswPath: string,
    private readonly configDir: string,
  ) {}

  private configPathFor(id: string): string {
    return path.join(this.configDir, `${id}.xml`);
  }

  /** The per-service copy of the wrapper. Its name determines its config. */
  wrapperPathFor(id: string): string {
    return path.join(this.configDir, `${id}.exe`);
  }

  private async exists(target: string): Promise<boolean> {
    return await fs.access(target).then(
      () => true,
      () => false,
    );
  }

  /** Writes the config and registers the service. */
  async install(definition: ServiceDefinition): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.mkdir(definition.logPath, { recursive: true });

    const configPath = this.configPathFor(definition.id);
    const wrapperPath = this.wrapperPathFor(definition.id);

    try {
      await fs.copyFile(this.winswPath, wrapperPath);
    } catch (error) {
      throw new Error(
        `Could not place the service wrapper at ${wrapperPath}: ${(error as Error).message}`,
      );
    }

    // The file may hold a service account password, so restrict it before it
    // ever contains one.
    await fs.writeFile(configPath, buildServiceXml(definition), { mode: 0o600 });

    const result = await runCommand({
      exe: wrapperPath,
      args: ['install'],
      timeoutMs: 60_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Could not register the "${definition.displayName}" service. ` +
          describeFailure(result),
      );
    }
  }

  async uninstall(id: string): Promise<void> {
    const wrapperPath = this.wrapperPathFor(id);

    if (await this.exists(wrapperPath)) {
      await runCommand({ exe: wrapperPath, args: ['stop'], timeoutMs: 60_000 });
      await runCommand({ exe: wrapperPath, args: ['uninstall'], timeoutMs: 60_000 });
    }

    /*
     * The wrapper cannot remove a service it has lost its configuration for,
     * and it reports that as an unhandled exception rather than a failure.
     * Windows itself always can, so it gets the last word.
     */
    if ((await this.getState(id)) !== 'not-installed') {
      await runCommand({ exe: 'sc.exe', args: ['stop', id], timeoutMs: 60_000 });
      await runCommand({ exe: 'sc.exe', args: ['delete', id], timeoutMs: 60_000 });
    }

    /*
     * The configuration is deleted last, and only once the service is really
     * gone. Removing it while the service still exists strands it: the
     * wrapper then refuses to run at all, and the only way to remove the
     * service is by hand with sc.exe.
     */
    if ((await this.getState(id)) !== 'not-installed') {
      throw new Error(
        `The "${id}" service could not be removed. It may need administrator rights, or ` +
          'something may still be using it.',
      );
    }

    await fs.rm(this.configPathFor(id), { force: true });
    await fs.rm(wrapperPath, { force: true }).catch(() => undefined);
  }

  /**
   * Confirms the per-service wrapper is actually there.
   *
   * Without this, acting on a service that was never registered — because its
   * install failed halfway — surfaces as `spawn ...winpanel-x.exe ENOENT`,
   * which tells the user nothing about what to do next.
   */
  private async requireWrapper(id: string): Promise<string> {
    const wrapperPath = this.wrapperPathFor(id);

    if (!(await this.exists(wrapperPath))) {
      throw new Error(
        `The "${id}" service is not registered on this server, so it cannot be started or ` +
          'stopped. Install the program again to register it.',
      );
    }

    return wrapperPath;
  }

  async start(id: string): Promise<void> {
    const result = await runCommand({
      exe: await this.requireWrapper(id),
      args: ['start'],
      timeoutMs: 120_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Could not start the "${id}" service. ${describeFailure(result)}`);
    }

    /*
     * WinSW reports success once Windows has launched the process, which says
     * nothing about whether it survived. A service whose executable exits
     * immediately - a missing dependency, an unreadable config - looks
     * identical to a healthy start at this point, and the install would go on
     * to claim everything worked.
     */
    await settle();

    const state = await this.getState(id);
    if (state !== 'running' && state !== 'starting') {
      throw new Error(
        `The "${id}" service was registered but stopped immediately after starting. ` +
          'Its log in the logs folder says why.',
      );
    }
  }

  async stop(id: string): Promise<void> {
    await runCommand({
      exe: await this.requireWrapper(id),
      args: ['stop'],
      timeoutMs: 120_000,
    });
  }

  async restart(id: string): Promise<void> {
    await runCommand({
      exe: await this.requireWrapper(id),
      args: ['restart'],
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
