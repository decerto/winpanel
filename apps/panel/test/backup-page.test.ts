import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

/**
 * The Backup page, and the question somebody arrives at it asking: is this
 * thing actually going to run, and when?
 *
 * A schedule that looks switched on while producing nothing is the failure
 * these tests exist to catch, so they check that the page reports the next
 * run, says out loud when the last one failed, and persists a toggle without
 * needing a separate save.
 */

const DAY = 24 * 60 * 60 * 1000;

function slot(overrides: Record<string, unknown> = {}) {
  return {
    frequency: 'daily',
    enabled: true,
    periodKey: '2026-08-29',
    dueNow: false,
    nextRunAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    attemptsThisPeriod: 1,
    attemptLimit: 3,
    givenUpThisPeriod: false,
    lastRun: { jobId: 'job-daily', status: 'succeeded', at: new Date(Date.now() - 3600_000), error: null },
    lastSuccessAt: new Date(Date.now() - 3600_000),
    currentBackupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    currentBackup: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sizeBytes: 1_900_000_000,
      createdAt: new Date(Date.now() - 3600_000),
      status: 'succeeded',
      frequency: 'daily',
      includesGameServers: false,
      includesDependencies: false,
    },
    ...overrides,
  };
}

function status() {
  return {
    schedule: {
      daily: true,
      weekly: false,
      monthly: false,
      includeGameServers: false,
      includeDependencies: false,
    },
    checkIntervalMs: 15 * 60 * 1000,
    slots: [
      slot(),
      slot({
        frequency: 'weekly',
        enabled: false,
        nextRunAt: null,
        lastRun: null,
        lastSuccessAt: null,
        currentBackupId: null,
        currentBackup: null,
        attemptsThisPeriod: 0,
      }),
      slot({
        frequency: 'monthly',
        enabled: false,
        nextRunAt: null,
        lastRun: null,
        lastSuccessAt: null,
        currentBackupId: null,
        currentBackup: null,
        attemptsThisPeriod: 0,
      }),
    ],
    backups: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sizeBytes: 1_900_000_000,
        createdAt: new Date(Date.now() - 3600_000),
        status: 'succeeded',
        frequency: 'daily',
        includesGameServers: false,
        includesDependencies: false,
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sizeBytes: 1_800_000_000,
        createdAt: new Date(Date.now() - 3 * DAY),
        status: 'succeeded',
        frequency: null,
        includesGameServers: false,
        includesDependencies: false,
      },
    ],
    storage: {
      count: 2,
      totalBytes: 3_700_000_000,
      newestAt: new Date(Date.now() - 3600_000),
      oldestAt: new Date(Date.now() - 3 * DAY),
    },
    websiteStorage: { count: 1, totalBytes: 120_000_000, newestAt: null, oldestAt: null },
  };
}

const state = vi.hoisted(() => ({
  status: null as any,
  active: null as any,
  job: null as any,
  saved: [] as any[],
  removed: [] as any[],
  restored: [] as any[],
  cancelled: [] as any[],
}));

