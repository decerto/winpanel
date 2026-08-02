import path from 'node:path';
import { config, paths } from './config.js';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from './db/index.js';
import { JobQueue } from './jobs/queue.js';
import { SecretVault } from './security/vault.js';
import { AuthService } from './services/auth-service.js';
import { CaddyClient } from './caddy/client.js';
import { ServiceManager } from './windows/service-manager.js';
import { SiteService } from './sites/site-service.js';
import { createDeployHandler } from './sites/deploy-handler.js';
import { resolveTool } from './sites/tool-paths.js';

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
        services,
        tools: { resolve: resolveTool },
        gitPath: path.join(config.binDir, 'git', 'cmd', 'git.exe'),
        sitesRoot: config.sitesRoot,
        loadEnv: (siteId) => sites.getEnv(siteId),
        loadGitToken: (siteId) => sites.getGitToken(siteId),
      }),
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
    services,
    sites,
    shutdown: async () => {
      await jobs.stop();
      vault.lock();
      db.close();
    },
  };
}
