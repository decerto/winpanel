import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { mailHostnameFor } from '@winpanel/shared';
import { config, paths } from './config.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from './db/index.js';
import { JobQueue } from './jobs/queue.js';
import { SecretVault } from './security/vault.js';
import { AuthService } from './services/auth-service.js';
import { CaddyClient } from './caddy/client.js';
import { CaddyReconciler } from './caddy/reconciler.js';
import { ServiceManager } from './windows/service-manager.js';
import { FirewallManager } from './bootstrap/windows-setup.js';
import { createServiceRecovery } from './windows/watched-services.js';
import { SiteService } from './sites/site-service.js';
import { GameServerService } from './game-servers/game-server-service.js';
import { createInstallGameServerHandler } from './game-servers/install-handler.js';
import { loadGameServerCatalogue } from './game-servers/catalogue-loader.js';
import { TrafficCollector } from './traffic/collector.js';
import { createDeployHandler } from './sites/deploy-handler.js';
import { createRunCommandHandler } from './sites/command-runner.js';
import {
  createInstallComponentHandler,
  createUninstallComponentHandler,
} from './components/installer.js';
import { createPanelUpdateHandler } from './components/panel-update.js';
import { createWordPressHandler } from './sites/wordpress.js';
import { resolveToolInvocation } from './sites/tool-paths.js';
import type { PanelTls } from './tls/panel-certificate.js';

/**
 * Composition root.
 *
 * Everything is constructed once here and passed explicitly, so tests can
 * build an isolated instance against a temporary directory rather than
 * reaching for module-level singletons.
 */
export interface AppContext {
  config: typeof config;
  db: DatabaseHandle;
  schema: typeof schema;
  vault: SecretVault;
  auth: AuthService;
  jobs: JobQueue;
  caddy: CaddyClient;
  /** Pushes the panel's view of what should be served into Caddy. */
  routing: CaddyReconciler;
  services: ServiceManager;
  sites: SiteService;
  gameServers: GameServerService;
  /** Counts the web server's access logs into per-website traffic figures. */
  traffic: TrafficCollector;
  /**
   * Re-reads the panel's own certificate and swaps it into the live listener.
   *
   * Set by `createServer`, so it is absent in tests that never start one and
   * null when the panel is running without HTTPS.
   */
  refreshPanelCertificate?: () => Promise<PanelTls | null>;
  shutdown: () => Promise<void>;
}

export interface CreateAppOptions {
  /** Overrides the database path. Tests pass a temporary file. */
  databasePath?: string;
  vaultKeyPath?: string;
  setupTokenPath?: string;
  migrationsFolder?: string;
  /** Skips registering job handlers, for tests that only exercise the API. */
  registerJobHandlers?: boolean;
  /** Seeds invented demo data for screenshots, without touching a real install. */
  demoSeed?: boolean;
}

