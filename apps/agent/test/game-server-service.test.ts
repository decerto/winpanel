import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { GameServerError, GameServerService } from '../src/game-servers/game-server-service.js';
import { loadGameServerCatalogue } from '../src/game-servers/catalogue-loader.js';
import { AuthService } from '../src/services/auth-service.js';
import { SecretVault } from '../src/security/vault.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const CATALOGUE = path.join(import.meta.dirname, '..', '..', '..', 'game-servers', 'catalogue');
const PASSWORD = 'a-password-long-enough';

let tmpDir: string;
let handle: DatabaseHandle;
let service: GameServerService;
let auth: AuthService;
let catalogue: Awaited<ReturnType<typeof loadGameServerCatalogue>>['entries'];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-game-servers-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  catalogue = (await loadGameServerCatalogue(CATALOGUE, path.join(tmpDir, 'catalogue-data'))).entries;
  service = new GameServerService(handle, path.join(tmpDir, 'servers'), catalogue);

  const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
  auth = new AuthService(handle, vault, path.join(tmpDir, 'setup-token.txt'));
  const setupToken = await auth.ensureSetupToken();
  await auth.completeSetup({ setupToken, username: 'owner', password: PASSWORD });
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('game-server creation policy', () => {
  it('limits a customer to one selected game', async () => {
    const customer = await auth.createUser({
      username: 'freya',
      password: PASSWORD,
      role: 'user',
      gameServerLimit: 1,
      gameServerProviders: ['minecraft-java-vanilla'],
    });

    const created = await service.create(
      {
        displayName: 'Freya Java',
        catalogId: 'minecraft-java-vanilla',
        eulaAccepted: true,
      },
      customer.id,
    );

    expect(created.ownerUserId).toBe(customer.id);
    expect(service.listForUser(customer.id)).toHaveLength(1);

    await expect(
      service.create(
        {
          displayName: 'Freya Second',
          catalogId: 'minecraft-java-vanilla',
          eulaAccepted: true,
        },
        customer.id,
      ),
    ).rejects.toMatchObject({ name: 'GameServerError' });

    await expect(
      service.create(
        {
          displayName: 'Freya Bedrock',
          catalogId: 'minecraft-bedrock-vanilla',
          eulaAccepted: true,
        },
        customer.id,
      ),
    ).rejects.toMatchObject({ name: 'GameServerError' });
  });

  it('allows any supported game when the provider scope is empty', async () => {
    const customer = await auth.createUser({
      username: 'sam',
      password: PASSWORD,
      role: 'user',
      gameServerLimit: 1,
      gameServerProviders: [],
    });

    const created = await service.create(
      {
        displayName: 'Sam Bedrock',
        catalogId: 'minecraft-bedrock-vanilla',
        eulaAccepted: true,
      },
      customer.id,
    );

    expect(created.catalogId).toBe('minecraft-bedrock-vanilla');
  });

  it('requires an EULA acknowledgement for catalog entries that need one', async () => {
    await expect(
      service.create(
        {
          displayName: 'No Eula',
          catalogId: 'minecraft-java-vanilla',
          eulaAccepted: false,
        },
        null,
      ),
    ).rejects.toBeInstanceOf(GameServerError);
  });

  it('rejects a catalog entry that is not in the installed set', async () => {
    await expect(
      service.create(
        {
          displayName: 'Coming Soon',
          catalogId: 'valheim-planned',
          eulaAccepted: true,
        },
        null,
      ),
    ).rejects.toThrow(/not supported/i);
  });
});

describe('game-server access', () => {
  it('shows an assigned server without exposing other servers', async () => {
    const first = await auth.createUser({ username: 'first', password: PASSWORD, role: 'user' });
    const second = await auth.createUser({ username: 'second', password: PASSWORD, role: 'user' });

    const server = await service.create(
      {
        displayName: 'Shared server',
        catalogId: 'minecraft-java-vanilla',
        eulaAccepted: true,
      },
      null,
    );
    const other = await service.create(
      {
        displayName: 'Private server',
        catalogId: 'minecraft-bedrock-vanilla',
        eulaAccepted: true,
      },
      first.id,
    );

    expect(service.getVisible(server.slug, second.id)).toBeUndefined();
    service.assign(server.slug, second.id);
    expect(service.getVisible(server.slug, second.id)?.id).toBe(server.id);
    expect(service.getVisible(other.slug, second.id)).toBeUndefined();

    service.unassign(server.slug, second.id);
    expect(service.getVisible(server.slug, second.id)).toBeUndefined();
  });
});
