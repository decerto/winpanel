import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { FixError, FixRunner, buildFixes, type FixDefinition } from '../src/checks/fixes.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;

/** A fix backed by an in-memory value, standing in for the registry. */
function fakeFix(overrides: Partial<FixDefinition> = {}) {
  const state = { value: 0 as number | null };

  const fix: FixDefinition = {
    action: 'test.set-flag',
    changeType: 'registry',
    targetKey: 'HKLM\\Test\\Flag',
    reversible: true,
    capture: async () => state.value,
    apply: async () => {
      state.value = 1;
    },
    undo: async (previous) => {
      state.value = previous === null ? null : Number(previous);
    },
    ...overrides,
  };

  return { fix, state };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-fix-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('fix definitions', () => {
  const fixes = buildFixes();

  it('declares whether each fix can be undone', () => {
    for (const fix of fixes) {
      expect(typeof fix.reversible, fix.action).toBe('boolean');
    }
  });

  it('provides capture and undo for every reversible fix', () => {
    for (const fix of fixes.filter((f) => f.reversible)) {
      expect(fix.capture, fix.action).toBeTypeOf('function');
      expect(fix.undo, fix.action).toBeTypeOf('function');
    }
  });

  it('is honest that correcting the clock cannot be reversed', () => {
    expect(fixes.find((f) => f.action === 'server.resync-time')?.reversible).toBe(false);
  });

  it('covers the fixes the server checks offer', () => {
    const actions = fixes.map((f) => f.action);
    expect(actions).toContain('server.enable-long-paths');
    expect(actions).toContain('server.disable-iis');
    expect(actions).toContain('server.resync-time');
  });
});

describe('FixRunner', () => {
  it('rejects an unknown fix', async () => {
    const runner = new FixRunner(handle, []);
    await expect(runner.apply('does.not.exist', 'check')).rejects.toBeInstanceOf(FixError);
  });

  it('knows which fixes it can run', () => {
    const { fix } = fakeFix();
    const runner = new FixRunner(handle, [fix]);
    expect(runner.has('test.set-flag')).toBe(true);
    expect(runner.has('server.make-toast')).toBe(false);
  });

  it('applies a fix and records the previous value', async () => {
    const { fix, state } = fakeFix();
    const runner = new FixRunner(handle, [fix]);

    await runner.apply('test.set-flag', 'test.check');
    expect(state.value).toBe(1);

    const applied = runner.listApplied();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.previousValue).toBe(0);
    expect(applied[0]?.targetKey).toBe('HKLM\\Test\\Flag');
    expect(applied[0]?.checkId).toBe('test.check');
  });

  it('restores the previous value on undo', async () => {
    const { fix, state } = fakeFix();
    const runner = new FixRunner(handle, [fix]);

    await runner.apply('test.set-flag', 'test.check');
    const changeId = runner.listApplied()[0]!.id;
    await runner.undo(changeId);

    // Back to exactly what it was, not to an assumed default.
    expect(state.value).toBe(0);
    expect(runner.listApplied()).toHaveLength(0);
  });

  it('restores "was not set" correctly rather than writing a default', async () => {
    // If the value never existed, undo must remove it again — writing a zero
    // would leave the machine subtly different from how it started.
    const { fix, state } = fakeFix();
    state.value = null;

    const runner = new FixRunner(handle, [fix]);
    await runner.apply('test.set-flag', 'test.check');
    expect(state.value).toBe(1);

    await runner.undo(runner.listApplied()[0]!.id);
    expect(state.value).toBeNull();
  });

  it('refuses to apply when the current value cannot be read', async () => {
    // A change that cannot be described or reversed must not happen at all.
    const { fix, state } = fakeFix({
      capture: async () => {
        throw new Error('registry locked');
      },
    });

    const runner = new FixRunner(handle, [fix]);
    await expect(runner.apply('test.set-flag', 'test.check')).rejects.toThrow(
      /cannot be undone|not made/i,
    );

    expect(state.value).toBe(0);
    expect(runner.listApplied()).toHaveLength(0);
  });

  it('does not record a change when applying fails', async () => {
    const { fix } = fakeFix({
      apply: async () => {
        throw new FixError('Administrator rights are needed.');
      },
    });

    const runner = new FixRunner(handle, [fix]);
    await expect(runner.apply('test.set-flag', 'test.check')).rejects.toThrow(/Administrator/);
    expect(runner.listApplied()).toHaveLength(0);
  });

  it('refuses to undo a change that is not reversible', async () => {
    const { fix } = fakeFix({ action: 'test.one-way', reversible: false });
    const runner = new FixRunner(handle, [fix]);

    await runner.apply('test.one-way', 'test.check');
    const changeId = runner.listApplied()[0]!.id;

    await expect(runner.undo(changeId)).rejects.toThrow(/cannot be undone/i);
  });

  it('rejects undoing a change that does not exist', async () => {
    const runner = new FixRunner(handle, []);
    await expect(runner.undo(crypto.randomUUID())).rejects.toThrow(/could not be found/i);
  });

  it('rejects undoing the same change twice', async () => {
    const { fix } = fakeFix();
    const runner = new FixRunner(handle, [fix]);

    await runner.apply('test.set-flag', 'test.check');
    const changeId = runner.listApplied()[0]!.id;

    await runner.undo(changeId);
    await expect(runner.undo(changeId)).rejects.toThrow(/already been undone/i);
  });

  it('tracks several changes independently', async () => {
    const a = fakeFix({ action: 'test.a', targetKey: 'HKLM\\A' });
    const b = fakeFix({ action: 'test.b', targetKey: 'HKLM\\B' });
    const runner = new FixRunner(handle, [a.fix, b.fix]);

    await runner.apply('test.a', 'check.a');
    await runner.apply('test.b', 'check.b');
    expect(runner.listApplied()).toHaveLength(2);

    const changeA = runner.listApplied().find((c) => c.targetKey === 'HKLM\\A')!;
    await runner.undo(changeA.id);

    expect(a.state.value).toBe(0);
    expect(b.state.value).toBe(1);
    expect(runner.listApplied()).toHaveLength(1);
  });
});
