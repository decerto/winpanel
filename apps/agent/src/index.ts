import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppContext } from './app-context.js';
import { config, paths } from './config.js';
import { createServer } from './server.js';
import { CADDY_SERVICE_ID, syncCaddyEnvironment } from './caddy/service.js';
import {
  prepareStalwartForWebServer,
  syncMailCertificates,
  syncMailEnvironment,
} from './mail/service.js';
import { cleanUpAfterUpdate } from './components/panel-update.js';
import { cleanupRotatedLogFiles, PANEL_LOG_RETENTION_DAYS } from './logs/log-files.js';
import { localAddresses } from './tls/panel-certificate.js';
import { ServiceWatchdog } from './windows/service-watchdog.js';
import { watchdogServices } from './windows/watched-services.js';
import { registerSiteChecks } from './api/routers/checks.js';
import { findStrayListeners, killProcessTree } from './windows/stray-processes.js';
import { clearLegacyCloudflareToken } from './dns/token.js';

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
 *
 * One attempt is not enough. An update stops the service and starts the new
 * agent while the old one is still mid-shutdown: the stray can be between
 * "killed" and "port released" for a moment, and a single retry that lands
 * inside that window fails the boot for good — WinSW's restart budget is
 * spent on the same race and the panel stays down until somebody clears the
 * port by hand. So this loops for a while: killing the panel's own orphan is
 * idempotent, and a port that frees a second late is no reason to die.
 */
async function listenClearingStrays(
  server: Awaited<ReturnType<typeof createServer>>,
  port: number,
  host: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await server.listen({ port, host });
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;

      const strays = await findStrayListeners([port], [path.basename(process.execPath)]);
      if (strays.length === 0) {
        // A squatter that is not the panel's own runtime is a real collision,
        // not an orphan, and is never ours to end.
        throw error;
      }

      server.log.warn(
        { strays },
        `Port ${port} was still held by a previous copy of the panel. Ending it and retrying.`,
      );

      for (const pid of new Set(strays.map((stray) => stray.pid))) await killProcessTree(pid);

      // Give the socket a beat to actually close before trying again.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw lastError;
}

// Exported for the tests; the retry loop above is the fix for a real outage
// and has to be exercisable without booting the whole agent.
export { listenClearingStrays };

