import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { findExecutable } from '../components/archive.js';
import { runCommand } from '../process/run-command.js';
import { discoverNodeVersions, matchVersion } from './node-versions.js';

/**
 * Finds the executables a build step is allowed to run.
 *
 * The manifest names a tool (`npm`, `pnpm`, `node`, …) but never a path. This
 * module turns that name into an absolute path, which means a repository can
 * never point the panel at an arbitrary binary — the worst it can do is ask
 * for a tool that is not installed.
 *
 * Bundled copies are preferred over anything on PATH, so a deployment does not
 * change behaviour because someone installed something else on the server.
 */

export class ToolNotFoundError extends Error {
  constructor(tool: string) {
    super(
      `${tool} is not installed on this server. Install it from the Components list on the ` +
        'Settings page and try again.',
    );
    this.name = 'ToolNotFoundError';
  }
}

/**
 * Windows will not start a `.cmd` without a shell, and the executor never
 * uses one. Reaching here means the shim was found but the program behind it
 * was not, which is a different problem from the tool being absent.
 */
export class ToolNotRunnableError extends Error {
  constructor(tool: string, shim: string) {
    super(
      `${tool} is installed on this server as a Windows shortcut (${path.basename(shim)}) ` +
        'that cannot be started safely, and the program behind it could not be found. ' +
        `Install ${tool} from the Components list on the Settings page, which installs a ` +
        'version the panel can run.',
    );
    this.name = 'ToolNotRunnableError';
  }
}

