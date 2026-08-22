import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameServerCatalogue } from '../src/game-servers/catalogue-loader.js';

const SEED = path.join(import.meta.dirname, '..', '..', '..', 'game-servers', 'catalogue');
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-catalogue-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('game-server catalogue loading', () => {
  it('loads the built-in seed set from the repo folder', async () => {
    const { entries, rejected } = await loadGameServerCatalogue(SEED, path.join(tmpDir, 'empty'));

    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.map((entry) => entry.id)).toContain('minecraft-java-vanilla');
    expect(entries.map((entry) => entry.id)).toContain('zomboid-dedicated');
    expect(rejected).toEqual([]);
  });

  it('lets a config dropped into the data folder override a built-in', async () => {
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'palworld.json'),
      JSON.stringify({
        id: 'palworld-dedicated',
        provider: 'steam',
        name: 'Palworld (local override)',
        description: 'Local override for the built-in Palworld config.',
        status: 'ready',
        genre: 'Survival',
        art: 'ember',
        requiresEula: true,
        steamRequiresOwnership: false,
        steamAppId: 2394010,
        steamArtAppId: 1623730,
        executable: 'PalServer.exe',
        launchArgs: ['-port={gamePort}'],
        console: 'none',
        ports: [
          { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 8211 },
          { name: 'query', protocol: 'udp', purpose: 'query', visibility: 'public', port: 27015 },
          { name: 'rcon', protocol: 'tcp', purpose: 'rcon', visibility: 'loopback', port: 25575 },
        ],
      }),
    );

    const { entries } = await loadGameServerCatalogue(SEED, dataDir);
    const palworld = entries.find((entry) => entry.id === 'palworld-dedicated');
    expect(palworld?.name).toBe('Palworld (local override)');
  });

  it('adds a new game from a dropped config file', async () => {
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'custom-game.json'),
      JSON.stringify({
        id: 'custom-game-dedicated',
        provider: 'steam',
        name: 'Custom Game',
        description: 'A game added by dropping a config file into the data folder.',
        status: 'ready',
        genre: 'Survival',
        art: 'steel',
        requiresEula: true,
        steamRequiresOwnership: false,
        steamAppId: 12345,
        executable: 'CustomServer.exe',
        launchArgs: ['-port', '{gamePort}'],
        console: 'none',
        ports: [
          { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 25000 },
        ],
      }),
    );

    const { entries } = await loadGameServerCatalogue(SEED, dataDir);
    expect(entries.map((entry) => entry.id)).toContain('custom-game-dedicated');
  });

  it('skips an invalid config rather than loading it', async () => {
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'broken.json'), '{"id": "broken"}');

    const { entries, rejected } = await loadGameServerCatalogue(SEED, dataDir);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.file).toBe('broken.json');
    expect(entries.map((entry) => entry.id)).not.toContain('broken');
  });

  it('points every built-in config shortcut at a data-relative file', async () => {
    const { entries, rejected } = await loadGameServerCatalogue(SEED, path.join(tmpDir, 'empty'));
    expect(rejected).toEqual([]);

    const withShortcut = entries.filter((entry) => entry.configFile);
    // The shortcut is the common case: every ready built-in names its settings
    // file except Bedrock, whose server.properties lives outside the data folder.
    expect(withShortcut.map((entry) => entry.id)).toEqual([
      'minecraft-java-vanilla',
      'nomad-dedicated',
      'zomboid-dedicated',
    ]);
    for (const entry of withShortcut) {
      expect(entry.configFile).not.toMatch(/^(\/|[a-zA-Z]:)/);
      expect(entry.configFile).not.toContain('..');
    }
  });
});
