import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  GameServerCreateRequest,
  type GameServerCatalogEntry,
  type GameServerPort,
} from '@winpanel/shared';
import { validateAssignablePort } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import {
  gameServerAccess,
  gameServerPorts,
  gameServers,
  portAllocations,
  users,
} from '../db/schema.js';
import { slugify } from '../sites/site-service.js';
import type { ServiceManager } from '../windows/service-manager.js';
import { FirewallManager } from '../bootstrap/windows-setup.js';
import { removeGameServerFirewall } from './firewall.js';
import { excludedPortRanges, isPortExcluded, isPortFree } from '../checks/server-checks.js';

export class GameServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameServerError';
  }
}

export class GameServerService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly gameServersRoot: string,
    private readonly catalogue: readonly GameServerCatalogEntry[],
  ) {}

  private catalogEntry(id: string): GameServerCatalogEntry | undefined {
    return this.catalogue.find((entry) => entry.id === id);
  }

  /** The loaded catalog, for the router and the count endpoint. */
  catalogueEntries(): readonly GameServerCatalogEntry[] {
    return this.catalogue;
  }

  catalogEntryFor(id: string): GameServerCatalogEntry | undefined {
    return this.catalogEntry(id);
  }

  list(): Array<typeof gameServers.$inferSelect> {
    return this.handle.db.select().from(gameServers).orderBy(gameServers.displayName).all();
  }

  listForUser(userId: string): Array<typeof gameServers.$inferSelect> {
    const assigned = this.handle.db
      .select({ gameServerId: gameServerAccess.gameServerId })
      .from(gameServerAccess)
      .where(eq(gameServerAccess.userId, userId))
      .all()
      .map((row) => row.gameServerId);

    const owned = this.handle.db
      .select()
      .from(gameServers)
      .where(eq(gameServers.ownerUserId, userId))
      .all();

    if (assigned.length === 0) return owned;

    return this.handle.db
      .select()
      .from(gameServers)
      .where(inArray(gameServers.id, [...assigned, ...owned.map((server) => server.id)]))
      .orderBy(gameServers.displayName)
      .all();
  }

  get(slug: string): typeof gameServers.$inferSelect | undefined {
    return this.handle.db.select().from(gameServers).where(eq(gameServers.slug, slug)).get();
  }

  getVisible(slug: string, userId: string): typeof gameServers.$inferSelect | undefined {
    const server = this.get(slug);
    if (!server) return undefined;
    if (server.ownerUserId === userId) return server;

    const access = this.handle.db
      .select({ gameServerId: gameServerAccess.gameServerId })
      .from(gameServerAccess)
      .where(
        and(
          eq(gameServerAccess.gameServerId, server.id),
          eq(gameServerAccess.userId, userId),
        ),
      )
      .get();

    return access ? server : undefined;
  }

  async create(input: GameServerCreateRequest, ownerUserId: string | null): Promise<typeof gameServers.$inferSelect> {
    const catalog = this.catalogEntry(input.catalogId);
    if (!catalog) throw new GameServerError('That game server is not supported on this server.');
    if (catalog.status !== 'ready') {
      throw new GameServerError(`${catalog.name} is not ready to install yet.`);
    }
    if (catalog.requiresEula && !input.eulaAccepted) {
      throw new GameServerError('You must accept the game server EULA before installing it.');
    }

    if (ownerUserId) this.assertCreationAllowed(ownerUserId, catalog);

    const id = crypto.randomUUID();
    const slug = this.uniqueSlug(input.displayName);
    const root = path.join(this.gameServersRoot, slug);
    const installPath = path.join(root, 'server');
    const dataPath = path.join(root, 'data');

    await fs.mkdir(installPath, { recursive: true });
    await fs.mkdir(dataPath, { recursive: true });

    try {
      const used = new Set<number>([
        ...this.handle.db.select({ port: gameServerPorts.port }).from(gameServerPorts).all().map((row) => row.port),
        ...this.handle.db.select({ port: portAllocations.port }).from(portAllocations).all().map((row) => row.port),
      ]);
      const allocatedPorts: Array<typeof gameServerPorts.$inferInsert> = [];
      for (const port of catalog.ports) {
        const allocated = await this.allocatePort(port, used);
        used.add(allocated);
        allocatedPorts.push({ ...port, id: crypto.randomUUID(), gameServerId: id, port: allocated });
      }

      this.handle.db.transaction((tx) => {
        tx.insert(gameServers)
          .values({
            id,
            slug,
            displayName: input.displayName,
            ownerUserId,
            catalogId: catalog.id,
            version: input.version?.trim() || null,
            installPath,
            dataPath,
            diskQuotaBytes: 50 * 1024 ** 3,
            eulaAccepted: input.eulaAccepted,
          })
          .run();

        tx.insert(gameServerPorts).values(allocatedPorts).run();
      });
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }

    const created = this.get(slug);
    if (!created) throw new GameServerError('The game server could not be created.');
    return created;
  }

  assign(slug: string, userId: string): void {
    const server = this.get(slug);
    if (!server) throw new GameServerError('That game server was not found.');

    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new GameServerError('That account was not found.');

    this.handle.db
      .insert(gameServerAccess)
      .values({ gameServerId: server.id, userId })
      .onConflictDoNothing()
      .run();
  }

  unassign(slug: string, userId: string): void {
    const server = this.get(slug);
    if (!server) throw new GameServerError('That game server was not found.');

    this.handle.db
      .delete(gameServerAccess)
      .where(
        and(
          eq(gameServerAccess.gameServerId, server.id),
          eq(gameServerAccess.userId, userId),
        ),
      )
      .run();
  }

  async remove(
    slug: string,
    services?: ServiceManager,
    firewall?: FirewallManager,
  ): Promise<void> {
    const server = this.get(slug);
    if (!server) throw new GameServerError('That game server was not found.');

    const ports = this.handle.db
      .select()
      .from(gameServerPorts)
      .where(eq(gameServerPorts.gameServerId, server.id))
      .all();

    if (services && server.serviceId) await services.uninstall(server.serviceId);
    if (firewall) await removeGameServerFirewall(firewall, server.slug, ports);

    this.handle.db.delete(gameServers).where(eq(gameServers.id, server.id)).run();
    await fs.rm(path.dirname(server.installPath), { recursive: true, force: true });
  }

  private assertCreationAllowed(userId: string, catalog: GameServerCatalogEntry): void {
    const user = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new GameServerError('That account was not found.');

    const limit = user.gameServerLimit;
    const used = this.handle.db
      .select({ id: gameServers.id })
      .from(gameServers)
      .where(eq(gameServers.ownerUserId, userId))
      .all().length;

    if (limit !== null && used >= limit) {
      throw new GameServerError(
        `This account has reached its limit of ${limit} game server${limit === 1 ? '' : 's'}.`,
      );
    }

    const providers = (user.gameServerProviders as string[]) ?? [];
    if (providers.length > 0 && !providers.includes(catalog.id) && !providers.includes(catalog.provider)) {
      throw new GameServerError('This account is not allowed to create that game server.');
    }
  }

  private uniqueSlug(displayName: string): string {
    const base = slugify(displayName).replace(/^site-/, 'game-');
    let slug = base;
    let suffix = 2;
    while (this.get(slug)) slug = `${base}-${suffix++}`;
    return slug;
  }

  private async allocatePort(port: GameServerPort, used = new Set<number>([
      ...this.handle.db.select({ port: gameServerPorts.port }).from(gameServerPorts).all().map((row) => row.port),
      ...this.handle.db
        .select({ port: portAllocations.port })
        .from(portAllocations)
        .all()
        .map((row) => row.port),
    ])): Promise<number> {
    const excluded = await excludedPortRanges();

    let candidate = port.port;
    while (
      candidate <= 49151 &&
      (!validateAssignablePort(candidate, used).ok ||
        used.has(candidate) ||
        isPortExcluded(candidate, excluded) ||
        !(await isPortFree(candidate, '0.0.0.0')))
    ) candidate++;
    if (candidate > 49151) throw new GameServerError('There are no available ports for this game server.');
    return candidate;
  }
}
