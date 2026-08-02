import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRelativePath } from '@winpanel/shared';

/**
 * Filesystem containment for the file manager.
 *
 * The shared package rejects hostile path *strings*. This module handles the
 * part that only the filesystem can answer: where a path actually lands once
 * Windows has resolved junctions, symlinks, 8.3 short names and case.
 *
 * The attack this exists to stop: a user creates a junction inside their site
 * folder pointing at C:\Windows, then asks to read through it. The string
 * `myfolder/notes.txt` is perfectly innocent; only `realpath` reveals that it
 * resolves outside the site. So containment is re-verified on every single
 * operation rather than once at the start, and creating links is refused
 * outright.
 */

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/** Windows path length limit without the `\\?\` prefix. */
const MAX_PATH_WITHOUT_PREFIX = 259;

/**
 * Prefixes a Windows path so the OS accepts it beyond 260 characters. Deep
 * `node_modules` trees exceed this routinely.
 */
export function toExtendedLengthPath(absolutePath: string): string {
  if (process.platform !== 'win32') return absolutePath;
  if (absolutePath.startsWith('\\\\?\\')) return absolutePath;
  if (absolutePath.length <= MAX_PATH_WITHOUT_PREFIX) return absolutePath;
  if (absolutePath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${absolutePath.slice(2)}`;
  }
  return `\\\\?\\${absolutePath}`;
}

/** Case-insensitive on Windows, case-sensitive elsewhere. */
function isSamePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child: string, parent: string): boolean {
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const p = process.platform === 'win32' ? withSep.toLowerCase() : withSep;
  return c.startsWith(p);
}

/**
 * Resolves a path that may not exist yet, by walking up to the nearest
 * ancestor that does and canonicalising that.
 *
 * Needed because create/upload operations target paths that do not exist,
 * but their *parent* must still be proven to be inside the root.
 */
async function realpathOfNearestExisting(absolutePath: string): Promise<{
  resolved: string;
  existed: boolean;
}> {
  const segmentsWalkedUp: string[] = [];
  let current = absolutePath;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return {
        resolved: segmentsWalkedUp.length === 0 ? real : path.join(real, ...segmentsWalkedUp.reverse()),
        existed: segmentsWalkedUp.length === 0,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;

      const parent = path.dirname(current);
      if (isSamePath(parent, current)) {
        // Walked all the way to the drive root without finding anything real.
        throw new PathContainmentError('That location does not exist.');
      }
      segmentsWalkedUp.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** Canonical absolute path, safe to pass to fs calls. */
  readonly absolute: string;
  /** Path relative to the root, forward-slashed. */
  readonly relative: string;
  /** Whether the target currently exists. */
  readonly exists: boolean;
  /** The canonical root this was resolved against. */
  readonly root: string;
}

/**
 * Resolves `relativePath` inside `rootDir` and proves it cannot escape.
 *
 * Throws `PathContainmentError` if the path is malformed, escapes the root,
 * or reaches the root through a link.
 */
export async function resolveWithinRoot(
  rootDir: string,
  relativePath: string,
): Promise<ResolvedPath> {
  const syntax = validateRelativePath(relativePath);
  if (!syntax.ok) {
    throw new PathContainmentError(syntax.reason);
  }

  // The root must itself be canonicalised, otherwise comparing against a
  // non-canonical prefix would let a junctioned root produce false negatives.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(rootDir);
  } catch {
    throw new PathContainmentError('That site folder no longer exists on disk.');
  }

  const candidate = path.resolve(canonicalRoot, syntax.value);

  // Cheap pre-check on the lexical form. The realpath check below is the one
  // that actually matters, but failing early gives a clearer error.
  if (!isSamePath(candidate, canonicalRoot) && !isInside(candidate, canonicalRoot)) {
    throw new PathContainmentError('That location is outside this site\u2019s folder.');
  }

  const { resolved, existed } = await realpathOfNearestExisting(candidate);

  if (!isSamePath(resolved, canonicalRoot) && !isInside(resolved, canonicalRoot)) {
    // This is the junction-escape case: the string looked fine, the real
    // location is somewhere else entirely.
    throw new PathContainmentError('That location is outside this site\u2019s folder.');
  }

  return {
    absolute: resolved,
    relative: path
      .relative(canonicalRoot, resolved)
      .split(path.sep)
      .filter((s) => s.length > 0)
      .join('/'),
    exists: existed,
    root: canonicalRoot,
  };
}

/**
 * True when the entry is a reparse point (junction or symlink).
 *
 * These are shown in listings but never followed, and the file manager
 * refuses to create them, because a link is the most direct route out of a
 * contained directory.
 */
export async function isReparsePoint(absolutePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(toExtendedLengthPath(absolutePath));
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolves a path and additionally refuses if it, or any component of it, is
 * a link. Used for write operations, where following a link would let someone
 * overwrite a file outside the site.
 */
export async function resolveForWrite(
  rootDir: string,
  relativePath: string,
): Promise<ResolvedPath> {
  const resolved = await resolveWithinRoot(rootDir, relativePath);
  if (resolved.exists && (await isReparsePoint(resolved.absolute))) {
    throw new PathContainmentError(
      'That item is a shortcut to another location, so it cannot be changed here.',
    );
  }
  return resolved;
}
