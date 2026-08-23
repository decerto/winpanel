import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServerCatalogEntry, parseWorkshopReference } from '@winpanel/shared';
import {
  clearWorkshopSearchCache,
  collectModIds,
  copyModFolders,
  downloadWorkshopItem,
  fetchWorkshopDetails,
  isAllowedPreviewUrl,
  modFolders,
  recallPreview,
  removeModFolders,
  searchWorkshop,
  workshopBrowseUrl,
  workshopItemDirectory,
  WorkshopError,
  writeWorkshopConfig,
} from '../src/game-servers/workshop.js';

/**
 * Steam Workshop items, downloaded by the panel rather than by the customer.
 *
 * The point of these tests is that nobody but the server ever signs in to
 * Steam: a link goes in, files come out, and the operator's account is the
 * only one involved. The failure modes worth pinning down are the ones that
 * would otherwise be discovered as "the mod is installed and the game still
 * does not load it".
 */

let root: string;

const entry = (workshop: unknown): GameServerCatalogEntry =>
  GameServerCatalogEntry.parse({
    id: 'zomboid-dedicated',
    provider: 'steam',
    name: 'Project Zomboid',
    description: 'A test entry.',
    genre: 'Survival',
    requiresEula: true,
    steamAppId: 380870,
    executable: 'StartServer64.bat',
    ports: [{ name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 16261 }],
    workshop,
  });

const zomboidWorkshop = {
  appId: 108600,
  modsDirectory: 'mods',
  config: { path: 'Server/{slug}.ini', itemsKey: 'WorkshopItems', modsKey: 'Mods', separator: ';', eol: 'crlf' },
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-workshop-'));
  clearWorkshopSearchCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workshop references', () => {
  it('takes whatever someone pasted', () => {
    expect(parseWorkshopReference('2392709985')).toBe('2392709985');
    expect(parseWorkshopReference('https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985')).toBe(
      '2392709985',
    );
    expect(parseWorkshopReference('  https://steamcommunity.com/workshop/filedetails/?id=498441420&searchtext=x  ')).toBe(
      '498441420',
    );
    expect(parseWorkshopReference('steam://url/CommunityFilePage/2392709985')).toBe('2392709985');
  });

  it('refuses anything that is not one', () => {
    expect(parseWorkshopReference('')).toBeNull();
    expect(parseWorkshopReference('https://example.com/mods')).toBeNull();
    expect(parseWorkshopReference('best mod ever')).toBeNull();
  });
});

describe('workshop previews', () => {
  /*
   * The preview is proxied by the panel, so the URL it fetches is the one
   * Steam supplied and nothing else. Without this check the stored value
   * would be a request the agent makes on behalf of whatever wrote it.
   */
  it('only proxies image hosts Steam actually serves from', () => {
    expect(isAllowedPreviewUrl('https://images.steamusercontent.com/ugc/1/x.jpg')).toBe(true);
    expect(isAllowedPreviewUrl('https://steamuserimages-a.akamaihd.net/ugc/2/y.jpg')).toBe(true);
    expect(isAllowedPreviewUrl('https://evil.example.com/x.jpg')).toBe(false);
    expect(isAllowedPreviewUrl('http://images.steamusercontent.com/ugc/1/x.jpg')).toBe(false);
    expect(isAllowedPreviewUrl('http://127.0.0.1:8080/admin')).toBe(false);
    expect(isAllowedPreviewUrl(null)).toBe(false);
  });

  it('points the browse button at the game, not the dedicated-server tool', () => {
    const parsed = entry(zomboidWorkshop).workshop!;
    expect(workshopBrowseUrl(parsed)).toBe('https://steamcommunity.com/app/108600/workshop/');
  });
});

