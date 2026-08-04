import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Read-only browsing of the server's own filesystem.
 *
 * Every other file operation in the panel is contained inside a website's
 * folder, deliberately. This one is not, and exists for one reason: the panel
 * asks for a path on the server in a few places — an installer to update from
 * being the first — and expecting somebody to type
 * `C:\Users\Administrator\Downloads\WinPanel-Setup-x64.exe` correctly, from
 * memory, into a text box is how a feature goes unused.
 *
 * What it deliberately does not do is read anything. It lists names, sizes and
 * dates; there is no way to get a file's contents through here, so the worst
 * it can tell a signed-in administrator is what the machine they administer is
 * called on disk.
 */

export class BrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowseError';
  }
}

export interface BrowseEntry {
  name: string;
  /** Absolute path, so the caller never has to join anything itself. */
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: Date;
}

export interface BrowseResult {
  /** The folder being listed. Null means the list of drives. */
  path: string | null;
  /** The folder above this one, or null at the top. */
  parent: string | null;
  /** Every drive the machine has, so the browser has somewhere to start. */
  drives: string[];
  entries: BrowseEntry[];
  /** Set when the caller asked for a file: the browser can preselect it. */
  selected: string | null;
  /** True when the folder held more than could sensibly be sent. */
  truncated: boolean;
}

/** Enough for any real folder; a cap so a runaway one cannot be sent at all. */
const MAX_ENTRIES = 1000;

/**
 * Rejects paths that are not a plain absolute path on this machine.
 *
 * A UNC path is refused because reading one makes Windows authenticate
 * outbound to whatever host is named, which turns a file browser into a way to
 * make the server hand its machine credentials to somebody else's server.
 */
export function validateBrowsePath(
  candidate: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = candidate.trim();

  if (trimmed.length === 0) return { ok: false, reason: 'Enter a folder to look in.' };
  if (trimmed.includes('\u0000')) return { ok: false, reason: 'That is not a valid path.' };

  if (/^[\\/]{2}/.test(trimmed)) {
    return {
      ok: false,
      reason: 'Network paths cannot be browsed from here. Copy the file onto this server first.',
    };
  }

  const resolved = path.resolve(trimmed);

  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(resolved)) {
    return { ok: false, reason: 'That is not a valid path.' };
  }
  if (!path.isAbsolute(resolved)) {
    return { ok: false, reason: 'Use the full path, starting at the drive.' };
  }

  return { ok: true, path: resolved };
}

/** Every drive letter that answers. Nonexistent ones fail immediately. */
export async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      return (await fs.access(root).then(
        () => true,
        () => false,
      ))
        ? root
        : null;
    }),
  );

  return found.filter((drive): drive is string => drive !== null);
}

function explain(error: unknown, target: string): BrowseError {
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ENOENT') return new BrowseError(`There is nothing at ${target} on this server.`);
  if (code === 'ENOTDIR') return new BrowseError(`${target} is a file, not a folder.`);
  if (code === 'EACCES' || code === 'EPERM') {
    return new BrowseError(`Windows would not let the panel read ${target}.`);
  }
  if (code === 'ENOTREADY' || code === 'EUNATCH') {
    return new BrowseError('That drive has nothing in it.');
  }

  return new BrowseError(`${target} could not be read.`);
}

/** The parent of a folder, or null when it is already a drive root. */
function parentOf(target: string): string | null {
  const parent = path.dirname(target);
  return parent === target ? null : parent;
}

export interface BrowseOptions {
  /** Lower-case, with the dot. When set, other files are left out. */
  extensions?: readonly string[];
}

/**
 * Lists a folder, or the drives when given nothing.
 *
 * Being handed a *file* lists the folder it is in and reports it as selected,
 * so reopening the browser on a value someone chose earlier lands where they
 * left it rather than at the top.
 */
export async function browseDirectory(
  target: string | null,
  options: BrowseOptions = {},
): Promise<BrowseResult> {
  const drives = await listDrives();

  if (target === null) {
    return { path: null, parent: null, drives, entries: [], selected: null, truncated: false };
  }

  const check = validateBrowsePath(target);
  if (!check.ok) throw new BrowseError(check.reason);

  let directory = check.path;
  let selected: string | null = null;

  const stats = await fs.stat(directory).catch((error: unknown) => {
    throw explain(error, directory);
  });

  if (!stats.isDirectory()) {
    selected = directory;
    directory = path.dirname(directory);
  }

  const found = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    throw explain(error, directory);
  });

  const wanted = options.extensions?.map((extension) => extension.toLowerCase());
  const entries: BrowseEntry[] = [];
  let truncated = false;

  for (const entry of found) {
    const isDirectory = entry.isDirectory();

    if (!isDirectory && wanted && !wanted.includes(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }

    const full = path.join(directory, entry.name);

    // A file being renamed or removed underneath us is not a reason to fail
    // the whole listing, and neither is one Windows will not describe.
    const info = await fs.stat(full).catch(() => null);
    if (!info) continue;

    entries.push({
      name: entry.name,
      path: full,
      kind: isDirectory ? 'directory' : 'file',
      sizeBytes: isDirectory ? 0 : info.size,
      modifiedAt: info.mtime,
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return { path: directory, parent: parentOf(directory), drives, entries, selected, truncated };
}