export class NodeVersionNotFoundError extends Error {
  constructor(version: string) {
    super(
      `This website is set to build with Node ${version}, which is not installed on this ` +
        'server. Pick one of the installed versions in the website\u2019s settings, or ask ' +
        'your hosting provider to add it.',
    );
    this.name = 'NodeVersionNotFoundError';
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Directory holding a specific Node version, or the default one. */
function nodeDirFor(version?: string): string {
  return version
    ? path.join(config.binDir, 'node', version)
    : path.join(config.binDir, 'node', 'current');
}

/**
 * Where Windows would find a tool if it were typed at a prompt.
 *
 * The last resort, and worth having: a package manager installed globally by
 * npm lands in the user profile, which no fixed list can predict. Only `.exe`,
 * `.cmd` and `.bat` are considered, because those are the only things
 * `resolveToolInvocation` knows how to turn into something startable.
 */
async function findOnPath(command: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const result = await runCommand({
    exe: 'where.exe',
    args: [command],
    timeoutMs: 15_000,
  }).catch(() => null);

  if (!result || result.exitCode !== 0) return null;

  const found = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.(exe|cmd|bat)$/i.test(line));

  // An .exe never needs unwrapping, so prefer one if the name resolves to both.
  return found.find((line) => /\.exe$/i.test(line)) ?? found[0] ?? null;
}

/**
 * Resolves a tool name to an absolute path.
 *
 * `nodeVersion` selects the Node installation used for the whole build, so a
 * site pinned to an older version gets that version's npm as well as its node.
 * The version is looked up among the ones actually present rather than assumed
 * to sit in a folder named after it — the panel does not install Node, so the
 * layout is whoever installed it's choice, not ours.
 */
export async function resolveTool(command: string, nodeVersion?: string): Promise<string> {
  if (nodeVersion && ['node', 'npm', 'npx'].includes(command)) {
    const installed = await discoverNodeVersions(config.binDir);
    const match = matchVersion(installed, nodeVersion);

    if (!match) throw new NodeVersionNotFoundError(nodeVersion);

    const file = command === 'node' ? 'node.exe' : `${command}.cmd`;
    const candidate = path.join(match.directory, file);
    if (await exists(candidate)) return candidate;
  }

  const nodeDir = nodeDirFor(nodeVersion);

  const candidates: Record<string, string[]> = {
    node: [path.join(nodeDir, 'node.exe'), path.join(config.binDir, 'node', 'node.exe')],
    npm: [path.join(nodeDir, 'npm.cmd'), path.join(config.binDir, 'node', 'npm.cmd')],
    npx: [path.join(nodeDir, 'npx.cmd'), path.join(config.binDir, 'node', 'npx.cmd')],
    pnpm: [
      path.join(config.binDir, 'pnpm', 'pnpm.exe'),
      path.join(nodeDir, 'pnpm.cmd'),
    ],
    yarn: [path.join(config.binDir, 'yarn', 'yarn.js'), path.join(nodeDir, 'yarn.cmd')],
    bun: [path.join(config.binDir, 'bun', 'bun.exe')],
    dotnet: [
      path.join(config.binDir, 'dotnet', 'dotnet.exe'),
      'C:\\Program Files\\dotnet\\dotnet.exe',
    ],
    // PHP itself, resolved the same way as the other downloaded runtimes.
    php: [path.join(config.binDir, 'php', 'php.exe')],
    // Composer is a PHP archive, not a program; it is run through PHP.
    composer: [path.join(config.binDir, 'composer', 'composer.phar')],
  };

  const options = candidates[command];
  if (!options) {
    // The manifest schema already restricts this to an allowlist, so reaching
    // here means the allowlist and this map have drifted apart.
    throw new ToolNotFoundError(command);
  }

  for (const candidate of options) {
    if (await exists(candidate)) return candidate;
  }

  /*
   * A downloaded component is unpacked as whatever shape its publisher chose,
   * and that shape changes between releases — pnpm moved from a bare .exe to
   * an archive with the program one level down. Looking for the executable
   * beats assuming where it landed.
   */
  const unpacked = await findExecutable(path.join(config.binDir, command), [`${command}.exe`]);
  if (unpacked) return unpacked;

  const onPath = await findOnPath(command);
  if (onPath) return onPath;

  // The agent is itself a Node process, so there is always a node to use.
  if (command === 'node') return process.execPath;

  throw new ToolNotFoundError(command);
}

/** How to actually launch a tool: an executable plus the arguments it needs first. */
export interface ToolInvocation {
  exe: string;
  args: string[];
}

/**
 * The JavaScript behind each package manager's Windows shim.
 *
 * Relative to the folder holding the shim, which is how Node lays them out.
 */
const CLI_SCRIPTS: Record<string, string[]> = {
  npm: ['node_modules/npm/bin/npm-cli.js'],
  npx: ['node_modules/npm/bin/npx-cli.js'],
  yarn: ['node_modules/yarn/bin/yarn.js'],
  pnpm: ['node_modules/pnpm/bin/pnpm.cjs'],
};

async function cliScriptBeside(directory: string, command: string): Promise<string | null> {
  for (const relative of CLI_SCRIPTS[command] ?? []) {
    const candidate = path.join(directory, ...relative.split('/'));
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Reads the JavaScript path out of a `.cmd` shim.
 *
 * The shims npm writes all end in a line that runs node against a script under
 * the shim's own folder, referred to as `%~dp0` or `%dp0%`. Extracting it
 * covers package managers whose layout is not in the table above, and future
 * ones that change it, without having to guess.
 */
export function scriptFromShim(contents: string): string | null {
  const matches = contents.matchAll(/%~?dp0%?[\\/]([^"'\r\n]+?\.(?:cjs|mjs|js))/gi);

  for (const match of matches) {
    const relative = match[1];
    // `node.exe` beside the shim is the interpreter, not the program.
    if (relative && !/(^|[\\/])node\.(cjs|mjs|js)$/i.test(relative)) return relative;
  }

  return null;
}

async function scriptFromShimFile(shim: string): Promise<string | null> {
  const contents = await fs.readFile(shim, 'utf8').catch(() => null);
  if (contents === null) return null;

  const relative = scriptFromShim(contents);
  if (!relative) return null;

  const resolved = path.resolve(path.dirname(shim), relative);
  return (await exists(resolved)) ? resolved : null;
}

/**
 * Turns a tool name into something Windows will actually start.
 *
 * `npm` and friends are `.cmd` shims, and since Node 20.12 spawning a `.cmd`
 * without a shell fails outright with `EINVAL`. Turning the shell back on is
 * not an option — every build argument would then be re-parsed by cmd.exe,
 * which is precisely the injection surface `runCommand` exists to remove. So
 * the shim is skipped and the JavaScript behind it is run with `node` instead,
 * which is what the shim would have done anyway.
 *
 * If that JavaScript cannot be found, this fails here with an explanation.
 * Handing the shim back would fail later as a bare `spawn EINVAL` in the
 * middle of a deployment, which tells the user nothing at all.
 */
export async function resolveToolInvocation(
  command: string,
  nodeVersion?: string,
): Promise<ToolInvocation> {
  const direct = await resolveTool(command, nodeVersion);

  // Yarn 1 is published as one JavaScript file, so there is nothing to unwrap.
  if (/\.(c|m)?js$/i.test(direct)) {
    return { exe: await resolveTool('node', nodeVersion), args: [direct] };
  }

  // Composer is a PHP archive, run through the PHP the panel installed. The
  // same trick as the JavaScript shims: the interpreter leads, the file follows.
  if (/\.phar$/i.test(direct)) {
    return { exe: await resolveTool('php'), args: [direct] };
  }

  if (!/\.(cmd|bat)$/i.test(direct)) return { exe: direct, args: [] };

  const node = await resolveTool('node', nodeVersion);

  const script =
    (await cliScriptBeside(path.dirname(direct), command)) ??
    (await scriptFromShimFile(direct)) ??
    // Some shims are only a wrapper around a copy that lives beside the Node
    // running this agent.
    (await cliScriptBeside(path.dirname(process.execPath), command));

  if (!script) throw new ToolNotRunnableError(command, direct);

  return { exe: node, args: [script] };
}
