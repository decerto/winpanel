import fs from 'node:fs/promises';
import { createAppContext } from './app-context.js';
import { config, paths } from './config.js';
import { createServer } from './server.js';
import { syncCaddyEnvironment } from './caddy/service.js';
import { syncMailEnvironment } from './mail/service.js';
import { cleanUpAfterUpdate } from './components/panel-update.js';
import { localAddresses } from './tls/panel-certificate.js';
import { ServiceWatchdog } from './windows/service-watchdog.js';

/**
 * Agent entry point. Runs as a Windows Service under WinSW in production.
 */
async function main(): Promise<void> {
  for (const dir of [config.dataDir, config.logDir, config.binDir, config.caddyDir]) {
    await fs.mkdir(dir, { recursive: true });
  }

  const app = await createAppContext();
  const server = await createServer(app);

  app.jobs.start();

  /*
   * Push the site configuration into Caddy on every start.
   *
   * Caddy is a separate service with its own lifecycle: it may have been
   * restarted, reinstalled, or started from an empty config while the panel
   * was down. Reapplying here means the answer to "why is my site not
   * loading" is never "the two processes disagree about what exists".
   *
   * The environment goes first, because the config refers to the certificate
   * token by name and would otherwise resolve it to nothing. Both steps are
   * no-ops when nothing has changed, so this does not restart Caddy on every
   * panel start.
   *
   * It must not block start-up. If Caddy is not installed yet — which is the
   * normal state on a fresh machine — the panel still has to come up, because
   * the panel is where you go to install it.
   */
  void (async () => {
    try {
      const result = await syncCaddyEnvironment({
        db: app.db,
        vault: app.vault,
        services: app.services,
        caddyDir: config.caddyDir,
      });
      if (result === 'updated') {
        server.log.info('Updated the web server environment and restarted it.');
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not update the web server environment.');
    }

    /*
     * The mail server has no account the panel knows about until it is given
     * one, and it is given one here. Doing it on every start also repairs an
     * install that predates this, which is otherwise stuck: the panel cannot
     * manage mailboxes, and the credential it would need can only be created
     * by something that can already sign in.
     */
    try {
      const result = await syncMailEnvironment({
        db: app.db,
        vault: app.vault,
        services: app.services,
      });
      if (result === 'updated') {
        server.log.info('Gave the mail server the panel\u2019s administrator credential.');
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not update the mail server environment.');
    }

    /*
     * Repairs sites created before preview ports existed. Without a port they
     * have no address at all until a domain is bought and DNS propagates.
     */
    try {
      const repaired = await app.sites.ensurePreviewPorts();
      if (repaired > 0) {
        server.log.info(`Gave ${repaired} website(s) a preview address.`);
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not assign missing preview addresses.');
    }

    const error = await app.routing.applyWhenReady();
    if (error) {
      server.log.warn({ err: error }, 'Could not apply the website configuration.');
    } else {
      server.log.info('Website configuration applied.');
    }

    // Starting up is, for an update that worked, the moment the installer
    // finished. Nothing it needed should still be lying around.
    await cleanUpAfterUpdate(config.binDir);
  })();

  // Generated up front so a fresh install always has a way in, even if the
  // installer's own attempt to write it failed.
  if (app.auth.needsSetup()) {
    const token = await app.auth.ensureSetupToken();
    const scheme = config.httpsEnabled ? 'https' : 'http';
    const addresses = localAddresses().filter((ip) => !ip.includes(':'));
    const shown = addresses[0] ?? 'your-server-ip';

    server.log.info(
      `\n  WinPanel is ready.\n` +
        `  Open:       ${scheme}://${shown}:${config.port}\n` +
        `  Setup code: ${token}\n` +
        `  (also saved to ${paths.setupToken()})\n`,
    );
  }

  await server.listen({ port: config.port, host: config.host });

  /*
   * Nothing else on the machine can rescue a component whose own orphaned
   * process is blocking its restart, because everything else on the machine
   * is that component.
   */
  const watchdog = new ServiceWatchdog({
    getState: (id) => app.services.getState(id),
    start: (id) => app.services.start(id),
    log: (message, detail) => server.log.warn({ detail }, message),
  });
  watchdog.start();
  void watchdog.sweep();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`Received ${signal}, shutting down.`);
    // Order matters: stop accepting requests, let in-flight jobs finish, then
    // release the database. Closing the database first would fail any job
    // mid-write.
    watchdog.stop();
    await server.close();
    await app.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A rejected promise that reaches the top level kills the service in Node
  // 15+. Log it and keep serving rather than dropping the panel offline.
  process.on('unhandledRejection', (reason) => {
    server.log.error({ err: reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    server.log.error({ err: error }, 'Uncaught exception');
  });
}

main().catch((error: unknown) => {
  console.error('WinPanel failed to start:', error);
  process.exit(1);
});
