import { z } from 'zod';
import { FileName, RelativePath } from './paths.js';

export const FileKind = z.enum(['file', 'directory']);
export type FileKind = z.infer<typeof FileKind>;

export const FileEntry = z.object({
  name: z.string(),
  /** Path relative to the site root, using forward slashes. */
  path: z.string(),
  kind: FileKind,
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.coerce.date(),
  hidden: z.boolean().default(false),
  /**
   * True for reparse points (junctions and symlinks). The file manager shows
   * them but refuses to follow or create them — a junction is the most direct
   * way out of a contained directory.
   */
  isLink: z.boolean().default(false),
  /** True when the entry sits inside `releases/`, which a deploy will replace. */
  ephemeral: z.boolean().default(false),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const ListDirectoryRequest = z.object({
  siteSlug: z.string().min(1),
  path: RelativePath.default(''),
  showHidden: z.boolean().default(false),
  sortBy: z.enum(['name', 'size', 'modified']).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListDirectoryRequest = z.infer<typeof ListDirectoryRequest>;

export const ListDirectoryResponse = z.object({
  path: z.string(),
  entries: z.array(FileEntry),
  /** True when this folder is replaced on the next deploy. */
  ephemeral: z.boolean(),
  quotaUsedBytes: z.number().int().nonnegative(),
  quotaTotalBytes: z.number().int().positive(),
});
export type ListDirectoryResponse = z.infer<typeof ListDirectoryResponse>;

export const CreateFolderRequest = z.object({
  siteSlug: z.string().min(1),
  parentPath: RelativePath.default(''),
  name: FileName,
});

export const RenameRequest = z.object({
  siteSlug: z.string().min(1),
  path: RelativePath,
  newName: FileName,
});

export const MoveRequest = z.object({
  siteSlug: z.string().min(1),
  sourcePaths: z.array(RelativePath).min(1).max(500),
  destinationPath: RelativePath.default(''),
  /** Copy instead of move. */
  copy: z.boolean().default(false),
});

export const DeleteRequest = z.object({
  siteSlug: z.string().min(1),
  paths: z.array(RelativePath).min(1).max(500),
  /**
   * Deletes move to a per-site recycle folder by default so a mistake is
   * recoverable. Permanent deletion is opt-in.
   */
  permanent: z.boolean().default(false),
});

export const ReadFileRequest = z.object({
  siteSlug: z.string().min(1),
  path: RelativePath,
});

export const WriteFileRequest = z.object({
  siteSlug: z.string().min(1),
  path: RelativePath,
  content: z.string().max(5 * 1024 * 1024),
  /**
   * Modified time the editor last saw. If the file changed on disk since then
   * the write is refused, so a deploy or a second tab cannot be silently
   * clobbered.
   */
  expectedModifiedAt: z.coerce.date().nullable().default(null),
});

export const ExtractArchiveRequest = z.object({
  siteSlug: z.string().min(1),
  archivePath: RelativePath,
  destinationPath: RelativePath.default(''),
});

/** Largest file the inline editor will open. Bigger files download instead. */
export const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

/** Caps applied during archive extraction to blunt zip bombs. */
export const ARCHIVE_LIMITS = {
  maxEntries: 20_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
} as const;

/** The folder deleted files are moved into, relative to the site root. */
export const RECYCLE_DIRNAME = '.winpanel-recycle';
