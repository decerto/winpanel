import { z } from 'zod';

/**
 * Syntactic path validation shared by the agent and the panel.
 *
 * This layer catches malformed and hostile path *strings*. It is deliberately
 * NOT the whole story: the agent additionally resolves paths on disk and
 * re-verifies containment against the site root with `fs.realpath` on every
 * operation, because a junction created after validation would otherwise
 * become an escape hatch. See the agent's path containment module.
 *
 * Both layers are required. Neither is sufficient alone.
 */

/** Windows reserved device names. Using one as a file name breaks in odd ways. */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** True for a name Windows will not accept as a file or folder. */
export function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE_NAMES.has(name.split('.')[0]?.toLowerCase() ?? '');
}

/** Characters Windows forbids in file names (excluding the path separators). */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

export interface PathRejection {
  readonly ok: false;
  readonly reason: string;
}
export interface PathAcceptance {
  readonly ok: true;
  /** Normalised to forward slashes, no leading/trailing slash. */
  readonly value: string;
}
export type PathValidation = PathAcceptance | PathRejection;

/**
 * Validates a path that must stay *inside* a root directory.
 *
 * Rejects absolute paths, drive letters, UNC paths, parent traversal, NUL
 * bytes, alternate data streams, reserved device names, and trailing dots or
 * spaces (which Windows silently strips, letting `evil.exe.` become
 * `evil.exe`).
 *
 * An empty string is accepted and means "the root itself".
 */
export function validateRelativePath(input: string): PathValidation {
  if (input.includes('\u0000')) {
    return { ok: false, reason: 'Path contains a null byte.' };
  }

  // Normalise separators up front so the rest of the checks only see '/'.
  const normalised = input.replace(/\\/g, '/');

  if (normalised.startsWith('/')) {
    return { ok: false, reason: 'Path must be relative, not absolute.' };
  }
  if (/^[a-z]:/i.test(normalised)) {
    return { ok: false, reason: 'Path must not include a drive letter.' };
  }
  if (normalised.startsWith('//')) {
    return { ok: false, reason: 'Network (UNC) paths are not allowed.' };
  }

  const segments = normalised.split('/').filter((s) => s.length > 0);

  for (const segment of segments) {
    if (segment === '.') {
      return { ok: false, reason: 'Path must not contain "." segments.' };
    }
    if (segment === '..') {
      return { ok: false, reason: 'Path must not navigate outside the folder.' };
    }
    if (ILLEGAL_CHARS.test(segment)) {
      return { ok: false, reason: `"${segment}" contains characters Windows does not allow.` };
    }
    // An alternate data stream hides content behind `file.txt:hidden`.
    if (segment.includes(':')) {
      return { ok: false, reason: 'Path must not contain ":".' };
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { ok: false, reason: `"${segment}" must not end with a dot or space.` };
    }
    const stem = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_DEVICE_NAMES.has(stem)) {
      return { ok: false, reason: `"${segment}" is a reserved Windows device name.` };
    }
  }

  return { ok: true, value: segments.join('/') };
}

/** Zod schema for a path that must stay inside its root. */
export const RelativePath = z
  .string()
  .max(1024, 'Path is too long.')
  .superRefine((value, ctx) => {
    const result = validateRelativePath(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
    }
  })
  .transform((value) => {
    const result = validateRelativePath(value);
    // superRefine has already rejected the invalid case.
    return result.ok ? result.value : value;
  });

/** A single file or folder name — no separators at all. */
export const FileName = z
  .string()
  .min(1, 'Name is required.')
  .max(255, 'Name is too long.')
  .superRefine((value, ctx) => {
    if (value.includes('/') || value.includes('\\')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Name must not contain slashes.' });
      return;
    }
    const result = validateRelativePath(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
    }
  });
