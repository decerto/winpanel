import fs from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type GameServerSeedFile } from '@winpanel/shared';
import { expandPlaceholders, expandValue, type PlaceholderValues } from './placeholders.js';

/**
 * Writes the configuration files a catalog entry declares.
 *
 * Every game needs to be told the port it was allocated and the passwords the
 * panel generated for it, and every game keeps that in a different file in a
 * different format. Describing the file in the catalog keeps that knowledge
 * with the game instead of in the installer.
 */

/** Adds or replaces a flat `key=value` entry without disturbing other settings. */
export function setFlatProperty(text: string, key: string, value: string): string {
  // Splitting '' yields [''], which would leave a blank first line in a file
  // the panel is creating from nothing.
  const lines = text === '' ? [] : text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  return next
    .filter((line, index) => line !== '' || index < next.length - 1)
    .join('\n')
    .replace(/\n*$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves a declared path under `dataDir`, refusing anything that escapes it.
 *
 * The schema already rejects absolute paths and `..`, but a catalog file is
 * contributed content and this is the step that actually touches the disk, so
 * the containment is confirmed against the resolved path as well.
 */
export function resolveSeedPath(dataDir: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new Error(`"${relative}" is not a path inside the server's own folder.`);
  }
  const root = path.resolve(dataDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`"${relative}" is not a path inside the server's own folder.`);
  }
  return target;
}

async function readIfPresent(target: string): Promise<string | null> {
  return await fs.readFile(target, 'utf8').then(
    (text) => text,
    () => null,
  );
}

function renderFlat(
  existing: string,
  file: GameServerSeedFile,
  values: PlaceholderValues,
  newline: string,
): string {
  let text = file.mode === 'merge' ? existing : '';
  for (const [key, raw] of Object.entries(file.values)) {
    text = setFlatProperty(text, key, String(expandValue(raw, values)));
  }
  return `${text.split('\n').join(newline)}${newline}`;
}

function renderJson(
  existing: string,
  file: GameServerSeedFile,
  values: PlaceholderValues,
): string {
  let base: Record<string, unknown> = {};
  if (file.mode === 'merge' && existing.trim() !== '') {
    const parsed: unknown = JSON.parse(existing);
    if (isRecord(parsed)) base = parsed;
  }
  for (const [key, raw] of Object.entries(file.values)) {
    base[key] = expandValue(raw, values);
  }
  return `${JSON.stringify(base, null, 2)}\n`;
}

export interface SeedFileOutcome {
  path: string;
  written: boolean;
}

export async function writeSeedFiles(
  files: readonly GameServerSeedFile[],
  dataDir: string,
  values: PlaceholderValues,
): Promise<SeedFileOutcome[]> {
  const outcomes: SeedFileOutcome[] = [];

  for (const file of files) {
    // The path itself is expanded too: several games name their settings file
    // after the server, so `Server/{slug}.ini` has to resolve like any value.
    const relative = expandPlaceholders(file.path, values);
    const target = resolveSeedPath(dataDir, relative);
    const existing = await readIfPresent(target);

    // `create` exists so a server the owner has since configured by hand is
    // not silently reset by a reinstall.
    if (file.mode === 'create' && existing !== null) {
      outcomes.push({ path: relative, written: false });
      continue;
    }

    const newline = file.eol === 'crlf' ? '\r\n' : '\n';
    let content: string;
    if (file.format === 'json') {
      content = renderJson(existing ?? '', file, values);
    } else if (file.format === 'text') {
      content = `${expandPlaceholders(file.content ?? '', values).split('\n').join(newline)}${newline}`;
    } else {
      content = renderFlat(existing ?? '', file, values, newline);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    outcomes.push({ path: relative, written: true });
  }

  return outcomes;
}