export async function createAppContext(options: CreateAppOptions = {}): Promise<AppContext> {
  const databasePath = options.databasePath ?? paths.database();
  const migrationsFolder =
    options.migrationsFolder ?? path.join(import.meta.dirname, '..', 'drizzle');

  const db = createDatabase(databasePath);
  migrateDatabase(db, migrationsFolder);

  const vault = new SecretVault(options.vaultKeyPath ?? paths.vaultKey());
  await vault.initialise();

  const auth = new AuthService(db, vault, options.setupTokenPath ?? paths.setupToken());

  const jobs = new JobQueue(db);
  // Anything left `running` when the process died is not running now.
  jobs.reconcileOrphans();

  const caddy = new CaddyClient();
  const routing = new CaddyReconciler(
    db,
    caddy,
    config.sitesRoot,
    vault,
    config.accessLogDir,
    config.customCertDir,
  );
  const services = new ServiceManager(
    path.join(config.binDir, 'WinSW.exe'),
    path.join(config.dataDir, 'services'),
    createServiceRecovery(db),
  );
  const firewall = process.platform === 'win32' ? new FirewallManager() : undefined;
  const sites = new SiteService(db, vault, config.sitesRoot);

  /*
   * The game catalog is data, not code. The repo seed set ships with the
   * installer; the data folder is where an administrator drops or overrides
   * configs without a rebuild. Seeding copies the built-ins over only what
   * is missing, so a local edit survives a panel update.
   *
   * The repo catalog path is resolved relative to this file rather than the
   * install root, so it works the same whether the agent runs from source or
   * from the built output.
   */
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const gameCatalogueRepo = path.join(moduleDir, '..', '..', '..', 'game-servers', 'catalogue');
  const gameCatalogueData = path.join(config.dataDir, 'game-servers', 'catalogue');
  await seedGameServerCatalogue(gameCatalogueRepo, gameCatalogueData);
  const { entries: gameCatalogue } = await loadGameServerCatalogue(gameCatalogueRepo, gameCatalogueData);
  const gameServers = new GameServerService(db, config.gameServersRoot, gameCatalogue);
  const traffic = new TrafficCollector({ db, accessLogDir: config.accessLogDir });

  if (options.demoSeed) {
    await seedDemoGameServers(db, gameServers, config.gameServersRoot);
  }

  if (options.registerJobHandlers !== false) {
    jobs.register(
      'deploy',
      createDeployHandler({
        db,
        caddy,
        routing,
        services,
        tools: { resolve: resolveToolInvocation },
        gitPath: path.join(config.binDir, 'git', 'cmd', 'git.exe'),
        sitesRoot: config.sitesRoot,
        binDir: config.binDir,
        loadEnv: (siteId) => sites.getEnv(siteId),
        loadGitToken: (siteId) => sites.getGitToken(siteId),
        loadGitSshKey: (siteId) => sites.getGitSshKey(siteId),
        sshKnownHostsPath: path.join(config.dataDir, 'ssh', 'known_hosts'),
      }),
    );

    jobs.register(
      'run-command',
      createRunCommandHandler({
        db,
        tools: { resolve: resolveToolInvocation },
        sitesRoot: config.sitesRoot,
        loadEnv: (siteId) => sites.getEnv(siteId),
      }),
    );

    const installerDeps = {
      db,
      vault,
      services,
      binDir: config.binDir,
      dataDir: config.dataDir,
      logDir: config.logDir,
      caddyDir: config.caddyDir,
      agentDistDir: import.meta.dirname,
      // The mail server has to call itself something before any domain is
      // pointed at it, so it starts as the machine's own name.
      mailHostname: () => {
        const first = sites.list().find((site) => (site.domains as string[]).length > 0);
        const domain = (first?.domains as string[] | undefined)?.[0];
        return domain ? mailHostnameFor(domain) : os.hostname();
      },
    };

    jobs.register('install-component', createInstallComponentHandler(installerDeps));
    jobs.register('uninstall-component', createUninstallComponentHandler(installerDeps));
    jobs.register(
      'install-wordpress',
      createWordPressHandler({
        db,
        vault,
        routing,
        binDir: config.binDir,
        sitesRoot: config.sitesRoot,
        publish: (siteId) => {
          jobs.enqueue({
            kind: 'deploy',
            title: 'Publishing your website',
            payload: { siteId },
            siteId,
          });
        },
      }),
    );
    jobs.register(
      'update-panel',
      createPanelUpdateHandler({ binDir: config.binDir, logDir: config.logDir }),
    );
    jobs.register(
      'install-game-server',
      createInstallGameServerHandler({ db, binDir: config.binDir, services, firewall, vault, catalogue: gameCatalogue }),
    );
    jobs.register(
      'update-game-server',
      createInstallGameServerHandler({ db, binDir: config.binDir, services, firewall, vault, catalogue: gameCatalogue }),
    );
    jobs.register(
      'reinstall-game-server',
      createInstallGameServerHandler({ db, binDir: config.binDir, services, firewall, vault, catalogue: gameCatalogue }),
    );
  }

  return {
    config,
    db,
    schema,
    vault,
    auth,
    jobs,
    caddy,
    routing,
    services,
    sites,
    gameServers,
    traffic,
    shutdown: async () => {
      await jobs.stop();
      traffic.stop();
      vault.lock();
      db.close();
    },
  };
}

/**
 * Copies the built-in configs into the data folder where they are missing.
 *
 * The repo directory is the truth for a fresh install; the data directory is
 * what the running panel reads, because that is where an administrator can
 * drop a new game or override a shipped one without a rebuild. Only files
 * that do not already exist are written, so a local edit is not trampled by
 * the next update.
 */
async function seedGameServerCatalogue(repoDir: string, dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const files = await fs.readdir(repoDir);
    for (const file of files.filter((name) => name.toLowerCase().endsWith('.json'))) {
      const target = path.join(dataDir, file);
      if (await fs.access(target).then(() => true, () => false)) continue;
      await fs.copyFile(path.join(repoDir, file), target);
    }
  } catch {
    // The repo folder may not exist in a packaged install that ships its own
    // set; a missing seed is not a startup failure.
  }
}

/**
 * Seeds invented game servers for screenshots.
 *
 * The images in the docs are rendered from this data, so they show the real
 * UI rather than a mockup. Nothing here touches a real install: the database,
 * the folders, and the panel all live in the temp directory the caller
 * deletes afterwards.
 */
async function seedDemoGameServers(
  db: DatabaseHandle,
  gameServers: GameServerService,
  gameServersRoot: string,
): Promise<void> {
  // The feature flag is what makes the nav entry appear; without it the
  // screenshots would show a panel that looks like it has no game servers.
  db.db
    .insert(schema.settings)
    .values({ key: 'gameServers.enabled', value: true, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: true, updatedAt: new Date() },
    })
    .run();

  for (const demo of DEMO_SERVERS) {
    const server = await gameServers.create(
      { displayName: demo.displayName, catalogId: demo.catalogId, eulaAccepted: true },
      null,
    );
    await fs.mkdir(server.dataPath, { recursive: true });
    // The demo state is what the screenshot shows, not what the service would
    // report on a real machine.
    await fs.mkdir(path.join(gameServersRoot, server.slug), { recursive: true });
    // The screenshots show a running server with a version, so the demo data
    // sets both after creation. A real install would set them during the
    // install job.
    db.db
      .update(schema.gameServers)
      .set({ state: demo.state, version: demo.version })
      .where(eq(schema.gameServers.id, server.id))
      .run();
  }
}

const DEMO_SERVERS = [
  {
    displayName: 'Nomad',
    catalogId: 'nomad-dedicated',
    state: 'running' as const,
    version: '1.0.0',
  },
  {
    displayName: 'Palworld',
    catalogId: 'palworld-dedicated',
    state: 'running' as const,
    version: 'latest',
  },
  {
    displayName: 'Project Zomboid',
    catalogId: 'zomboid-dedicated',
    state: 'stopped' as const,
    version: '42.20.0',
  },
];
