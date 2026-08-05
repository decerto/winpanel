import fs from 'node:fs/promises';
import path from 'node:path';
import { createAppContext } from './app-context.js';
import { config, paths } from './config.js';
import { createServer } from './server.js';
import { CADDY_SERVICE_ID, syncCaddyEnvironment } from './caddy/service.js';
import { releaseWebPortsFromMail, syncMailCertificates, syncMailEnvironment } from './mail/service.js';
import { cleanUpAfterUpdate } from './components/panel-update.js';
import { localAddresses } from './tls/panel-certificate.js';
import { ServiceWatchdog } from './windows/service-watchdog.js';
import { findStrayListeners, killProcessTree } from './windows/stray-processes.js';

/**
 * Agent entry point. Runs as a Windows Service under WinSW in production.
 */

/**
 * Binds the panel's port, clearing a previous copy of itself that is still on it.
 *
 * The panel is supervised, so a failure to bind is not a one-off: Windows
 * restarts it, it fails again, and the service flaps on the failure-action
 * interval for as long as the squatter lives. Observed on this build as ten
 * minutes of a control panel that could not be reached, once a minute, with
 * `EADDRINUSE` as the only clue.
 *
 * The panel cannot be rescued by the watchdog the way Caddy and the mail
 * server are, because the watchdog runs inside the panel — so the one moment
 * it can act is here, before it gives up. Only a process running this same
 * runtime and holding this same port is ended, which is the panel's own
 * orphan and nothing else.
 */
async function listenClearingStrays(
  server: Awaited<ReturnType<typeof createServer>>,
  port: number,
  host: string,
): Promise<void> {
  try {
    await server.listen({ port, host });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;

    const strays = await findStrayListeners([port], [path.basename(process.execPath)]);
    if (strays.length === 0) throw error;

    server.log.warn(
      { strays },
      `Port ${port} was still held by a previous copy of the panel. Ending it and retrying.`,
    );

    for (const pid of new Set(strays.map((stray) => stray.pid))) await killProcessTree(pid);
  }

  await server.listen({ port, host });
}

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
     * The mail server binds :443 by default, and after an update — which stops
     * everything and starts it again — it can win that port from the web
     * server permanently. Repairing it here also starts the web server, since
     * the panel has just removed the only reason it could not run.
     */
    try {
      const release = await releaseWebPortsFromMail({
        db: app.db,
        vault: app.vault,
        services: app.services,
      });

      for (const change of release.changes) server.log.warn(change);

      if (release.restarted && (await app.services.getState(CADDY_SERVICE_ID)) === 'stopped') {
        await app.services.start(CADDY_SERVICE_ID);
        server.log.info('Started the web server now that its ports are free.');
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not check which ports the mail server is using.');
    }

    /*
     * The mail server serves a certificate it made for itself until it is
     * given a better one, and no mail client will accept that. The web server
     * already holds a trusted certificate for the same name, so it is copied
     * across here — and again on a timer, because Caddy renews roughly every
     * sixty days and a stale copy breaks every mail client at once.
     */
    const syncCertificates = async (): Promise<void> => {
      try {
        const result = await syncMailCertificates({
          db: app.db,
          vault: app.vault,
          services: app.services,
          caddyDir: config.caddyDir,
        });

        if (result.installed.length > 0) {
          server.log.info(
            `Gave the mail server the certificate for ${result.installed.join(', ')}.`,
          );
        }
      } catch (error) {
        server.log.warn({ err: error }, 'Could not update the mail server\u2019s certificate.');
      }
    };

    await syncCertificates();
    setInterval(() => void syncCertificates(), 12 * 60 * 60 * 1000).unref();

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

    /*
     * Sites deployed before the single `release/` folder still have their old
     * dated folders sitting in the file manager, where they look like live
     * copies and are not.
     */
    try {
      const cleaned = await app.sites.cleanUpLegacyLayouts();
      if (cleaned > 0) {
        server.log.info(`Removed the old release folders from ${cleaned} website(s).`);
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not remove the old release folders.');
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

  await listenClearingStrays(server, config.port, config.host);

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
