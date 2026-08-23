import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Copies the built-in game configs into the folder the panel reads.
 *
 * The data folder is where an administrator drops or overrides configs, so it
 * cannot simply be overwritten on every start. It also cannot be written once
 * and never touched again, which is what the first version of this did: the
 * copy taken on a panel's very first run then shadowed the built-in for good,
 * so every correction shipped afterwards was invisible on exactly the installs
 * that needed it.
 *
 * The manifest records what was last written for each file. A file still
 * matching its record has not been touched by anyone and is updated; one that
 * differs is somebody's edit and is left alone. It lives outside the catalog
 * folder so the loader never tries to read it as a game.
 */

const MANIFEST = '.seeded-configs.json';

function digest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function readIfPresent(target: string): Promise<string | null> {
  return await fs.readFile(target, 'utf8').then(
    (text) => text,
    () => null,
  );
}

export interface CatalogueSeedResult {
  /** Configs written or refreshed from the built-in set. */
  updated: string[];
  /** Configs left alone because they had been edited on this machine. */
  customised: string[];
}

export async function seedGameServerCatalogue(
  seedDir: string,
  dataDir: string,
): Promise<CatalogueSeedResult> {
  const result: CatalogueSeedResult = { updated: [], customised: [] };
  await fs.mkdir(dataDir, { recursive: true });

  const files = await fs.readdir(seedDir).then(
    (names) => names.filter((name) => name.toLowerCase().endsWith('.json')),
    // A packaged install that ships its own set may have no seed folder at
    // all; a missing seed is not a startup failure.
    () => [],
  );
  if (files.length === 0) return result;

  const manifestPath = path.join(path.dirname(dataDir), MANIFEST);
  const manifest = JSON.parse((await readIfPresent(manifestPath)) ?? '{}') as Record<string, string>;
  const next: Record<string, string> = { ...manifest };

  for (const file of files) {
    const shipped = await readIfPresent(path.join(seedDir, file));
    if (shipped === null) continue;

    const target = path.join(dataDir, file);
    const current = await readIfPresent(target);
    const shippedHash = digest(shipped);

    if (current !== null && digest(current) === shippedHash) {
      next[file] = shippedHash;
      continue;
    }

    const recorded = manifest[file];
    const untouched = current === null || recorded === digest(current);
    if (!untouched && recorded !== undefined) {
      result.customised.push(file);
      continue;
    }

    // No record means the file predates the manifest, so whether it is an old
    // seed or an edit cannot be known. Keeping a copy beside it makes the
    // update reversible; the extension keeps it out of the loader's way.
    if (current !== null && recorded === undefined) {
      await fs.writeFile(`${target}.replaced`, current, 'utf8');
    }

    await fs.writeFile(target, shipped, 'utf8');
    next[file] = shippedHash;
    result.updated.push(file);
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return result;
}
