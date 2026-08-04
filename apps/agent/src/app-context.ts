import os from 'node:os';
import path from 'node:path';
import { mailHostnameFor } from '@winpanel/shared';
import { config, paths } from './config.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from './db/index.js';
import { JobQueue } from './jobs/queue.js';
import { SecretVault } from './security/vault.js';
import { AuthService } from './services/auth-service.js';
import { CaddyClient } from './caddy/client.js';
import { CaddyReconciler } from './caddy/reconciler.js';
import { ServiceManager } from './windows/service-manager.js';
import { SiteService } from './sites/site-service.js';
import { createDeployHandler } from './sites/deploy-handler.js';
import { createRunCommandHandler } from './sites/command-runner.js';
import {
  createInstallComponentHandler,
  createUninstallComponentHandler,
} from './components/installer.js';
import { createPanelUpdateHandler } from './components/panel-update.js';
import { resolveToolInvocation } from './sites/tool-paths.js';

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
  const routing = new CaddyReconciler(db, caddy, config.sitesRoot, vault);
  const services = new ServiceManager(
    path.join(config.binDir, 'WinSW.exe'),
    path.join(config.dataDir, 'services'),
  );
  const sites = new SiteService(db, vault, config.sitesRoot);

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
      'update-panel',
      createPanelUpdateHandler({ binDir: config.binDir, logDir: config.logDir }),
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
    shutdown: async () => {
      await jobs.stop();
      vault.lock();
      db.close();
    },
  };
}
