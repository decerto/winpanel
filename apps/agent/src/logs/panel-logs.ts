import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_READ_BYTES = 512 * 1024;
const MAX_DIRECTORY_DEPTH = 4;

export interface PanelLogInfo {
  id: string;
  size: number;
  modifiedAt: Date;
}

export interface PanelLogLine {
  at: number | null;
  level: string;
  message: string;
  raw: string;
}

export interface PanelLogRead extends PanelLogInfo {
  lines: PanelLogLine[];
  truncated: boolean;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function idFor(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function absoluteForId(root: string, id: string): string | null {
  if (id.length === 0 || id.includes('\u0000')) return null;

  const normalised = id.replace(/\\/g, '/');
  const absolute = path.resolve(root, ...normalised.split('/'));
  return isInside(absolute, root) ? absolute : null;
}

async function collectFiles(
  root: string,
  current: string,
  depth: number,
  files: PanelLogInfo[],
  excludedRoots: readonly string[],
): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH) return;

  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const candidate = path.join(current, entry.name);
    const stats = await fs.lstat(candidate).catch(() => null);
    if (!stats || stats.isSymbolicLink()) continue;

    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || (real !== root && !isInside(real, root))) continue;
    if (excludedRoots.some((excluded) => real === excluded || isInside(real, excluded))) continue;

    if (stats.isDirectory()) {
      await collectFiles(root, real, depth + 1, files, excludedRoots);
      continue;
    }

    if (!stats.isFile() || !entry.name.toLowerCase().endsWith('.log')) continue;

    files.push({ id: idFor(root, real), size: stats.size, modifiedAt: stats.mtime });
  }
}

async function resolvedExclusions(excludedDirs: readonly string[]): Promise<string[]> {
  return Promise.all(
    excludedDirs.map(async (excluded) => (await fs.realpath(excluded).catch(() => null)) ?? path.resolve(excluded)),
  );
}

export async function listPanelLogs(
  logDir: string,
  excludedDirs: readonly string[] = [],
): Promise<PanelLogInfo[]> {
  const root = await fs.realpath(logDir).catch(() => null);
  if (!root) return [];

  const files: PanelLogInfo[] = [];
  await collectFiles(root, root, 0, files, await resolvedExclusions(excludedDirs));
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : Math.round(value * 1000);
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function levelOf(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value !== 'number') return 'info';

  if (value >= 60) return 'fatal';
  if (value >= 50) return 'error';
  if (value >= 40) return 'warn';
  if (value >= 30) return 'info';
  return 'debug';
}

function parseLine(raw: string): PanelLogLine {
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const message =
      typeof record['msg'] === 'string'
        ? record['msg']
        : typeof record['message'] === 'string'
          ? record['message']
          : raw;

    return {
      at: timestampOf(record['time'] ?? record['ts']),
      level: levelOf(record['level']),
      message,
      raw,
    };
  } catch {
    return { at: null, level: 'info', message: raw, raw };
  }
}

export async function readPanelLog(
  logDir: string,
  id: string,
  lineLimit: number,
  excludedDirs: readonly string[] = [],
): Promise<PanelLogRead | null> {
  const listed = await listPanelLogs(logDir, excludedDirs);
  const info = listed.find((candidate) => candidate.id === id);
  if (!info) return null;

  const root = await fs.realpath(logDir).catch(() => null);
  if (!root) return null;

  const absolute = absoluteForId(root, id);
  if (!absolute) return null;

  const real = await fs.realpath(absolute).catch(() => null);
  if (!real || idFor(root, real) !== id) return null;

  const stats = await fs.lstat(real).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null;

  const handle = await fs.open(real, 'r').catch(() => null);
  if (!handle) return null;

  try {
    const size = stats.size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    let truncated = start > 0;

    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline === -1) {
        text = '';
      } else {
        text = text.slice(firstNewline + 1);
      }
    }

    let rawLines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (rawLines.length > lineLimit) {
      truncated = true;
      rawLines = rawLines.slice(-lineLimit);
    }

    return {
      ...info,
      size,
      modifiedAt: stats.mtime,
      lines: rawLines.map(parseLine),
      truncated,
    };
  } finally {
    await handle.close();
  }
}