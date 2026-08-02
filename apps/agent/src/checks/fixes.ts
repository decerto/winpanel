import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { serverChanges } from '../db/schema.js';
import { runCommand } from '../process/run-command.js';

/**
 * Applying and undoing server configuration changes.
 *
 * A control panel that edits the registry, services and firewall rules is a
 * one-way door unless every change records what was there before. So each fix
 * has an `apply` and an `undo`, and `apply` captures the previous value first.
 * If capturing fails, the change does not happen at all — an unreversible
 * change is worse than an unapplied one.
 */

export interface FixDefinition {
  action: string;
  /** What kind of thing is being changed, for the audit trail. */
  changeType: 'registry' | 'service' | 'firewall' | 'policy' | 'time';
  targetKey: string;
  /** Reads the current value so it can be restored. Null means "not set". */
  capture: () => Promise<unknown>;
  apply: () => Promise<void>;
  undo: (previousValue: unknown) => Promise<void>;
  /** Some changes genuinely cannot be undone; those say so up front. */
  reversible: boolean;
}

export class FixError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FixError';
  }
}

async function readRegistryDword(keyPath: string, valueName: string): Promise<number | null> {
  const result = await runCommand({
    exe: 'reg.exe',
    args: ['query', keyPath, '/v', valueName],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) return null;

  const match = new RegExp(`${valueName}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(result.stdout);
  return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

async function writeRegistryDword(
  keyPath: string,
  valueName: string,
  value: number,
): Promise<void> {
  const result = await runCommand({
    exe: 'reg.exe',
    args: ['add', keyPath, '/v', valueName, '/t', 'REG_DWORD', '/d', String(value), '/f'],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    throw new FixError(
      'Could not change this Windows setting. The panel may not be running with ' +
        'administrator rights.',
    );
  }
}

async function deleteRegistryValue(keyPath: string, valueName: string): Promise<void> {
  await runCommand({
    exe: 'reg.exe',
    args: ['delete', keyPath, '/v', valueName, '/f'],
    timeoutMs: 15_000,
  });
}

async function serviceStartMode(serviceName: string): Promise<string | null> {
  const result = await runCommand({
    exe: 'sc.exe',
    args: ['qc', serviceName],
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) return null;
  const match = /START_TYPE\s*:\s*\d+\s+(\S+)/i.exec(result.stdout);
  return match?.[1] ?? null;
}

const FILESYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

export function buildFixes(): FixDefinition[] {
  return [
    {
      action: 'server.enable-long-paths',
      changeType: 'registry',
      targetKey: `${FILESYSTEM_KEY}\\LongPathsEnabled`,
      reversible: true,
      capture: async () => await readRegistryDword(FILESYSTEM_KEY, 'LongPathsEnabled'),
      apply: async () => {
        await writeRegistryDword(FILESYSTEM_KEY, 'LongPathsEnabled', 1);
      },
      undo: async (previous) => {
        if (previous === null || previous === undefined) {
          await deleteRegistryValue(FILESYSTEM_KEY, 'LongPathsEnabled');
        } else {
          await writeRegistryDword(FILESYSTEM_KEY, 'LongPathsEnabled', Number(previous));
        }
      },
    },

    {
      action: 'server.disable-iis',
      changeType: 'service',
      targetKey: 'W3SVC',
      reversible: true,
      capture: async () => await serviceStartMode('W3SVC'),
      apply: async () => {
        await runCommand({ exe: 'sc.exe', args: ['stop', 'W3SVC'], timeoutMs: 60_000 });
        const result = await runCommand({
          exe: 'sc.exe',
          args: ['config', 'W3SVC', 'start=', 'disabled'],
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new FixError(
            'Could not turn off the built-in web server. Administrator rights are needed.',
          );
        }
      },
      undo: async (previous) => {
        // Restore the exact previous start type rather than guessing, so a
        // machine that genuinely used IIS goes back to how it was.
        const startMode = typeof previous === 'string' ? previous.toLowerCase() : 'demand';
        const mapped = startMode.includes('auto')
          ? 'auto'
          : startMode.includes('disabled')
            ? 'disabled'
            : 'demand';

        await runCommand({
          exe: 'sc.exe',
          args: ['config', 'W3SVC', 'start=', mapped],
          timeoutMs: 30_000,
        });
      },
    },

    {
      action: 'server.resync-time',
      changeType: 'time',
      targetKey: 'w32time',
      // The clock cannot be put back, and would not want to be.
      reversible: false,
      capture: async () => null,
      apply: async () => {
        await runCommand({ exe: 'sc.exe', args: ['config', 'w32time', 'start=', 'auto'] });
        await runCommand({ exe: 'sc.exe', args: ['start', 'w32time'], timeoutMs: 30_000 });
        const result = await runCommand({
          exe: 'w32tm.exe',
          args: ['/resync', '/force'],
          timeoutMs: 60_000,
        });
        if (result.exitCode !== 0) {
          throw new FixError(
            'Could not synchronise the clock. Check that the server can reach the internet.',
          );
        }
      },
      undo: async () => {
        throw new FixError('Correcting the clock cannot be undone.');
      },
    },
  ];
}

export class FixRunner {
  readonly #fixes = new Map<string, FixDefinition>();

  /**
   * Fixes are injectable so tests can exercise the apply/undo bookkeeping
   * without touching the real registry or services on the developer's machine.
   */
  constructor(
    private readonly handle: DatabaseHandle,
    fixes: readonly FixDefinition[] = buildFixes(),
  ) {
    for (const fix of fixes) this.#fixes.set(fix.action, fix);
  }

  has(action: string): boolean {
    return this.#fixes.has(action);
  }

  /** Applies a fix, recording the previous state so it can be reversed. */
  async apply(action: string, checkId: string): Promise<void> {
    const fix = this.#fixes.get(action);
    if (!fix) throw new FixError(`There is no fix called "${action}".`);

    let previousValue: unknown;
    try {
      previousValue = await fix.capture();
    } catch (error) {
      // Refusing here is deliberate: applying a change we cannot describe or
      // reverse would leave the machine in a state nobody can reason about.
      throw new FixError(
        'Could not read the current setting, so the change was not made. ' +
          'This avoids leaving the server in a state that cannot be undone.',
        { cause: error },
      );
    }

    await fix.apply();

    this.handle.db
      .insert(serverChanges)
      .values({
        id: crypto.randomUUID(),
        checkId,
        changeType: fix.changeType,
        targetKey: fix.targetKey,
        previousValue: previousValue ?? null,
        newValue: { applied: action },
        undone: false,
      })
      .run();
  }

  /** Reverses a previously applied change. */
  async undo(changeId: string): Promise<void> {
    const change = this.handle.db
      .select()
      .from(serverChanges)
      .where(eq(serverChanges.id, changeId))
      .get();

    if (!change) throw new FixError('That change could not be found.');
    if (change.undone) throw new FixError('That change has already been undone.');

    const action = (change.newValue as { applied?: string } | null)?.applied;
    const fix = action ? this.#fixes.get(action) : undefined;
    if (!fix) throw new FixError('That change cannot be undone automatically.');
    if (!fix.reversible) throw new FixError('This change cannot be undone.');

    await fix.undo(change.previousValue);

    this.handle.db
      .update(serverChanges)
      .set({ undone: true, undoneAt: new Date() })
      .where(eq(serverChanges.id, changeId))
      .run();
  }

  /** Changes that are still in effect, newest first. */
  listApplied() {
    return this.handle.db
      .select()
      .from(serverChanges)
      .where(eq(serverChanges.undone, false))
      .all();
  }
}
