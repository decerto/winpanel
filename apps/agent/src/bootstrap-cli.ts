import { main } from './bootstrap/index.js';

/**
 * Command-line entry point used by the installer and uninstaller.
 *
 * Kept separate from the agent's own entry point so that installing does not
 * start a web server, and so a failure during setup surfaces as a non-zero
 * exit code the installer can react to.
 */
main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `\n  Setup could not finish: ${
        error instanceof Error ? error.message : String(error)
      }\n\n`,
    );
    process.exit(1);
  });
