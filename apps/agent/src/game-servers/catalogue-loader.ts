import fs from 'node:fs/promises';
import path from 'node:path';
import { GameServerConfigFile, type GameServerCatalogEntry } from '@winpanel/shared';

/**
 * The catalog WinPanel offers.
 *
 * Two sources, merged by ID with the user folder winning:
 *
 *  - `repoDir` — the seed set that ships with the installer, so a first
 *    install has something useful without a network round-trip.
 *  - `dataDir` — the folder the running panel reads, so an administrator can
 *    drop a config file onto the machine and have it appear without a
 *    rebuild. A file there with a built-in ID replaces the built-in, which is
 *    how a local tweak wins without forking the release.
 *
 * Every file is validated against the shared schema before it can influence
 * anything; an invalid one is skipped with its name logged, not loaded.
 */
export interface CatalogLoadResult {
  entries: readonly GameServerCatalogEntry[];
  rejected: Array<{ file: string; error: string }>;
}

async function readDirectory(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
}

async function readEntry(
  dir: string,
  file: string,
  rejected: CatalogLoadResult['rejected'],
): Promise<GameServerCatalogEntry | null> {
  const filePath = path.join(dir, file);
  try {
    const parsed = GameServerConfigFile.parse(
      JSON.parse(await fs.readFile(filePath, 'utf8')),
    );
    return parsed;
  } catch (error) {
    rejected.push({
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function loadGameServerCatalogue(
  repoDir: string,
  dataDir: string,
): Promise<CatalogLoadResult> {
  const rejected: CatalogLoadResult['rejected'] = [];
  const entries = new Map<string, GameServerCatalogEntry>();

  for (const file of await readDirectory(repoDir)) {
    const entry = await readEntry(repoDir, file, rejected);
    if (entry) entries.set(entry.id, entry);
  }

  for (const file of await readDirectory(dataDir)) {
    const entry = await readEntry(dataDir, file, rejected);
    if (entry) entries.set(entry.id, entry);
  }

  return { entries: [...entries.values()], rejected };
}
