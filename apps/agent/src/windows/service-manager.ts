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

/**
 * Reads a service's state out of `sc.exe query` output.
 *
 * The numeric code is used rather than the word beside it, for two reasons:
 * the word is a translated string on a server installed in another language,
 * and searching the whole output for "RUNNING" matches the service's own name
 * as readily as its state — a website whose slug contains "running" reported
 * itself as running whatever it was actually doing.
 */
export function readServiceState(output: string): ServiceState {
  const match = /^\s*STATE\s*:\s*(\d+)/m.exec(output);

  switch (match?.[1]) {
    case '1':
      return 'stopped';
    case '2':
      return 'starting';
    case '3':
      return 'stopping';
    case '4':
      return 'running';
    default:
      return 'not-installed';
  }
}

/**
 * Waits for a deleted service to actually disappear.
 *
 * `sc delete` only marks a service for deletion. Windows keeps it in
 * DELETE_PENDING until every open handle to it is closed — a services.msc
 * window, Task Manager's Services tab, or the process that has just exited —
 * and `sc query` goes on reporting it as stopped throughout. Checking once
 * straight after deleting therefore fails on a service that is on its way out.
 */
export async function waitUntilGone(
  probe: () => Promise<ServiceState>,
  timeoutMs = 20_000,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if ((await probe()) === 'not-installed') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

/**
 * Rewrites the `<env>` entries in an existing service configuration.
 *
 * Kept as a pure function so the rewrite can be tested without a real service.
 * The elements are replaced wholesale rather than merged: the caller passes
 * the complete environment, so a variable that has been removed actually goes
 * away instead of lingering from a previous install.
 */
export function replaceEnvironmentInXml(
  xml: string,
  env: Readonly<Record<string, string>>,
): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const lines = xml.split(/\r?\n/).filter((line) => !/^\s*<env\s+name=/.test(line));

  const envLines = Object.entries(env).map(
    ([key, value]) => `  <env name="${escapeXml(key)}" value="${escapeXml(value)}"/>`,
  );

  // Before <startmode>, which is where install() puts them, so a rewritten
  // file is byte-identical to a freshly installed one.
  let at = lines.findIndex((line) => line.includes('<startmode>'));
  if (at === -1) at = lines.findIndex((line) => line.includes('</service>'));
  if (at === -1) at = lines.length;

  lines.splice(at, 0, ...envLines);
  return lines.join(eol);
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

/** Lines that are part of a crash dump's furniture rather than its reason. */
const CRASH_NOISE = [
  /^at\s/,
  /^\^+$/,
  /^[}\])],?$/,
  /^Node\.js v/,
  /^Require stack:/,
  /^-\s/,
  /^throw\s/,
  /^\s*\w+:\s*'[^']*',?$/,
];

/**
 * The one line out of a crash log that says why the program stopped.
 *
 * Taking the last line looks obvious and is wrong: Node prints its own version
 * banner after the stack trace, so "Node.js v24.18.1" is what a user was being
 * shown instead of "Cannot find module". The line that names an error is the
 * answer, wherever in the dump it appears.
 */
export function describeCrashLog(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('{'))
    .filter((line) => !CRASH_NOISE.some((pattern) => pattern.test(line)));

  const named = lines.find((line) => /^[\w.$]*(Error|Exception)\b/.test(line));
  const chosen = named ?? lines.at(-1);

  return chosen ? chosen.slice(0, 300) : null;
}

/**
 * How a service is rescued from its own leftovers.
 *
 * Supplied by the caller rather than worked out here: which ports a website
 * owns is only recorded in the panel's database, and a service manager that
 * had to open a database to stop a service would be the wrong shape entirely.
 */
export interface ServiceRecovery {
  /**
   * Ends any of the service's own processes still holding its ports.
   * Reports whether anything was actually ended, so a start that failed for
   * some other reason is not retried pointlessly.
   */
  unblock: (id: string) => Promise<boolean>;
  /** Names whatever else is on those ports, for an error a user can act on. */
  describeBlockers: (id: string) => Promise<string | null>;
}

