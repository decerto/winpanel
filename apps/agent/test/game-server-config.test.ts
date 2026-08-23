import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameServerSeedFile } from '@winpanel/shared';
import {
  expandPlaceholders,
  expandValue,
  PlaceholderError,
  type PlaceholderValues,
} from '../src/game-servers/placeholders.js';
import { resolveSeedPath, setFlatProperty, writeSeedFiles } from '../src/game-servers/seed-files.js';

const values: PlaceholderValues = {
  slug: 'my-server',
  displayName: 'My Server',
  installPath: 'C:\\GameServers\\my-server\\server',
  dataDir: 'C:\\GameServers\\my-server\\server\\profile',
  version: '1.21.1',
  ports: new Map([
    ['game', 16261],
    ['direct', 16262],
    ['query', 16262],
  ]),
  secrets: new Map([['admin-password', 's3cret']]),
  classpath: 'java/a.jar;java/b.jar',
  heapMb: 2560,
};

const seedFile = (overrides: Record<string, unknown>): GameServerSeedFile =>
  GameServerSeedFile.parse(overrides);

describe('catalog placeholders', () => {
  it('expands the tokens a game config can use', () => {
    expect(expandPlaceholders('-servername {slug} -cachedir={dataDir}', values)).toBe(
      '-servername my-server -cachedir=C:\\GameServers\\my-server\\server\\profile',
    );
    expect(expandPlaceholders('-Xmx{heapMb}m', values)).toBe('-Xmx2560m');
    expect(expandPlaceholders('-adminpassword {secret:admin-password}', values)).toBe(
      '-adminpassword s3cret',
    );
  });

  it('resolves ports by the name the config gave them', () => {
    expect(expandPlaceholders('-port {port:game} -udpport {port:direct}', values)).toBe(
      '-port 16261 -udpport 16262',
    );
    // The long-standing shorthand keeps working.
    expect(expandPlaceholders('-port={gamePort}', values)).toBe('-port=16261');
  });

  it('refuses a token the config never declared, rather than passing it through', () => {
    // A typo that silently reached the command line would start a server
    // listening on nothing and look like a networking problem.
    expect(() => expandPlaceholders('-port {port:qeury}', values)).toThrow(PlaceholderError);
    expect(() => expandPlaceholders('{secret:rcon}', values)).toThrow(/"rcon" secret/);
  });

  it('leaves braces that are not ours alone', () => {
    expect(expandPlaceholders('-arg {notatoken}', values)).toBe('-arg {notatoken}');
  });

  it('reports a token this server has no value for', () => {
    const bare: PlaceholderValues = { ...values, heapMb: undefined };
    expect(() => expandPlaceholders('-Xmx{heapMb}m', bare)).toThrow(/\{heapMb\}/);
  });

  it('keeps a port a number when it is the whole value', () => {
    expect(expandValue('{port:game}', values)).toBe(16261);
    expect(expandValue('port {port:game}', values)).toBe('port 16261');
    expect(expandValue(true, values)).toBe(true);
    expect(expandValue(30, values)).toBe(30);
  });
});

describe('flat property editing', () => {
  it('replaces a key without disturbing the rest of the file', () => {
    const text = 'motd=Hello\nserver-port=25565\nmax-players=20';
    expect(setFlatProperty(text, 'server-port', '25570')).toBe(
      'motd=Hello\nserver-port=25570\nmax-players=20',
    );
  });

  it('appends a key the file does not have yet', () => {
    expect(setFlatProperty('motd=Hello', 'server-port', '25565')).toBe('motd=Hello\nserver-port=25565');
  });
});

describe('seed files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-seed-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a path that escapes the server folder', () => {
    // Catalog files are contributed content, so this is the boundary that
    // stops one writing anywhere the agent can reach.
    expect(() => resolveSeedPath(dir, '..\\..\\evil.ini')).toThrow(/inside the server/);
    expect(() => resolveSeedPath(dir, 'C:\\Windows\\System32\\evil.ini')).toThrow(/inside the server/);
    expect(resolveSeedPath(dir, 'Server/name.ini')).toBe(path.join(dir, 'Server', 'name.ini'));
  });

  it('writes an ini with CRLF and expands the path', async () => {
    await writeSeedFiles(
      [
        seedFile({
          path: 'Server/{slug}.ini',
          format: 'ini',
          eol: 'crlf',
          values: { DefaultPort: '{port:game}', Public: true, PublicName: '{displayName}' },
        }),
      ],
      dir,
      values,
    );

    const text = await fs.readFile(path.join(dir, 'Server', 'my-server.ini'), 'utf8');
    expect(text).toBe('DefaultPort=16261\r\nPublic=true\r\nPublicName=My Server\r\n');
  });

  it('merges into a file the game already owns', async () => {
    await fs.writeFile(path.join(dir, 'server.properties'), 'motd=Hi\nserver-port=25565\n');

    await writeSeedFiles(
      [seedFile({ path: 'server.properties', format: 'properties', mode: 'merge', values: { 'server-port': '{port:game}' } })],
      dir,
      values,
    );

    const text = await fs.readFile(path.join(dir, 'server.properties'), 'utf8');
    expect(text).toBe('motd=Hi\nserver-port=16261\n');
  });

  it('leaves a hand-edited config alone on reinstall', async () => {
    const target = path.join(dir, 'Config', 'config.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{"serverPort": 1234, "maxPlayers": 99}');

    const outcomes = await writeSeedFiles(
      [seedFile({ path: 'Config/config.json', format: 'json', mode: 'create', values: { serverPort: '{port:game}' } })],
      dir,
      values,
    );

    expect(outcomes[0]?.written).toBe(false);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toMatchObject({ maxPlayers: 99, serverPort: 1234 });
  });

  it('writes JSON with ports as numbers, not strings', async () => {
    await writeSeedFiles(
      [seedFile({ path: 'Config/config.json', format: 'json', values: { serverPort: '{port:game}', kits: false, serverName: '{displayName}' } })],
      dir,
      values,
    );

    expect(JSON.parse(await fs.readFile(path.join(dir, 'Config', 'config.json'), 'utf8'))).toEqual({
      serverPort: 16261,
      kits: false,
      serverName: 'My Server',
    });
  });

  it('writes a plain text file such as an EULA', async () => {
    await writeSeedFiles(
      [seedFile({ path: 'eula.txt', format: 'text', mode: 'merge', content: '# {displayName}\neula=true' })],
      dir,
      values,
    );

    expect(await fs.readFile(path.join(dir, 'eula.txt'), 'utf8')).toBe('# My Server\neula=true\n');
  });
});
