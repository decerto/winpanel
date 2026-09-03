import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineContext } from '../src/databases/types.js';

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  findExecutable: vi.fn(async (_directory: string, names: readonly string[]) =>
    names.includes('psql.exe') ? 'psql.exe' : names.includes('mongod.exe') ? 'mongod.exe' : 'mariadb.exe',
  ),
  readRootPassword: vi.fn(() => 'root-secret'),
}));

const mongoState = vi.hoisted(() => ({
  databaseName: 'wp_mongo',
  collections: new Map<string, { documents: unknown[] }>(),
  commands: [] as Array<{ database: string; command: Record<string, unknown> }>,
  temporaryCollections: new Set<string>(),
  failRename: false,
  failRenameAt: null as number | null,
  renameCount: 0,
}));

vi.mock('../src/process/run-command.js', () => ({ runCommand: mocks.runCommand }));
vi.mock('../src/components/archive.js', () => ({ findExecutable: mocks.findExecutable }));
vi.mock('../src/databases/secrets.js', () => ({ readRootPassword: mocks.readRootPassword }));
vi.mock('mongodb', () => {
  class FakeCollection {
    constructor(private readonly name: string) {}

    async insertMany(documents: unknown[]): Promise<void> {
      if (this.name.startsWith('__winpanel_restore_')) mongoState.temporaryCollections.add(this.name);
      const collection = mongoState.collections.get(this.name) ?? { documents: [] };
      collection.documents.push(...documents);
      mongoState.collections.set(this.name, collection);
    }

    async drop(): Promise<void> {
      mongoState.collections.delete(this.name);
    }

    async rename(name: string): Promise<void> {
      mongoState.renameCount += 1;
      if (mongoState.failRename || mongoState.renameCount === mongoState.failRenameAt) {
        mongoState.failRename = false;
        mongoState.failRenameAt = null;
        throw new Error('rename failed');
      }
      const collection = mongoState.collections.get(this.name);
      if (!collection) throw new Error(`Missing collection ${this.name}`);
      mongoState.collections.delete(this.name);
      mongoState.collections.set(name, collection);
    }
  }

  class FakeDatabase {
    constructor(private readonly name: string) {}

    admin() {
      return {
        listDatabases: async () => ({
          databases: [{ name: mongoState.databaseName }],
        }),
      };
    }

    async command(command: Record<string, unknown>): Promise<Record<string, unknown>> {
      mongoState.commands.push({ database: this.name, command });
      if ('usersInfo' in command) return { users: [{ user: command.usersInfo }] };
      return {};
    }

    listCollections() {
      return {
        toArray: async () => [...mongoState.collections.keys()].map((name) => ({ name })),
      };
    }

    collection(name: string): FakeCollection {
      return new FakeCollection(name);
    }
  }

  class FakeMongoClient {
    db(name: string): FakeDatabase {
      return new FakeDatabase(name);
    }

    async close(): Promise<void> {}
  }

  return { MongoClient: FakeMongoClient };
});

import { mariadbAdapter } from '../src/databases/mariadb.js';
import { mongodbAdapter } from '../src/databases/mongodb.js';
import { postgresAdapter } from '../src/databases/postgres.js';

interface CommandCall {
  exe: string;
  args: readonly string[];
  stdinFile?: string;
}

function result(stdout = '', exitCode = 0, stderr = '') {
  return {
    exitCode,
    stdout,
    stderr,
    timedOut: false,
    durationMs: 1,
    truncated: false,
  };
}

function sqlFrom(call: CommandCall): string {
  return call.args[call.args.length - 1] ?? '';
}

function context(): EngineContext {
  return { binDir: 'C:/winpanel/bin', db: undefined, vault: undefined } as unknown as EngineContext;
}

beforeEach(() => {
  mocks.runCommand.mockReset();
  mongoState.databaseName = 'wp_mongo';
  mongoState.collections = new Map();
  mongoState.commands.length = 0;
  mongoState.temporaryCollections.clear();
  mongoState.failRename = false;
  mongoState.failRenameAt = null;
  mongoState.renameCount = 0;
});

