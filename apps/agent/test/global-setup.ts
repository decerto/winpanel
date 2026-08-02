import { runCommand } from '../src/process/run-command.js';

/**
 * Runs once before the suite.
 *
 * The vault reaches Windows DPAPI through PowerShell. On a cold CI runner the
 * very first PowerShell start is dramatically slower than later ones — the
 * shell itself has to load, and `Add-Type -AssemblyName System.Security`
 * triggers assembly loading and JIT on top of that. Measured on a GitHub
 * Windows runner it can exceed thirty seconds, while subsequent calls take
 * well under a second.
 *
 * Paying that cost once here, rather than inside whichever test happens to run
 * first, keeps the timeouts meaningful. Without it the first vault test fails
 * on timing while every later one passes, which looks like flakiness and
 * teaches people to re-run the build instead of reading it.
 */
export async function setup(): Promise<void> {
  if (process.platform !== 'win32') return;

  try {
    await runCommand({
      exe: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Mirrors what the vault does, so the same assemblies are warm.
        'Add-Type -AssemblyName System.Security; ' +
          '[System.Security.Cryptography.ProtectedData] | Out-Null; ' +
          'Write-Output ready',
      ],
      timeoutMs: 120_000,
    });
  } catch {
    // Best effort. If this fails the tests will still run, just slower.
  }
}
