import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../process/run-command.js';

/**
 * Which versions of Node this server has.
 *
 * The panel never installs Node. On a managed server that is the hosting
 * provider's job, and a control panel quietly adding a second copy of a
 * runtime is how you end up with a site running on something nobody chose.
 * So this finds what is already here and lets a website pick from it.
 *
 * Discovery covers the places Node actually ends up on Windows: the panel's
 * own folder, the standard installer location, and the two version managers
 * that are common enough to matter.
 */

export interface NodeInstallation {
  /** As reported by `node --version`, without the leading `v`. */
  version: string;
  /** Directory holding node.exe, which is also where npm and npx live. */
  directory: string;
  /** Where it came from, so the panel can explain what it is offering. */
  source: 'panel' | 'system' | 'version-manager';
}

const CACHE_MS = 60_000;
let cache: { at: number; installations: NodeInstallation[] } | null = null;

async function exists(candidate: string): Promise<boolean> {
  return await fs.access(candidate).then(
    () => true,
    () => false,
  );
}

async function subdirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** Asks the binary what it is, rather than trusting the folder name. */
async function versionOf(directory: string): Promise<string | null> {
  const executable = path.join(directory, 'node.exe');
  if (!(await exists(executable))) return null;

  const result = await runCommand({ exe: executable, args: ['--version'], timeoutMs: 15_000 });
  if (result.exitCode !== 0) return null;

  const match = /v?(\d+\.\d+\.\d+)/.exec(result.stdout.trim());
  return match?.[1] ?? null;
}

async function candidateDirectories(binDir: string): Promise<Array<[string, NodeInstallation['source']]>> {
  const candidates: Array<[string, NodeInstallation['source']]> = [];

  // Anything the panel's own folder holds.
  candidates.push([path.join(binDir, 'node'), 'panel']);
  for (const dir of await subdirectories(path.join(binDir, 'node'))) {
    candidates.push([dir, 'panel']);
  }

  // The standard Windows installer.
  for (const programFiles of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (programFiles) candidates.push([path.join(programFiles, 'nodejs'), 'system']);
  }

  const appData = process.env['APPDATA'];
  if (appData) {
    // nvm-windows keeps each version in its own vN.N.N folder.
    for (const dir of await subdirectories(path.join(appData, 'nvm'))) {
      candidates.push([dir, 'version-manager']);
    }
    // fnm buries the binary one level deeper.
    for (const dir of await subdirectories(path.join(appData, 'fnm', 'node-versions'))) {
      candidates.push([path.join(dir, 'installation'), 'version-manager']);
    }
  }

  return candidates;
}

/** Whatever `node` resolves to on PATH, which may be none of the above. */
async function onPath(): Promise<string | null> {
  const result = await runCommand({ exe: 'where.exe', args: ['node.exe'], timeoutMs: 15_000 });
  if (result.exitCode !== 0) return null;

  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().endsWith('node.exe'));
  return first ? path.dirname(first.trim()) : null;
}

export async function discoverNodeVersions(binDir: string): Promise<NodeInstallation[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.installations;

  const candidates = await candidateDirectories(binDir);

  const fromPath = await onPath();
  if (fromPath) candidates.push([fromPath, 'system']);

  const seen = new Set<string>();
  const installations: NodeInstallation[] = [];

  for (const [directory, source] of candidates) {
    const key = directory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = await versionOf(directory);
    if (!version) continue;

    // The same version installed twice is one choice, not two.
    if (installations.some((installation) => installation.version === version)) continue;

    installations.push({ version, directory, source });
  }

  installations.sort((a, b) => compareVersions(b.version, a.version));
  cache = { at: Date.now(), installations };
  return installations;
}

/** Newest first, comparing numerically so 9 does not sort above 22. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Finds the installation a site asked for.
 *
 * A site may pin `22` rather than `22.14.0`, because pinning a patch release
 * means a site stops building the day the server is updated.
 */
export function matchVersion(
  installations: readonly NodeInstallation[],
  requested: string,
): NodeInstallation | null {
  const wanted = requested.replace(/^v/, '').trim();
  if (wanted.length === 0) return null;

  return (
    installations.find((installation) => installation.version === wanted) ??
    installations.find(
      (installation) =>
        installation.version.startsWith(`${wanted}.`) || installation.version === wanted,
    ) ??
    null
  );
}

/** Drops the cache so a newly installed runtime is seen straight away. */
export function forgetNodeVersions(): void {
  cache = null;
}