describe('MariaDB replacement restore', () => {
  it('preserves every existing login host while replacing the schema', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      const sql = sqlFrom(call);
      if (sql.includes('SELECT Host')) return result('127.0.0.1\nlocalhost\n203.0.113.10\n%\n');
      if (sql.includes('INFORMATION_SCHEMA.SCHEMATA')) return result('wp_maria\n');
      return result();
    });

    await mariadbAdapter.importDump(context(), { name: 'wp_maria', username: 'wp_maria' }, 'dump.sql');

    const replacement = calls.find((call) => sqlFrom(call).includes('DROP DATABASE'));
    expect(replacement).toBeDefined();
    expect(sqlFrom(replacement!)).toContain("TO 'wp_maria'@'127.0.0.1'");
    expect(sqlFrom(replacement!)).toContain("TO 'wp_maria'@'localhost'");
    expect(sqlFrom(replacement!)).toContain("TO 'wp_maria'@'203.0.113.10'");
    expect(sqlFrom(replacement!)).toContain("TO 'wp_maria'@'%'");

    const importCall = calls.find((call) => call.stdinFile === 'dump.sql');
    expect(importCall).toMatchObject({ stdinFile: 'dump.sql' });
    expect(calls.indexOf(replacement!)).toBeLessThan(calls.indexOf(importCall!));
  });

  it('restores the previous schema when importing the replacement fails', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      const sql = sqlFrom(call);
      if (sql.includes('SELECT Host')) return result('127.0.0.1\n');
      if (sql.includes('INFORMATION_SCHEMA.SCHEMATA')) return result('wp_maria\n');
      if (call.stdinFile === 'dump.sql') return result('', 1, 'bad dump');
      return result();
    });

    await expect(
      mariadbAdapter.importDump(context(), { name: 'wp_maria', username: 'wp_maria' }, 'dump.sql'),
    ).rejects.toThrow(/could not restore wp_maria/i);

    expect(calls.some((call) => call.args.some((arg) => arg.includes('--result-file=')))).toBe(true);
    expect(calls.filter((call) => call.stdinFile && call.stdinFile !== 'dump.sql')).toHaveLength(1);
  });

  it('refuses to replace a schema when its login is missing', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      return result();
    });

    await expect(
      mariadbAdapter.importDump(context(), { name: 'wp_maria', username: 'wp_maria' }, 'dump.sql'),
    ).rejects.toThrow(/login wp_maria is missing/i);
    expect(calls.some((call) => sqlFrom(call).includes('DROP DATABASE'))).toBe(false);
  });

  it('refuses to replace a schema when the database is missing', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      const sql = sqlFrom(call);
      if (sql.includes('SELECT Host')) return result('127.0.0.1\n');
      return result();
    });

    await expect(
      mariadbAdapter.importDump(context(), { name: 'wp_maria', username: 'wp_maria' }, 'dump.sql'),
    ).rejects.toThrow(/database wp_maria is missing/i);
    expect(calls.some((call) => sqlFrom(call).includes('DROP DATABASE'))).toBe(false);
  });
});

describe('PostgreSQL replacement restore', () => {
  it('drops stale contents, recreates the database privileges, then imports the dump', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      const text = call.args.join(' ');
      if (text.includes('pg_roles')) return result('1\n');
      if (text.includes('pg_database')) return result('1\n');
      return result();
    });

    await postgresAdapter.importDump(context(), { name: 'wp_postgres', username: 'wp_postgres' }, 'dump.sql');

    const dropIndex = calls.findIndex((call) => call.args.some((arg) => arg.includes('DROP DATABASE')));
    const createIndex = calls.findIndex((call) => call.args.some((arg) => arg.includes('CREATE DATABASE')));
    const importIndex = calls.findIndex((call) => call.args.some((arg) => arg === '--file=dump.sql'));
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
    expect(importIndex).toBeGreaterThan(createIndex);

    const recreate = calls[createIndex]!;
    expect(recreate.args.join(' ')).toContain('REVOKE ALL ON DATABASE');
    expect(recreate.args.join(' ')).toContain('GRANT ALL ON DATABASE');
  });

  it('restores the previous database when importing the replacement fails', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      const text = call.args.join(' ');
      if (text.includes('pg_roles')) return result('1\n');
      if (text.includes('pg_database')) return result('1\n');
      if (call.args.includes('--file=dump.sql')) return result('', 1, 'bad dump');
      return result();
    });

    await expect(
      postgresAdapter.importDump(context(), { name: 'wp_postgres', username: 'wp_postgres' }, 'dump.sql'),
    ).rejects.toThrow(/could not restore wp_postgres/i);

    expect(
      calls.filter((call) =>
        call.args.some((arg) => arg.startsWith('--file=') && arg !== '--file=dump.sql'),
      ),
    ).toHaveLength(2);
  });

  it('refuses to replace a database when its role is missing', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      return result();
    });

    await expect(
      postgresAdapter.importDump(context(), { name: 'wp_postgres', username: 'wp_postgres' }, 'dump.sql'),
    ).rejects.toThrow(/login wp_postgres is missing/i);
    expect(calls.some((call) => call.args.some((arg) => arg.includes('DROP DATABASE')))).toBe(false);
  });

  it('refuses to replace a database when the database itself is missing', async () => {
    const calls: CommandCall[] = [];
    mocks.runCommand.mockImplementation(async (call: CommandCall) => {
      calls.push(call);
      return result(call.args.join(' ').includes('pg_roles') ? '1\n' : '');
    });

    await expect(
      postgresAdapter.importDump(context(), { name: 'wp_postgres', username: 'wp_postgres' }, 'dump.sql'),
    ).rejects.toThrow(/database wp_postgres is missing/i);
    expect(calls.some((call) => call.args.some((arg) => arg.includes('DROP DATABASE')))).toBe(false);
  });
});