async function main(): Promise<void> {
  for (const dir of [config.dataDir, config.logDir, config.binDir, config.caddyDir, config.accessLogDir]) {
    await fs.mkdir(dir, { recursive: true });
  }

  const app = await createAppContext();
  const server = await createServer(app);

  const cleanUpRotatedLogs = async (): Promise<void> => {
    try {
      const result = await cleanupRotatedLogFiles(
        config.logDir,
        PANEL_LOG_RETENTION_DAYS,
        [config.accessLogDir],
      );
      if (result.deleted > 0) {
        server.log.info(
          { deleted: result.deleted, bytes: result.bytes, retentionDays: PANEL_LOG_RETENTION_DAYS },
          'Removed expired rotated panel logs.',
        );
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not remove expired rotated panel logs.');
    }
  };

  void cleanUpRotatedLogs();
  setInterval(() => void cleanUpRotatedLogs(), 6 * 60 * 60 * 1000).unref();

  void app.databaseNetwork.reconcileInstalled().catch((error) => {
    process.stderr.write(`Could not reconcile database network access: ${String(error)}\n`);
  });

  /*
   * Point the per-website health checks at the live database. Done here rather
   * than at module load because the checks router is constructed before the
   * app context — and the database — exists.
   */
  registerSiteChecks(app.db);

  app.jobs.start();
  app.backupScheduler.start();

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
   * the panel is where you go to install it. It is awaited further down, after
   * everything that must not wait on it, purely so the watchdog cannot sweep
   * while these repairs are still restarting things.
   */
  const startupRepairs = (async () => {
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
     * the panel has just removed the only reason it could not run. The same
     * pass puts it back on the submission port if it is not on one.
     */
    try {
      const mailDependencies = {
        db: app.db,
        vault: app.vault,
        services: app.services,
      };
      const listeners = await prepareStalwartForWebServer(mailDependencies);

      for (const change of listeners?.changes ?? []) server.log.warn(change);

      if (listeners?.restarted && (await app.services.getState(CADDY_SERVICE_ID)) === 'stopped') {
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

        for (const failure of result.failed) {
          server.log.warn(
            `The mail server would not take the certificate for ${failure.hostname}: ` +
              `${failure.message}. Mail programs will stop signing in when it expires.`,
          );
        }
      } catch (error) {
        server.log.warn({ err: error }, 'Could not update the mail server\u2019s certificate.');
      }
    };

    await syncCertificates();
    setInterval(() => void syncCertificates(), 6 * 60 * 60 * 1000).unref();

    /*
     * Ports are handed out lowest-first, so anything left behind by a deleted
     * site, a failed creation, or a static site that was given a pair before
     * it stopped needing one pushes every new website further up the range
     * for no reason. Returning them first also means the repair below can use
     * them.
     */
    try {
      const freed = app.sites.reclaimStalePorts();
      if (freed > 0) {
        server.log.info(`Freed ${freed} port(s) that no website was using.`);
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not free unused ports.');
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

    /*
     * Git tokens used to belong to the website rather than to a person, so
     * anybody the site was handed to inherited them. Give each one an owner.
     */
    try {
      const firstOwner = app.auth.listUsers().find((user) => user.role === 'superadmin');
      const adopted = await app.sites.adoptLegacyGitTokens(firstOwner?.id ?? null);
      if (adopted > 0) {
        server.log.info(`Assigned ${adopted} stored repository token(s) to an account.`);
      }
    } catch (error) {
      server.log.warn({ err: error }, 'Could not assign the stored repository tokens.');
    }

    const error = await app.routing.applyWhenReady();
    if (error) {
      server.log.warn({ err: error }, 'Could not apply the website configuration.');
    } else {
      server.log.info('Website configuration applied.');

      if (
        app.legacyCloudflareTokenMigration.status === 'staged' ||
        app.legacyCloudflareTokenMigration.status === 'ambiguous'
      ) {
        if (clearLegacyCloudflareToken(app.db)) {
          try {
            const result = await syncCaddyEnvironment({
              db: app.db,
              vault: app.vault,
              services: app.services,
              caddyDir: config.caddyDir,
            });
            if (result === 'updated') {
              server.log.info('Removed the legacy Cloudflare environment from the web server.');
            }
          } catch (cleanupError) {
            server.log.warn(
              { err: cleanupError },
              'Could not remove the legacy Cloudflare environment from the web server.',
            );
          }
        }
      }
    }

    /*
     * The panel's own certificate, once the web server has been given the
     * configuration that asks for it. On a timer for the same reason as the
     * mail server's: it is renewed roughly every sixty days, and the panel has
     * to pick the new one up without being restarted underneath whoever is
     * signed in.
     */
    const refreshPanelCertificate = async (): Promise<void> => {
      try {
        await app.refreshPanelCertificate?.();
      } catch (error) {
        server.log.warn({ err: error }, 'Could not update the panel\u2019s own certificate.');
      }
    };

    await refreshPanelCertificate();
    setInterval(() => void refreshPanelCertificate(), 6 * 60 * 60 * 1000).unref();

    // Starting up is, for an update that worked, the moment the installer
    // finished. Nothing it needed should still be lying around.
    await cleanUpAfterUpdate(config.binDir);
  })().catch((error: unknown) => {
    server.log.warn({ err: error }, 'Could not complete the panel startup repairs.');
  });

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
   *
   * The list is rebuilt on every sweep rather than captured here: websites are
   * created and removed while this is running, and a site added after start-up
   * is the one most likely to be mid-experiment and in need of it.
   *
   * The first sweep doubles as the recovery for an unclean shutdown. A restart
   * or power cut leaves each website's last node process orphaned and still
   * holding its port, so the auto-started service's new child dies on
   * EADDRINUSE a second after boot and the wrapper reports RUNNING over a dead
    * site. The sweep probes every watched port, finds the ones that say running
    * but answer nothing, and restarts them through `services.restart` — which
   * clears the orphan before binding. One sweep, a minute after boot, is what
   * turns "every site is down until somebody RDPs in" into a self-heal.
   */
  const watchdog = new ServiceWatchdog(
    {
      getState: (id) => app.services.getState(id),
      start: (id) => app.services.start(id),
      restart: (id) => app.services.restart(id),
      isIntentionallyStopped: (id) => app.services.isIntentionallyStopped(id),
      log: (message, detail) => server.log.warn({ detail }, message),
    },
    () => watchdogServices(app.db),
  );

  /*
   * Traffic is counted from the web server's logs on a timer. Reading them is
   * the only way the panel can report on a static site, which has no process
   * of its own to ask.
   */
  app.traffic.start();
  void app.traffic.sweep();

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

  // The repairs restart the web and mail servers themselves, so the watchdog
  // waits for them: two controllers starting one service at once is the race
  // that leaves it stopped.
  await startupRepairs;

  // Notifications begin only after the initial website configuration has been
  // applied, so Caddy starting up cannot look like a customer outage.
  app.outageMonitor.start();
  void app.outageMonitor.sweep();

  watchdog.start();
  void watchdog.sweep();
}

// Run only when executed directly. Importing this module — which the tests do
// to reach listenClearingStrays — must not boot the panel.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('WinPanel failed to start:', error);
    process.exit(1);
  });
}
