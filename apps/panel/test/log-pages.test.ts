import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { siteContextKey } from '../src/lib/site-context';

const state = vi.hoisted(() => ({
  accessResult: {
    range: '7d' as const,
    collecting: true,
    total: 2,
    oldestAt: Date.now() - 60_000,
    complete: true,
    lines: [
      {
        at: Date.now() - 1_000,
        status: 200,
        bytesIn: 32,
        bytesOut: 1024,
        durationMs: 12,
        method: 'GET',
        uri: '/home',
        host: 'example.com',
        remoteIp: '203.0.113.8',
        userAgent: 'Mozilla/5.0',
      },
      {
        at: Date.now() - 2_000,
        status: 500,
        bytesIn: 64,
        bytesOut: 0,
        durationMs: 245,
        method: 'POST',
        uri: '/save',
        host: 'example.com',
      },
    ],
  },
  accessQuery: vi.fn(async (input: any) => {
    const lines = input.status === '5xx'
      ? state.accessResult.lines.filter((line) => line.status >= 500)
      : state.accessResult.lines;
    return { ...state.accessResult, lines, total: lines.length };
  }),
  logs: [] as any[],
  panelLogResults: {} as Record<string, any>,
  logsList: vi.fn(async () => state.logs),
  logsRead: vi.fn(async ({ id }: { id: string }) => state.panelLogResults[id] ?? null),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { slug: 'example' } }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    sites: { accessLog: { query: state.accessQuery } },
    logs: { list: { query: state.logsList }, read: { query: state.logsRead } },
  },
  describeError: (error: unknown) => String(error),
}));

const SiteAccessLogPage = (await import('../src/pages/site/SiteAccessLogPage.vue')).default;
const PanelLogsPage = (await import('../src/pages/PanelLogsPage.vue')).default;

function accessSite() {
  return {
    slug: 'example',
    displayName: 'Example site',
    domains: ['example.com'],
  };
}

function panelLog(id: string, message: string, level = 'info') {
  return {
    id,
    size: 128,
    modifiedAt: new Date(0),
    lines: [{ at: Date.now(), level, message, raw: message }],
    truncated: false,
  };
}

async function renderAccess() {
  const wrapper = mount(SiteAccessLogPage, {
    global: {
      provide: {
        [siteContextKey as unknown as symbol]: { site: ref(accessSite()) },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

async function renderPanel() {
  const wrapper = mount(PanelLogsPage);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  state.accessResult = {
    ...state.accessResult,
    collecting: true,
    total: 2,
    lines: [
      {
        at: Date.now() - 1_000,
        status: 200,
        bytesIn: 32,
        bytesOut: 1024,
        durationMs: 12,
        method: 'GET',
        uri: '/home',
        host: 'example.com',
        remoteIp: '203.0.113.8',
        userAgent: 'Mozilla/5.0',
      },
      {
        at: Date.now() - 2_000,
        status: 500,
        bytesIn: 64,
        bytesOut: 0,
        durationMs: 245,
        method: 'POST',
        uri: '/save',
        host: 'example.com',
      },
    ],
  };
  state.logs = [
    { id: 'agent.out.log', size: 128, modifiedAt: new Date(0) },
    { id: 'agent.err.log', size: 256, modifiedAt: new Date(0) },
  ];
  state.panelLogResults = {
    'agent.out.log': panelLog('agent.out.log', 'agent started'),
    'agent.err.log': panelLog('agent.err.log', 'database failed', 'error'),
  };
  state.accessQuery.mockClear();
  state.logsList.mockClear();
  state.logsRead.mockClear();
});

describe('website request logs', () => {
  it('renders request rows and applies a response filter', async () => {
    const wrapper = await renderAccess();

    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('/home');
    expect(wrapper.text()).toContain('203.0.113.8');

    const refused = wrapper.findAll('button').find((button) => button.text() === 'Errors');
    await refused!.trigger('click');
    await flushPromises();

    expect(state.accessQuery).toHaveBeenLastCalledWith(expect.objectContaining({ status: '5xx' }));
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    wrapper.unmount();
  });

  it('explains when request collection has not started', async () => {
    state.accessResult = { ...state.accessResult, collecting: false, lines: [], total: 0 };
    const wrapper = await renderAccess();

    expect(wrapper.text()).toContain('No requests recorded yet');
    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('panel runtime logs', () => {
  it('selects files, renders lines, and filters by search and level', async () => {
    const wrapper = await renderPanel();

    expect(wrapper.text()).toContain('agent started');
    await wrapper.findAll('button').find((button) => button.text().includes('agent.err.log'))!.trigger('click');
    await flushPromises();
    expect(state.logsRead).toHaveBeenLastCalledWith({ id: 'agent.err.log', lines: 500 });
    expect(wrapper.text()).toContain('database failed');

    const search = wrapper.find('input[placeholder="Search this log"]');
    await search.setValue('missing');
    expect(wrapper.text()).toContain('No lines match these filters.');

    await search.setValue('database');
    const errors = wrapper.findAll('button').find((button) => button.text() === 'Errors');
    await errors!.trigger('click');
    expect(wrapper.text()).toContain('database failed');
    wrapper.unmount();
  });

  it('shows an empty state when no runtime files exist', async () => {
    state.logs = [];
    const wrapper = await renderPanel();

    expect(wrapper.text()).toContain('No panel logs yet');
    wrapper.unmount();
  });
});