describe('workshop lookups', () => {
  const detailResponse = (details: unknown) => ({
    ok: true,
    json: async () => ({ response: { publishedfiledetails: [details] } }),
  }) as unknown as Response;

  it('reads a title and a size out of Steam\'s answer', async () => {
    const fetchImpl = vi.fn(async () =>
      detailResponse({
        publishedfileid: '2392709985',
        result: 1,
        title: 'Brita\'s Weapon Pack',
        file_size: '1048576',
        preview_url: 'https://images.steamusercontent.com/ugc/1/x.jpg',
        consumer_app_id: 108600,
      }),
    );

    const [item] = await fetchWorkshopDetails(['2392709985'], fetchImpl as unknown as typeof fetch);

    expect(item?.title).toBe('Brita\'s Weapon Pack');
    expect(item?.sizeBytes).toBe(1048576);
    expect(item?.appId).toBe(108600);
  });

  it('refuses an id Steam does not know, before anything is downloaded', async () => {
    const fetchImpl = vi.fn(async () => detailResponse({ publishedfileid: '1', result: 9 }));

    await expect(fetchWorkshopDetails(['1'], fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /no public Workshop item/,
    );
  });

  it('drops a preview URL that is not a Steam image host', async () => {
    const fetchImpl = vi.fn(async () =>
      detailResponse({
        publishedfileid: '5',
        result: 1,
        title: 'Mod',
        preview_url: 'https://attacker.example/pixel.gif',
      }),
    );

    const [item] = await fetchWorkshopDetails(['5'], fetchImpl as unknown as typeof fetch);

    expect(item?.previewUrl).toBeNull();
  });
});

describe('browsing the Workshop', () => {
  const page = (items: unknown[], total = items.length) => ({
    ok: true,
    status: 200,
    json: async () => ({ response: { total, publishedfiledetails: items } }),
  }) as unknown as Response;

  it('asks Steam for items of this game, sorted the way the panel was told', async () => {
    let requested = '';
    const fetchImpl = vi.fn(async (url: string) => {
      requested = url;
      return page([]);
    });

    await searchWorkshop({
      apiKey: 'KEY',
      appId: 108600,
      sort: 'popular',
      search: 'brita',
      tag: 'Build 42',
      page: 2,
      pageSize: 24,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const query = new URL(requested).searchParams;
    expect(query.get('appid')).toBe('108600');
    // EPublishedFileQueryType 12 = RankedByTotalUniqueSubscriptions.
    expect(query.get('query_type')).toBe('12');
    expect(query.get('search_text')).toBe('brita');
    expect(query.get('requiredtags')).toBe('Build 42');
    expect(query.get('page')).toBe('2');
    // Items, not collections or screenshots.
    expect(query.get('filetype')).toBe('0');
  });

  it('asks for a week of votes when sorting by what is trending', async () => {
    let requested = '';
    const fetchImpl = vi.fn(async (url: string) => {
      requested = url;
      return page([]);
    });

    await searchWorkshop({ apiKey: 'KEY', appId: 108600, sort: 'trend', fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(new URL(requested).searchParams.get('days')).toBe('7');
  });

  it('reads the fields the grid shows', async () => {
    const fetchImpl = vi.fn(async () =>
      page([
        {
          publishedfileid: '2392709985',
          result: 1,
          title: 'Brita\'s Weapon Pack',
          short_description: 'Adds a lot of guns.',
          file_size: '524288',
          preview_url: 'https://images.steamusercontent.com/ugc/1/x.jpg',
          time_updated: 1_700_000_000,
          lifetime_subscriptions: 91234,
          favorited: 4321,
          tags: [{ tag: 'Build 42', display_name: 'Build 42' }, { tag: 'Items' }],
          vote_data: { votes_up: 5000, votes_down: 120 },
        },
      ], 1),
    );

    const result = await searchWorkshop({
      apiKey: 'KEY',
      appId: 108600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.title).toBe('Brita\'s Weapon Pack');
    expect(result.items[0]?.subscriptions).toBe(91234);
    expect(result.items[0]?.votesUp).toBe(5000);
    expect(result.items[0]?.tags).toEqual(['Build 42', 'Items']);
    expect(result.items[0]?.sizeBytes).toBe(524288);
  });

  /*
   * The grid must not carry Steam URLs to the browser: images go through the
   * panel's own proxy, which looks the URL up rather than being handed one.
   */
  it('keeps the preview URL on the agent and remembers it for the proxy', async () => {
    const fetchImpl = vi.fn(async () =>
      page([
        {
          publishedfileid: '55',
          result: 1,
          title: 'Mod',
          preview_url: 'https://images.steamusercontent.com/ugc/9/z.jpg',
        },
      ]),
    );

    const result = await searchWorkshop({
      apiKey: 'KEY',
      appId: 108600,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.items[0]).not.toHaveProperty('previewUrl');
    expect(result.items[0]?.hasPreview).toBe(true);
    expect(recallPreview('55')).toBe('https://images.steamusercontent.com/ugc/9/z.jpg');
  });

  it('falls back to the previews list when an item has no headline image', async () => {
    const fetchImpl = vi.fn(async () =>
      page([
        {
          publishedfileid: '56',
          result: 1,
          title: 'Mod',
          previews: [
            { url: 'https://images.steamusercontent.com/ugc/2/second.jpg', sortorder: 2 },
            { url: 'https://images.steamusercontent.com/ugc/1/first.jpg', sortorder: 1 },
          ],
        },
      ]),
    );

    await searchWorkshop({ apiKey: 'KEY', appId: 108600, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(recallPreview('56')).toBe('https://images.steamusercontent.com/ugc/1/first.jpg');
  });

  it('drops banned and unavailable items rather than showing an Add button for them', async () => {
    const fetchImpl = vi.fn(async () =>
      page([
        { publishedfileid: '1', result: 1, title: 'Fine' },
        { publishedfileid: '2', result: 1, title: 'Removed', banned: 1 },
        { publishedfileid: '3', result: 9, title: 'Gone' },
      ], 3),
    );

    const result = await searchWorkshop({ apiKey: 'KEY', appId: 108600, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.items.map((item) => item.publishedFileId)).toEqual(['1']);
  });

  it('says so plainly when Steam rejects the key', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);

    await expect(
      searchWorkshop({ apiKey: 'WRONG', appId: 108600, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/Web API key/);
  });

  /* One key serves every customer on the machine. */
  it('serves an identical page from cache instead of spending the rate limit again', async () => {
    const fetchImpl = vi.fn(async () => page([{ publishedfileid: '77', result: 1, title: 'Cached' }]));
    const options = {
      apiKey: 'KEY',
      appId: 999_001,
      sort: 'newest' as const,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await searchWorkshop(options);
    await searchWorkshop(options);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('mods inside a downloaded item', () => {
  async function writeMod(item: string, name: string, id: string): Promise<void> {
    const folder = path.join(item, 'mods', name);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'mod.info'), `name=${name}\r\nid=${id}\r\n`, 'utf8');
  }

  it('treats each folder under mods/ as its own mod', async () => {
    const item = path.join(root, 'item');
    await writeMod(item, 'BritaWeapons', 'Brita');
    await writeMod(item, 'BritaArmour', 'Brita_2');

    const parsed = entry(zomboidWorkshop).workshop!;
    expect((await modFolders(item)).map((folder) => path.basename(folder)).sort()).toEqual([
      'BritaArmour',
      'BritaWeapons',
    ]);
    expect((await collectModIds(item, parsed)).sort()).toEqual(['Brita', 'Brita_2']);
  });

  /*
   * A build-42 item nests its manifest a folder deeper. Finding the id is
   * what puts the mod in the game's list, so a missed manifest is a mod that
   * downloads correctly and never loads.
   */
  it('finds a manifest that sits below the mod folder', async () => {
    const nested = path.join(root, 'item', 'mods', 'Nested', '42');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'mod.info'), 'id=NestedMod\n', 'utf8');

    expect(await collectModIds(path.join(root, 'item'), entry(zomboidWorkshop).workshop!)).toEqual([
      'NestedMod',
    ]);
  });

  it('treats an item with no mods folder as one mod in its own right', async () => {
    const item = path.join(root, 'plain');
    await fs.mkdir(item, { recursive: true });
    await fs.writeFile(path.join(item, 'mod.info'), 'id=Plain\n', 'utf8');

    expect(await modFolders(item)).toEqual([item]);
    expect(await collectModIds(item, entry(zomboidWorkshop).workshop!)).toEqual(['Plain']);
  });

  it('copies mod folders to where the game looks, and takes them away again', async () => {
    const item = path.join(root, 'item');
    await writeMod(item, 'BritaWeapons', 'Brita');
    const dataPath = path.join(root, 'data');
    const parsed = entry(zomboidWorkshop).workshop!;

    const copied = await copyModFolders(item, dataPath, parsed);

    expect(copied).toEqual(['BritaWeapons']);
    await expect(fs.access(path.join(dataPath, 'mods', 'BritaWeapons', 'mod.info'))).resolves.toBeUndefined();

    await removeModFolders(dataPath, parsed, copied);
    await expect(fs.access(path.join(dataPath, 'mods', 'BritaWeapons'))).rejects.toThrow();
  });

  it('will not let a folder name walk out of the mods directory', async () => {
    const dataPath = path.join(root, 'data');
    await fs.mkdir(path.join(dataPath, 'Server'), { recursive: true });
    await fs.writeFile(path.join(dataPath, 'Server', 'keep.ini'), 'x', 'utf8');

    await removeModFolders(dataPath, entry(zomboidWorkshop).workshop!, ['../Server', '..', '.']);

    await expect(fs.access(path.join(dataPath, 'Server', 'keep.ini'))).resolves.toBeUndefined();
  });
});

describe('the game\'s mod list', () => {
  it('rewrites only the two declared keys', async () => {
    const dataPath = path.join(root, 'data');
    await fs.mkdir(path.join(dataPath, 'Server'), { recursive: true });
    await fs.writeFile(
      path.join(dataPath, 'Server', 'my-server.ini'),
      'DefaultPort=16261\r\nPublicName=Mine\r\nMods=\r\nWorkshopItems=\r\n',
      'utf8',
    );

    const written = await writeWorkshopConfig(
      entry(zomboidWorkshop),
      { slug: 'my-server', dataPath },
      { itemIds: ['1', '2'], modIds: ['Brita', 'Brita_2'] },
    );

    expect(written).toBe(path.join(dataPath, 'Server', 'my-server.ini'));
    const text = await fs.readFile(written!, 'utf8');
    expect(text).toContain('WorkshopItems=1;2');
    expect(text).toContain('Mods=Brita;Brita_2');
    // Everything somebody spent an evening tuning is still there.
    expect(text).toContain('PublicName=Mine');
    expect(text).toContain('DefaultPort=16261');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('adds the keys when the game has never written them', async () => {
    const dataPath = path.join(root, 'data');
    await fs.mkdir(path.join(dataPath, 'Server'), { recursive: true });
    await fs.writeFile(path.join(dataPath, 'Server', 'my-server.ini'), 'DefaultPort=16261\r\n', 'utf8');

    const written = await writeWorkshopConfig(
      entry(zomboidWorkshop),
      { slug: 'my-server', dataPath },
      { itemIds: ['7'], modIds: ['Seven'] },
    );

    expect(await fs.readFile(written!, 'utf8')).toContain('WorkshopItems=7');
  });

  it('does nothing when the game has no settings file yet', async () => {
    const written = await writeWorkshopConfig(
      entry(zomboidWorkshop),
      { slug: 'my-server', dataPath: path.join(root, 'empty') },
      { itemIds: ['7'], modIds: [] },
    );

    expect(written).toBeNull();
  });
});

describe('downloading an item', () => {
  const success = (to: string) => ({
    exitCode: 0,
    stdout: `Success. Downloaded item 123 to "${to}" (5 bytes)`,
    stderr: '',
    timedOut: false,
    durationMs: 1,
    truncated: false,
  });

  it('asks Steam anonymously first, so no account is needed', async () => {
    const installPath = path.join(root, 'server');
    const destination = workshopItemDirectory(installPath, 108600, '123');
    const invocations: string[][] = [];
    const run = vi.fn(async (options: { args: readonly string[] }) => {
      invocations.push([...options.args]);
      await fs.mkdir(destination, { recursive: true });
      return success(destination);
    });

    const result = await downloadWorkshopItem({
      steamcmdPath: path.join(root, 'bin', 'steamcmd.exe'),
      installPath,
      appId: 108600,
      publishedFileId: '123',
      anonymous: true,
      credentials: { username: 'operator', password: 'hunter2' },
      run: run as never,
    });

    expect(result).toBe(destination);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual([
      '+force_install_dir', installPath,
      '+login', 'anonymous',
      '+workshop_download_item', '108600', '123',
      '+quit',
    ]);
  });

  /*
   * SteamCMD does not reliably honour force_install_dir for Workshop content.
   * An item left in the shared cache would be one two servers point at, and
   * removing the mod from either would break the other.
   */
  it('moves an item out of the shared cache into the server\'s own tree', async () => {
    const installPath = path.join(root, 'server');
    const shared = path.join(root, 'bin', 'steamapps', 'workshop', 'content', '108600', '123');
    const run = vi.fn(async () => {
      await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(path.join(shared, 'mod.info'), 'id=Shared\n', 'utf8');
      return success(shared);
    });

    const result = await downloadWorkshopItem({
      steamcmdPath: path.join(root, 'bin', 'steamcmd.exe'),
      installPath,
      appId: 108600,
      publishedFileId: '123',
      anonymous: true,
      credentials: null,
      run: run as never,
    });

    expect(result).toBe(workshopItemDirectory(installPath, 108600, '123'));
    await expect(fs.access(path.join(result, 'mod.info'))).resolves.toBeUndefined();
    await expect(fs.access(shared)).rejects.toThrow();
  });

  it('falls back to the operator account when Steam refuses an anonymous download', async () => {
    const installPath = path.join(root, 'server');
    const destination = workshopItemDirectory(installPath, 108600, '123');
    const invocations: string[][] = [];
    const run = vi.fn(async (options: { args: readonly string[] }) => {
      invocations.push([...options.args]);
      if (invocations.length === 1) {
        return {
          exitCode: 1,
          stdout: 'ERROR! Download item 123 failed (Failure).',
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        };
      }
      await fs.mkdir(destination, { recursive: true });
      return success(destination);
    });

    const result = await downloadWorkshopItem({
      steamcmdPath: path.join(root, 'bin', 'steamcmd.exe'),
      installPath,
      appId: 108600,
      publishedFileId: '123',
      anonymous: true,
      credentials: { username: 'operator', password: 'hunter2' },
      run: run as never,
    });

    expect(result).toBe(destination);
    expect(invocations[0]).toContain('anonymous');
    expect(invocations[1]).toContain('operator');
  });

  it('says an account is needed rather than failing silently', async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: 'ERROR! Download item 123 failed (Failure).',
      stderr: '',
      timedOut: false,
      durationMs: 1,
      truncated: false,
    }));

    await expect(
      downloadWorkshopItem({
        steamcmdPath: path.join(root, 'bin', 'steamcmd.exe'),
        installPath: path.join(root, 'server'),
        appId: 108600,
        publishedFileId: '123',
        anonymous: true,
        credentials: null,
        run: run as never,
      }),
    ).rejects.toThrow(WorkshopError);
  });

  /*
   * The customer adding a mod is following this in a job log. The account
   * doing the signing in belongs to whoever runs the panel, and is the same
   * one for every customer on the machine.
   */
  it('keeps the operator\'s Steam account out of the log and the error', async () => {
    const lines: string[] = [];
    const run = vi.fn(async (options: { onOutput?: (line: string) => void }) => {
      options.onOutput?.("Logging in user 'winpanel_host' to Steam Public...");
      return {
        exitCode: 1,
        stdout:
          "Logging in user 'winpanel_host' to Steam Public...\n" +
          "ERROR! Download item 123 failed (Access Denied) for user 'winpanel_host'.",
        stderr: '',
        timedOut: false,
        durationMs: 1,
        truncated: false,
      };
    });

    const failure = await downloadWorkshopItem({
      steamcmdPath: path.join(root, 'bin', 'steamcmd.exe'),
      installPath: path.join(root, 'server'),
      appId: 108600,
      publishedFileId: '123',
      anonymous: false,
      credentials: { username: 'winpanel_host', password: 'operator-password' },
      onOutput: (line) => lines.push(line),
      run: run as never,
    }).catch((error: Error) => error);

    const everything = [...lines, (failure as Error).message].join('\n');
    expect(everything).not.toMatch(/winpanel_host/i);
    expect(everything).not.toContain('operator-password');
    expect(everything).toContain('Access Denied');
  });
});
