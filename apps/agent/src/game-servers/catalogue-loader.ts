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

/**
 * The loaded catalog, and the ability to load it again.
 *
 * Everything that needs the catalog holds this rather than an array, because
 * the point of the folder is that an administrator can drop a config in and
 * have the game appear. Handing out a snapshot array would mean the panel kept
 * serving the catalog as it was when the process started, and "add a file"
 * would quietly mean "add a file and restart the agent".
 */
export class GameServerCatalogue {
  #entries: readonly GameServerCatalogEntry[] = [];
  #rejected: CatalogLoadResult['rejected'] = [];

  private constructor(
    readonly seedDir: string,
    readonly dataDir: string,
  ) {}

  static async load(seedDir: string, dataDir: string): Promise<GameServerCatalogue> {
    const catalogue = new GameServerCatalogue(seedDir, dataDir);
    await catalogue.reload();
    return catalogue;
  }

  get entries(): readonly GameServerCatalogEntry[] {
    return this.#entries;
  }

  /** Files that failed validation, so an author can be told what was wrong. */
  get rejected(): CatalogLoadResult['rejected'] {
    return this.#rejected;
  }

  find(id: string): GameServerCatalogEntry | undefined {
    return this.#entries.find((entry) => entry.id === id);
  }

  async reload(): Promise<CatalogLoadResult> {
    const result = await loadGameServerCatalogue(this.seedDir, this.dataDir);
    this.#entries = result.entries;
    this.#rejected = result.rejected;
    return result;
  }
}
