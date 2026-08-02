import fs from 'node:fs/promises';
import { createAppContext } from './app-context.js';
import { config, paths } from './config.js';
import { createServer } from './server.js';
import { localAddresses } from './tls/panel-certificate.js';

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

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`Received ${signal}, shutting down.`);
    // Order matters: stop accepting requests, let in-flight jobs finish, then
    // release the database. Closing the database first would fail any job
    // mid-write.
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
