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
import { DatabaseNetworkService } from './databases/network-service.js';
import { firstIpv4 } from './databases/network.js';
import { createServiceRecovery } from './windows/watched-services.js';
import { CADDY_SERVICE_ID, quarantineUnloadableCaddyConfig } from './caddy/service.js';
import { prepareStalwartForWebServer } from './mail/service.js';
import { PanelMailer } from './mail/panel-mailer.js';
import { SiteOutageMonitor } from './mail/site-outage-monitor.js';
import { SiteService } from './sites/site-service.js';
import { GameServerService } from './game-servers/game-server-service.js';
import { createInstallGameServerHandler } from './game-servers/install-handler.js';
import { createInstallWorkshopItemsHandler } from './game-servers/workshop-handler.js';
import { GameServerCatalogue } from './game-servers/catalogue-loader.js';
import { seedGameServerCatalogue } from './game-servers/catalogue-seed.js';
import { TrafficCollector } from './traffic/collector.js';
import { createDeployHandler } from './sites/deploy-handler.js';
import { createRunCommandHandler } from './sites/command-runner.js';
import {
  createInstallComponentHandler,
  createUninstallComponentHandler,
  createUpdatePackageManagerHandler,
} from './components/installer.js';
import { createPanelUpdateHandler } from './components/panel-update.js';
import { createWordPressHandler } from './sites/wordpress.js';
import { resolveToolInvocation } from './sites/tool-paths.js';
import { localAddresses, type PanelTls } from './tls/panel-certificate.js';
import { BackupScheduler, createBackupHandler } from './backups/service.js';
import {
  migrateLegacyCloudflareToken,
  type LegacyCloudflareTokenMigration,
} from './dns/token.js';

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
  mailer: PanelMailer;
  /** Checks hosted websites independently of panel requests and sends transition alerts. */
  outageMonitor: SiteOutageMonitor;
  jobs: JobQueue;
  backupScheduler: BackupScheduler;
  caddy: CaddyClient;
  /** Pushes the panel's view of what should be served into Caddy. */
  routing: CaddyReconciler;
  services: ServiceManager;
  databaseNetwork: DatabaseNetworkService;
  sites: SiteService;
  gameServers: GameServerService;
  /** Counts the web server's access logs into per-website traffic figures. */
  traffic: TrafficCollector;
  legacyCloudflareTokenMigration: LegacyCloudflareTokenMigration;
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

  const legacyCloudflareTokenMigration = migrateLegacyCloudflareToken(db, vault);
  if (legacyCloudflareTokenMigration.status === 'staged') {
    process.stderr.write('Migrated the existing Cloudflare credential to a website.\n');
  } else if (legacyCloudflareTokenMigration.status === 'ambiguous') {
    process.stderr.write(
      'The existing Cloudflare credential could not be assigned automatically; reconnect it on each website.\n',
    );
  } else if (legacyCloudflareTokenMigration.status === 'unreadable') {
    process.stderr.write(
      'The existing Cloudflare credential could not be read; reconnect it on the website DNS tab.\n',
    );
  }

  const auth = new AuthService(db, vault, options.setupTokenPath ?? paths.setupToken());
  const mailer = new PanelMailer(db, vault);

  const jobs = new JobQueue(db);
  const backupScheduler = new BackupScheduler(db, jobs);
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
  const sites = new SiteService(db, vault, config.sitesRoot);

  /*
   * The game catalog is data, not code. The seed set ships inside the
   * installed agent (agent/game-servers/catalogue/); the data folder is where
   * an administrator drops or overrides configs without a rebuild. Seeding
   * refreshes a built-in nobody has edited, so a corrected config reaches
   * installs that already have the old one.
   *
   * Two seed locations: beside the agent in an installed layout, and the repo
   * root in development. The first that exists wins, so a packaged install
   * uses its shipped copy and a source checkout uses the repo's.
   */
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packagedCatalogue = path.join(moduleDir, '..', 'game-servers', 'catalogue');
  const repoCatalogue = path.join(moduleDir, '..', '..', '..', 'game-servers', 'catalogue');
  const gameCatalogueRepo = (await fs.access(packagedCatalogue).then(() => true, () => false))
    ? packagedCatalogue
    : repoCatalogue;
  const gameCatalogueData = path.join(config.dataDir, 'game-servers', 'catalogue');
  const seeded = await seedGameServerCatalogue(gameCatalogueRepo, gameCatalogueData);
  for (const file of seeded.customised) {
    process.stderr.write(`Keeping your edited game config ${file}; the built-in version has moved on.\n`);
  }
  const gameCatalogue = await GameServerCatalogue.load(gameCatalogueRepo, gameCatalogueData);
  if (gameCatalogue.entries.length === 0) {
    // An empty catalog is a broken install, not a quiet empty library.
    process.stderr.write(
      `No game server configs found in ${gameCatalogueRepo} or ${gameCatalogueData}. ` +
        'The Game Servers page will be empty until at least one valid config is added.\n',
    );
  }
  for (const { file, error } of gameCatalogue.rejected) {
    process.stderr.write(`Skipping game server config ${file}: ${error}\n`);
  }
  const gameServers = new GameServerService(db, config.gameServersRoot, gameCatalogue);
  const services: ServiceManager = new ServiceManager(
    path.join(config.binDir, 'WinSW.exe'),
    path.join(config.dataDir, 'services'),
    createServiceRecovery(db, gameServers, async (id, failure) => {
      if (id.toLowerCase() !== CADDY_SERVICE_ID) return false;

      const quarantined = await quarantineUnloadableCaddyConfig(config.caddyDir, failure);
      if (quarantined) {
        process.stderr.write(
          `The web server could not load its saved configuration, so it was moved to ${quarantined} ` +
            'and the current one will be applied instead.\n',
        );
        // Caddy starts with nothing configured; this waits for its admin API.
        void routing.applyWhenReady();
      }

      const freed = await prepareStalwartForWebServer({ db, vault, services });
      return quarantined !== null || freed !== null;
    }),
  );
  if (process.platform === 'win32') {
    for (const server of gameServers.list()) {
      if (!server.serviceId) continue;

      const serviceState = await services.getState(server.serviceId);
      if (serviceState !== 'not-installed') {
        await services.setStartMode(server.serviceId, 'manual');
      }
      if (server.state !== 'stopped') continue;

      try {
        await services.stop(server.serviceId);
      } catch (error) {
        db.db
          .update(schema.gameServers)
          .set({ state: 'failed', updatedAt: new Date() })
          .where(eq(schema.gameServers.id, server.id))
          .run();
        process.stderr.write(
          `Could not clean up the stopped game server ${server.displayName}: ` +
            `${error instanceof Error ? error.message : 'unknown error'}\n`,
        );
      }
    }
  }
  const firewall = process.platform === 'win32' ? new FirewallManager() : undefined;
  const databaseNetwork = new DatabaseNetworkService({
    db,
    vault,
    services,
    firewall,
    binDir: config.binDir,
    dataDir: config.dataDir,
    logDir: config.logDir,
    panelAddress: firstIpv4(localAddresses()),
  });
  const traffic = new TrafficCollector({ db, accessLogDir: config.accessLogDir });
  const outageMonitor = new SiteOutageMonitor({
    db,
    mailer,
    isIntentionallyStopped: (serviceId) => services.isIntentionallyStopped(serviceId),
    log: (message, detail) => {
      process.stderr.write(`${message}${detail ? ` ${String(detail)}` : ''}\n`);
    },
  });

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
        loadGitToken: (siteId, userId) =>
          userId ? sites.getGitToken(siteId, userId) : Promise.resolve(undefined),
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
      firewall,
      databaseNetwork,
      binDir: config.binDir,
      sitesRoot: config.sitesRoot,
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
    jobs.register('update-package-manager', createUpdatePackageManagerHandler(installerDeps));
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
    jobs.register(
      'install-workshop-items',
      createInstallWorkshopItemsHandler({ db, binDir: config.binDir, vault, catalogue: gameCatalogue }),
    );
    jobs.register(
      'backup',
      createBackupHandler({
        db,
        vault,
        root: config.root,
        dataDir: config.dataDir,
        sitesRoot: config.sitesRoot,
        gameServersRoot: config.gameServersRoot,
        binDir: config.binDir,
        backupDir: config.backupDir,
        gameServers,
        markIntentionallyStopped: (id) => services.markIntentionallyStopped(id),
        markIntentionallyStarted: (id) => services.markIntentionallyStarted(id),
      }),
    );
  }

  return {
    config,
    db,
    schema,
    vault,
    auth,
    mailer,
    outageMonitor,
    jobs,
    backupScheduler,
    caddy,
    routing,
    services,
    databaseNetwork,
    sites,
    gameServers,
    traffic,
    legacyCloudflareTokenMigration,
    shutdown: async () => {
      outageMonitor.stop();
      backupScheduler.stop();
      await jobs.stop();
      traffic.stop();
      vault.lock();
      db.close();
    },
  };
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
