import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
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
      `${tool} is not installed on this server. Install it from the Components page ` +
        'and try again.',
    );
    this.name = 'ToolNotFoundError';
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
      path.join(nodeDir, 'pnpm.cmd'),
      path.join(config.binDir, 'pnpm', 'pnpm.exe'),
    ],
    yarn: [path.join(nodeDir, 'yarn.cmd')],
    bun: [path.join(config.binDir, 'bun', 'bun.exe')],
    dotnet: [
      path.join(config.binDir, 'dotnet', 'dotnet.exe'),
      'C:\\Program Files\\dotnet\\dotnet.exe',
    ],
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

  // During development the bundled copies do not exist; fall back to whatever
  // is on PATH so the pipeline can be exercised locally.
  if (process.env['NODE_ENV'] !== 'production') {
    if (command === 'node') return process.execPath;
    return process.platform === 'win32' ? `${command}.cmd` : command;
  }

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
 * Turns a tool name into something Windows will actually start.
 *
 * `npm` and friends are `.cmd` shims, and since Node 20.12 spawning a `.cmd`
 * without a shell fails outright with `EINVAL`. Turning the shell back on is
 * not an option — every build argument would then be re-parsed by cmd.exe,
 * which is precisely the injection surface `runCommand` exists to remove. So
 * the shim is skipped and the JavaScript behind it is run with `node` instead,
 * which is what the shim would have done anyway.
 */
export async function resolveToolInvocation(
  command: string,
  nodeVersion?: string,
): Promise<ToolInvocation> {
  const direct = await resolveTool(command, nodeVersion);
  if (!/\.(cmd|bat)$/i.test(direct)) return { exe: direct, args: [] };

  const node = await resolveTool('node', nodeVersion);

  const script =
    (await cliScriptBeside(path.dirname(direct), command)) ??
    // The development fallback returns a bare `npm.cmd`, so look beside the
    // Node that is running this agent instead.
    (await cliScriptBeside(path.dirname(process.execPath), command));

  return script ? { exe: node, args: [script] } : { exe: direct, args: [] };
}