vi.mock('../src/lib/api', () => ({
  api: {
    backups: {
      panel: {
        status: { query: vi.fn(async () => state.status) },
        active: { query: vi.fn(async () => state.active) },
        create: { mutate: vi.fn(async () => ({ jobId: 'job-create' })) },
        restore: {
          mutate: vi.fn(async (input: any) => {
            state.restored.push(input);
            return { jobId: 'job-restore' };
          }),
        },
        setSettings: {
          mutate: vi.fn(async (input: any) => {
            state.saved.push(input);
            state.status = { ...state.status, schedule: input };
            return state.status;
          }),
        },
        remove: {
          mutate: vi.fn(async (input: any) => {
            state.removed.push(input);
            state.status = {
              ...state.status,
              backups: state.status.backups.filter((backup: any) => backup.id !== input.backupId),
            };
            return state.status;
          }),
        },
      },
    },
    jobs: {
      get: { query: vi.fn(async () => state.job) },
      logs: { query: vi.fn(async () => []) },
      cancel: {
        mutate: vi.fn(async (input: any) => {
          state.cancelled.push(input);
          state.active = null;
          state.job = state.job ? { ...state.job, status: 'cancelled' } : null;
          return { ok: true };
        }),
      },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const BackupPage = (await import('../src/pages/BackupPage.vue')).default;

beforeEach(() => {
  state.status = status();
  state.active = null;
  state.job = null;
  state.saved = [];
  state.removed = [];
  state.restored = [];
  state.cancelled = [];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

async function open() {
  const wrapper = mount(BackupPage);
  await flushPromises();
  return wrapper;
}

function card(wrapper: any, frequency: string) {
  return wrapper.get(`[data-schedule="${frequency}"]`);
}

describe('the panel backup page', () => {
  it('says when each schedule next runs', async () => {
    const wrapper = await open();

    expect(card(wrapper, 'daily').text()).toContain('in 6 hours');
    expect(card(wrapper, 'weekly').text()).toContain('Switched off');
    expect(wrapper.text()).toContain('The server checks every 15 minutes');
  });

  it('says a snapshot is imminent when the period has none yet', async () => {
    state.status.slots[0] = slot({
      dueNow: true,
      attemptsThisPeriod: 0,
      nextRunAt: new Date(),
      lastRun: null,
      lastSuccessAt: null,
      currentBackupId: null,
      currentBackup: null,
    });

    const wrapper = await open();
    expect(card(wrapper, 'daily').text()).toContain('Starting within 15 minutes');
  });

  it('shows what a schedule is holding, and what it cost', async () => {
    const wrapper = await open();

    expect(card(wrapper, 'daily').text()).toContain('1.8 GB');
    expect(wrapper.text()).toContain('3.4 GB');
    expect(wrapper.text()).toContain('2 panel snapshots on this disk');
  });

  it('reports a schedule that has given up, and why', async () => {
    state.status.slots[0] = slot({
      dueNow: false,
      givenUpThisPeriod: true,
      attemptsThisPeriod: 3,
      lastRun: {
        jobId: 'job-daily',
        status: 'failed',
        at: new Date(Date.now() - 600_000),
        error: 'There is no space left on the disk.',
      },
    });

    const wrapper = await open();
    expect(wrapper.text()).toContain('The daily snapshot failed 3 times');
    expect(wrapper.text()).toContain('There is no space left on the disk.');
  });

  /** No separate Save button: a saved-looking schedule that was never sent is the whole bug. */
  it('saves a schedule the moment it is switched on', async () => {
    const wrapper = await open();
    const toggle = card(wrapper, 'weekly').get('input[type="checkbox"]');

    await toggle.setValue(true);
    await flushPromises();

    expect(state.saved).toEqual([
      {
        daily: true,
        weekly: true,
        monthly: false,
        includeGameServers: false,
        includeDependencies: false,
      },
    ]);
    expect(wrapper.text()).toContain('Backup schedule saved.');
  });

  it('saves the archive contents without a second step', async () => {
    const wrapper = await open();
    const options = wrapper.findAll('aside input[type="checkbox"]');

    await options[0]!.setValue(true);
    await flushPromises();

    expect(state.saved[0]).toMatchObject({ includeGameServers: true });
  });

  it('deletes a snapshot after confirming, and drops it from the list', async () => {
    const wrapper = await open();
    const manual = wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label')?.startsWith('Delete the snapshot'))!;

    await manual.trigger('click');
    await flushPromises();

    expect(window.confirm).toHaveBeenCalled();
    expect(state.removed).toEqual([{ backupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);
    expect(wrapper.text()).toContain('That snapshot was deleted.');
    expect(wrapper.findAll('[href^="/api/backups/panel/"]')).toHaveLength(1);
  });

  it('leaves a snapshot alone when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const wrapper = await open();

    const remove = wrapper
      .findAll('button')
      .find((button) => button.attributes('aria-label')?.startsWith('Delete the snapshot'))!;
    await remove.trigger('click');
    await flushPromises();

    expect(state.removed).toEqual([]);
  });

  it('tells a manual snapshot apart from an automatic one', async () => {
    const wrapper = await open();
    const text = wrapper.text();

    expect(text).toContain('Manual');
    expect(text).toContain('Daily');
  });

  it('offers dependency installation before restoring an archive that omitted it', async () => {
    const wrapper = await open();
    const restore = wrapper.findAll('button').find((button) => button.text().trim() === 'Restore')!;

    await restore.trigger('click');
    expect(wrapper.get('[role="dialog"]').text()).toContain('omitted Node dependencies');

    const install = wrapper
      .get('[role="dialog"]')
      .findAll('button')
      .find((button) => button.text().trim() === 'Install and restore')!;
    await install.trigger('click');
    await flushPromises();

    expect(state.restored).toEqual([
      {
        backupId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        installDependencies: true,
      },
    ]);
    wrapper.unmount();
  });

  it('lets the owner cancel an active backup or restore', async () => {
    state.active = { jobId: 'job-create', operation: 'create' };
    state.job = { id: 'job-create', status: 'running', progress: 24 };
    const wrapper = await open();

    await wrapper.get('[aria-label="Cancel current panel activity"]').trigger('click');
    await flushPromises();

    expect(state.cancelled).toEqual([{ jobId: 'job-create' }]);
    expect(wrapper.text()).toContain('Cancellation requested.');
    wrapper.unmount();
  });
});
