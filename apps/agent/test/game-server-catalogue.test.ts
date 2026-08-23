import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameServerCatalogue, loadGameServerCatalogue } from '../src/game-servers/catalogue-loader.js';
import { seedGameServerCatalogue } from '../src/game-servers/catalogue-seed.js';

const SEED = path.join(import.meta.dirname, '..', '..', '..', 'game-servers', 'catalogue');
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-catalogue-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('seeding the catalogue folder', () => {
  it('refreshes a built-in nobody has edited, so shipped fixes arrive', async () => {
    // The first version of this only wrote files that were missing, which meant
    // the copy taken on a panel's first run shadowed the built-in for good and
    // every later correction was invisible on the installs that needed it.
    const seedDir = path.join(tmpDir, 'seed');
    const dataDir = path.join(tmpDir, 'data', 'catalogue');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":1}');

    await seedGameServerCatalogue(seedDir, dataDir);
    expect(await fs.readFile(path.join(dataDir, 'game.json'), 'utf8')).toBe('{"version":1}');

    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":2}');
    const second = await seedGameServerCatalogue(seedDir, dataDir);

    expect(second.updated).toContain('game.json');
    expect(await fs.readFile(path.join(dataDir, 'game.json'), 'utf8')).toBe('{"version":2}');
  });

  it('leaves a config that was edited on this machine alone', async () => {
    const seedDir = path.join(tmpDir, 'seed');
    const dataDir = path.join(tmpDir, 'data', 'catalogue');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":1}');
    await seedGameServerCatalogue(seedDir, dataDir);

    await fs.writeFile(path.join(dataDir, 'game.json'), '{"version":1,"mine":true}');
    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":2}');
    const result = await seedGameServerCatalogue(seedDir, dataDir);

    expect(result.customised).toContain('game.json');
    expect(await fs.readFile(path.join(dataDir, 'game.json'), 'utf8')).toBe('{"version":1,"mine":true}');
  });

  it('keeps a copy when it updates a file it has no record of', async () => {
    // Upgrading from a panel that predates the manifest: whether the file on
    // disk is an old seed or someone's edit cannot be known, so the update is
    // made reversible.
    const seedDir = path.join(tmpDir, 'seed');
    const dataDir = path.join(tmpDir, 'data', 'catalogue');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":2}');
    await fs.writeFile(path.join(dataDir, 'game.json'), '{"version":1}');

    await seedGameServerCatalogue(seedDir, dataDir);

    expect(await fs.readFile(path.join(dataDir, 'game.json'), 'utf8')).toBe('{"version":2}');
    expect(await fs.readFile(path.join(dataDir, 'game.json.replaced'), 'utf8')).toBe('{"version":1}');
  });

  it('does not leave its bookkeeping where the loader will read it as a game', async () => {
    const seedDir = path.join(tmpDir, 'seed');
    const dataDir = path.join(tmpDir, 'data', 'catalogue');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, 'game.json'), '{"version":1}');

    await seedGameServerCatalogue(seedDir, dataDir);

    expect(await fs.readdir(dataDir)).toEqual(['game.json']);
  });
});

describe('game-server catalogue loading', () => {
  it('rejects a config whose placeholders cannot resolve, before it reaches the library', async () => {
    // The alternative is what this replaced: a seven-gigabyte download, and
    // then a failure because the file asked for a heap it never declared.
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'broken-tokens.json'),
      JSON.stringify({
        id: 'broken-tokens',
        provider: 'steam',
        name: 'Broken',
        description: 'Asks for things it never declared.',
        genre: 'Survival',
        requiresEula: true,
        steamAppId: 1,
        executable: 'Broken.exe',
        launchArgs: ['-Xmx{heapMb}m', '-port', '{port:qeury}', '-pass', '{secret:rcon}'],
        ports: [{ name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 27500 }],
      }),
    );

    const { entries, rejected } = await loadGameServerCatalogue(SEED, dataDir);

    expect(entries.map((entry) => entry.id)).not.toContain('broken-tokens');
    const reason = rejected.find((problem) => problem.file === 'broken-tokens.json')?.error ?? '';
    expect(reason).toContain('heap');
    expect(reason).toContain('{port:qeury}');
    expect(reason).toContain('{secret:rcon}');
  });

  it('picks up a config added after startup, without restarting the agent', async () => {
    // The whole point of the folder is that an administrator can drop a game
    // in. Serving the snapshot taken at boot would make that mean "drop a game
    // in and restart the agent".
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    const catalogue = await GameServerCatalogue.load(SEED, dataDir);
    const before = catalogue.entries.length;
    expect(catalogue.find('community-game')).toBeUndefined();

    await fs.writeFile(
      path.join(dataDir, 'community-game.json'),
      JSON.stringify({
        id: 'community-game',
        provider: 'steam',
        name: 'Community Game',
        description: 'Contributed by someone who never opened an editor.',
        genre: 'Survival',
        requiresEula: true,
        steamAppId: 999999,
        executable: 'CommunityServer.exe',
        launchArgs: ['-port', '{port:game}'],
        ports: [{ name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 27500 }],
      }),
    );

    await catalogue.reload();

    expect(catalogue.entries.length).toBe(before + 1);
    expect(catalogue.find('community-game')?.name).toBe('Community Game');
  });

  it('keeps the reason a config was rejected, so its author can be told', async () => {
    const dataDir = path.join(tmpDir, 'catalogue-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'typo.json'), JSON.stringify({ id: 'typo', provider: 'stem' }));

    const catalogue = await GameServerCatalogue.load(SEED, dataDir);

    expect(catalogue.rejected.map((problem) => problem.file)).toEqual(['typo.json']);
    expect(catalogue.rejected[0]?.error).toBeTruthy();
    // One bad file must not take the rest of the library down with it.
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(5);
  });

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
    // The shortcut is the common case: every ready built-in names the settings
    // file the panel seeds for it.
    expect(withShortcut.map((entry) => entry.id)).toEqual([
      'minecraft-java-vanilla',
      'minecraft-bedrock-vanilla',
      'nomad-dedicated',
      'zomboid-dedicated',
    ]);
    for (const entry of withShortcut) {
      expect(entry.configFile).not.toMatch(/^(\/|[a-zA-Z]:)/);
      expect(entry.configFile).not.toContain('..');
    }
  });
});