describe('MongoDB replacement restore', () => {
  async function makeDump(): Promise<{ directory: string; file: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'winpanel-mongodb-'));
    const file = path.join(directory, 'backup.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ format: 'winpanel-mongodb-json', database: 'wp_mongo' }),
        JSON.stringify({ collection: 'keep', document: { value: 'new' } }),
        JSON.stringify({ collection: 'keep', document: { value: 'second' } }),
        JSON.stringify({ collection: 'fresh', document: { value: 'fresh' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    return { directory, file };
  }

  it('removes stale collections, preserves the user, and imports each collection once', async () => {
    mongoState.collections = new Map([
      ['stale', { documents: [{ value: 'old' }] }],
      ['keep', { documents: [{ value: 'old' }] }],
    ]);
    const dump = await makeDump();

    try {
      await mongodbAdapter.importDump(
        context(),
        { name: 'wp_mongo', username: 'wp_mongo' },
        dump.file,
      );

      expect([...mongoState.collections.keys()].sort()).toEqual(['fresh', 'keep']);
      expect(mongoState.collections.get('keep')?.documents).toEqual([
        { value: 'new' },
        { value: 'second' },
      ]);
      expect(mongoState.collections.get('fresh')?.documents).toEqual([{ value: 'fresh' }]);
      expect(mongoState.temporaryCollections).toHaveLength(2);
      expect(mongoState.commands.filter((entry) => 'usersInfo' in entry.command)).toHaveLength(1);
      expect(mongoState.commands.some((entry) => 'dropUser' in entry.command)).toBe(false);
    } finally {
      await rm(dump.directory, { recursive: true, force: true });
    }
  });

  it('removes temporary collections when a rename fails', async () => {
    mongoState.collections = new Map([['stale', { documents: [{ value: 'old' }] }]]);
    mongoState.failRename = true;
    const dump = await makeDump();

    try {
      await expect(
        mongodbAdapter.importDump(
          context(),
          { name: 'wp_mongo', username: 'wp_mongo' },
          dump.file,
        ),
      ).rejects.toThrow(/rename failed/);
      expect([...mongoState.collections.keys()].every((name) => !name.startsWith('__winpanel_restore_'))).toBe(
        true,
      );
    } finally {
      await rm(dump.directory, { recursive: true, force: true });
    }
  });

  it('restores the previous collections when a swap fails midway', async () => {
    mongoState.collections = new Map([
      ['stale', { documents: [{ value: 'old-stale' }] }],
      ['keep', { documents: [{ value: 'old-keep' }] }],
    ]);
    mongoState.failRenameAt = 3;
    const dump = await makeDump();

    try {
      await expect(
        mongodbAdapter.importDump(
          context(),
          { name: 'wp_mongo', username: 'wp_mongo' },
          dump.file,
        ),
      ).rejects.toThrow(/rename failed/);
      expect([...mongoState.collections.keys()].sort()).toEqual(['keep', 'stale']);
      expect(mongoState.collections.get('keep')?.documents).toEqual([{ value: 'old-keep' }]);
      expect(mongoState.collections.get('stale')?.documents).toEqual([{ value: 'old-stale' }]);
      expect([...mongoState.collections.keys()].every((name) => !name.startsWith('__winpanel_restore_'))).toBe(
        true,
      );
    } finally {
      await rm(dump.directory, { recursive: true, force: true });
    }
  });
});