export class ServiceManager {
  constructor(
    private readonly winswPath: string,
    private readonly configDir: string,
    private readonly recovery?: ServiceRecovery,
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

  /**
   * Changes a registered service's environment variables and restarts it.
   *
   * Only the configuration file is touched. The Windows service registration
   * points at the wrapper with no arguments, and the wrapper reads this file
   * afresh every time it starts — so there is no need to unregister and
   * re-register, which is the step most likely to leave a machine with no
   * service at all if it fails halfway.
   *
   * The file can hold a secret, and does for Caddy's DNS token. That is
   * acceptable only because this folder is the panel's data directory, which
   * `secureDataFolder` strips of inheritance and grants to SYSTEM and
   * Administrators alone — the same protection the vault key gets.
   *
   * `unchanged` is reported rather than rewriting anyway, so callers can run
   * this on every start without restarting a healthy service each time.
   */
  async setEnvironment(
    id: string,
    env: Readonly<Record<string, string>>,
  ): Promise<'not-installed' | 'unchanged' | 'updated'> {
    const configPath = this.configPathFor(id);

    let current: string;
    try {
      current = await fs.readFile(configPath, 'utf8');
    } catch {
      // No configuration means nothing to reconfigure. Its environment will
      // be set when it is installed.
      return 'not-installed';
    }

    const next = replaceEnvironmentInXml(current, env);
    if (next === current) return 'unchanged';

    await fs.writeFile(configPath, next, { mode: 0o600 });

    // Only if it is up: starting a service the user has deliberately stopped
    // would be an odd thing for a settings change to do.
    if ((await this.getState(id)) === 'running') await this.restart(id);

    return 'updated';
  }

  /**
   * Rewrites a registered service's configuration in place.
   *
   * Same reasoning as `setEnvironment`: the Windows registration points at the
   * wrapper with no arguments and the wrapper re-reads this file every time it
   * starts, so a corrected executable or argument list takes effect without an
   * unregister/re-register cycle. This is what lets a reinstall repair a
   * server whose launch arguments were wrong when it was first set up.
   */
  async reconfigure(
    definition: ServiceDefinition,
  ): Promise<'not-installed' | 'unchanged' | 'updated'> {
    const configPath = this.configPathFor(definition.id);

    const current = await fs.readFile(configPath, 'utf8').catch(() => null);
    if (current === null) return 'not-installed';

    const next = buildServiceXml(definition);
    if (next === current) return 'unchanged';

    await fs.mkdir(definition.logPath, { recursive: true });
    await fs.writeFile(configPath, next, { mode: 0o600 });

    if ((await this.getState(definition.id)) === 'running') await this.restart(definition.id);

    return 'updated';
  }

  async uninstall(id: string): Promise<void> {
    const wrapperPath = this.wrapperPathFor(id);

    if (await this.exists(wrapperPath)) {
      await runCommand({ exe: wrapperPath, args: ['stop'], timeoutMs: 60_000 });
      // A leftover process holds the service's files as well as its port, and
      // Windows will not let go of a service whose program is still running.
      await this.recovery?.unblock(id).catch(() => false);
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
    if (!(await waitUntilGone(() => this.getState(id)))) {
      throw new Error(
        (await this.getState(id)) === 'running'
          ? `The "${id}" service would not stop, so it could not be removed. End its process ` +
            'in Task Manager, then try again.'
          : `The "${id}" service was deleted but Windows is still holding it open. Close ` +
            'services.msc and the Services tab of Task Manager if either is open, then try ' +
            'again. Restarting the server always clears it.',
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

  /**
   * Starts a service and proves it is still there afterwards.
   *
   * The second attempt is the point of the shape. By far the commonest reason
   * a service starts and dies a second later is that its own last process is
   * still holding the port, and pressing Start again will never fix that
   * however many times it is pressed. Clearing it is only tried after a real
   * failure, so a service that is down for any other reason is never answered
   * by killing something.
   */
  async start(id: string): Promise<void> {
    let failure = await this.startOnce(id);
    if (!failure) return;

    if (await this.recovery?.unblock(id).catch(() => false)) {
      failure = await this.startOnce(id);
      if (!failure) return;
    }

    // Anything still on the port now is a program the panel has no business
    // ending, and naming it is the difference between a user who can fix this
    // and one who reads "check the log" and gives up.
    const blockers = await this.recovery?.describeBlockers(id).catch(() => null);

    throw new Error(
      blockers
        ? `The "${id}" service cannot start: ${blockers} is already using a port it needs, ` +
          'and that program is not the panel\u2019s to end. Close it, then try again.'
        : failure,
    );
  }

  /** One attempt. `null` when it started, otherwise why it did not. */
  private async startOnce(id: string): Promise<string | null> {
    const result = await runCommand({
      exe: await this.requireWrapper(id),
      args: ['start'],
      timeoutMs: 120_000,
    });

    if (result.exitCode !== 0) {
      return `Could not start the "${id}" service. ${describeFailure(result)}`;
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
    if (state === 'running' || state === 'starting') return null;

    const reason = await this.lastLogError(id);
    return (
      `The "${id}" service was registered but stopped immediately after starting. ` +
      (reason ? `It reported: ${reason}` : 'Its log in the logs folder says why.')
    );
  }

  /**
   * The reason a service gave for dying, out of its error log.
   *
   * Worth the trouble because the alternative is telling somebody their web
   * server "stopped immediately" and leaving them to find a log folder they
   * have never opened. Structured lines are skipped: a program that dies says
   * why in a sentence, and the JSON around it is the healthy part of the run.
   */
  private async lastLogError(id: string): Promise<string | null> {
    const xml = await fs.readFile(this.configPathFor(id), 'utf8').catch(() => '');
    const logPath = /<logpath>([^<]*)<\/logpath>/.exec(xml)?.[1];
    if (!logPath) return null;

    const handle = await fs.open(path.join(logPath, `${id}.err.log`), 'r').catch(() => null);
    if (!handle) return null;

    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 8_192);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);

      return describeCrashLog(buffer.toString('utf8'));
    } finally {
      await handle.close();
    }
  }

  /**
   * Stops a service, and makes sure that means what the user thinks it means.
   *
   * A wrapper that exits without taking its child with it leaves the program
   * running: still serving requests, still holding its port, still holding its
   * files open, while Windows reports the service as stopped. Somebody who
   * pressed Stop to take an app down has every right to expect it to be down,
   * and this is also the state that makes an update fail on a file nothing
   * appears to be using.
   */
  async stop(id: string): Promise<void> {
    await runCommand({
      exe: await this.requireWrapper(id),
      args: ['stop'],
      timeoutMs: 120_000,
    });

    await this.recovery?.unblock(id).catch(() => false);
  }

  /**
   * Stops and starts, rather than asking the wrapper to restart itself.
   *
   * WinSW's own restart hands the port straight back to whatever is holding
   * it, which if the last process was orphaned is the orphan — so the restart
   * appears to work, the service is stopped again seconds later, and the site
   * goes on being served by the code it was running before. Going through
   * `stop` and `start` clears the port in between and proves the result.
   */
  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
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

    return readServiceState(result.stdout);
  }

  async isInstalled(id: string): Promise<boolean> {
    return (await this.getState(id)) !== 'not-installed';
  }
}
