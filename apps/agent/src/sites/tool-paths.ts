import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

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
 */
export async function resolveTool(command: string, nodeVersion?: string): Promise<string> {
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
