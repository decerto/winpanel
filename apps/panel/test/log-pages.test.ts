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
  siteLogs: [] as any[],
  siteLogResults: {} as Record<string, any>,
  siteLogsList: vi.fn(async () => state.siteLogs),
  siteLogRead: vi.fn(async ({ id }: { id: string }) => state.siteLogResults[id] ?? null),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { slug: 'example' } }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    sites: {
      accessLog: { query: state.accessQuery },
      runtimeLogs: { query: state.siteLogsList },
      runtimeLog: { query: state.siteLogRead },
    },
    logs: { list: { query: state.logsList }, read: { query: state.logsRead } },
  },
  describeError: (error: unknown) => String(error),
}));

const RequestLedger = (await import('../src/components/RequestLedger.vue')).default;
const SiteRuntimeLogPage = (await import('../src/pages/site/SiteRuntimeLogPage.vue')).default;
const PanelLogsPage = (await import('../src/pages/PanelLogsPage.vue')).default;

function accessSite() {
  return {
    slug: 'example',
    displayName: 'Example site',
    domains: ['example.com'],
  };
}

function logFile(id: string, message: string, level = 'info') {
  return {
    id,
    size: 128,
    modifiedAt: new Date(0),
    lines: [{ at: Date.now(), level, message, raw: message }],
    truncated: false,
  };
}

async function renderLedger(status: 'all' | '5xx' = 'all') {
  const wrapper = mount(RequestLedger, {
    props: { slug: 'example', range: '7d' as const, status },
  });
  await flushPromises();
  return wrapper;
}

async function renderSiteLogs() {
  const wrapper = mount(SiteRuntimeLogPage, {
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
    { id: 'stalwart/winpanel-stalwart.err.log', size: 64, modifiedAt: new Date(0) },
  ];
  state.panelLogResults = {
    'agent.out.log': logFile('agent.out.log', 'agent started'),
    'agent.err.log': logFile('agent.err.log', 'database failed', 'error'),
    'stalwart/winpanel-stalwart.err.log': logFile(
      'stalwart/winpanel-stalwart.err.log',
      'smtp listener stopped',
      'error',
    ),
  };
  state.siteLogs = [
    { id: 'winpanel-site-example-blue.out.log', size: 128, modifiedAt: new Date(0) },
    { id: 'winpanel-site-example-blue.err.log', size: 256, modifiedAt: new Date(0) },
  ];
  state.siteLogResults = {
    'winpanel-site-example-blue.out.log': logFile(
      'winpanel-site-example-blue.out.log',
      'Listening on port 4100',
    ),
    'winpanel-site-example-blue.err.log': logFile(
      'winpanel-site-example-blue.err.log',
      'Error: connect ECONNREFUSED',
      'error',
    ),
  };
  state.accessQuery.mockClear();
  state.logsList.mockClear();
  state.logsRead.mockClear();
  state.siteLogsList.mockClear();
  state.siteLogRead.mockClear();
});

describe('website request ledger', () => {
  it('renders request rows and reloads when the response class changes', async () => {
    const wrapper = await renderLedger();

    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('/home');
    expect(wrapper.text()).toContain('203.0.113.8');

    await wrapper.setProps({ status: '5xx' });
    await flushPromises();

    expect(state.accessQuery).toHaveBeenLastCalledWith(expect.objectContaining({ status: '5xx' }));
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    wrapper.unmount();
  });

  it('passes a search term to the agent', async () => {
    const wrapper = await renderLedger();

    await wrapper.find('input[type="search"]').setValue('/save');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.accessQuery).toHaveBeenLastCalledWith(expect.objectContaining({ search: '/save' }));
    wrapper.unmount();
  });
});

describe('website runtime logs', () => {
  it('opens the error output first and filters its lines', async () => {
    const wrapper = await renderSiteLogs();

    expect(state.siteLogRead).toHaveBeenLastCalledWith({
      slug: 'example',
      id: 'winpanel-site-example-blue.err.log',
      lines: 500,
    });
    expect(wrapper.text()).toContain('Error: connect ECONNREFUSED');

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('winpanel-site-example-blue.out.log'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Listening on port 4100');

    await wrapper.find('input[placeholder="Search this log"]').setValue('missing');
    expect(wrapper.text()).toContain('No lines match these filters.');
    wrapper.unmount();
  });

  it('opens the PHP error log first when the website has one', async () => {
    state.siteLogs = [
      { id: 'winpanel-site-example-blue.out.log', size: 128, modifiedAt: new Date(0) },
      { id: 'php-error.log', size: 64, modifiedAt: new Date(0) },
    ];
    state.siteLogResults['php-error.log'] = logFile(
      'php-error.log',
      'PHP Fatal error: Uncaught Error: Call to undefined function',
      'error',
    );

    const wrapper = await renderSiteLogs();

    expect(state.siteLogRead).toHaveBeenLastCalledWith({
      slug: 'example',
      id: 'php-error.log',
      lines: 500,
    });
    expect(wrapper.text()).toContain('PHP errors');
    wrapper.unmount();
  });

  it('explains when the website has written no output', async () => {
    state.siteLogs = [];
    const wrapper = await renderSiteLogs();

    expect(wrapper.text()).toContain('No application output yet');
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

  it('groups the files by the service that wrote them', async () => {
    const wrapper = await renderPanel();
    const nav = wrapper.find('nav');

    expect(nav.text()).toContain('Panel');
    expect(nav.text()).toContain('Mail');
    const mailGroup = nav.findAll('section').find((section) => section.find('button').text().includes('Mail'));
    expect(mailGroup).toBeDefined();
    await mailGroup!.find('button').trigger('click');
    // The folder is said by the section, so the button shows the file alone.
    expect(nav.text()).toContain('winpanel-stalwart.err.log');
    expect(nav.text()).not.toContain('stalwart/winpanel-stalwart.err.log');
    wrapper.unmount();
  });

  it('filters the file browser by category and filename', async () => {
    const wrapper = await renderPanel();
    const nav = wrapper.find('nav');
    const fileFilter = wrapper.find('input[placeholder="Filter files"]');

    await fileFilter.setValue('stalwart');
    expect(nav.text()).toContain('winpanel-stalwart.err.log');
    expect(nav.text()).not.toContain('agent.err.log');

    await fileFilter.setValue('');
    const mailCategory = wrapper
      .findAll('button[aria-pressed]')
      .find((button) => button.text().includes('Mail'));
    expect(mailCategory).toBeDefined();
    await mailCategory!.trigger('click');

    expect(nav.text()).toContain('winpanel-stalwart.err.log');
    expect(nav.text()).not.toContain('agent.err.log');
    wrapper.unmount();
  });

  it('orders files newest first and reports empty file filters', async () => {
    state.logs = [
      { id: 'agent.out.log', size: 128, modifiedAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'agent.err.log', size: 256, modifiedAt: new Date('2026-08-03T00:00:00Z') },
      ...state.logs.filter((log) => log.id.startsWith('stalwart/')),
    ];

    const wrapper = await renderPanel();
    const nav = wrapper.find('nav');
    const fileFilter = wrapper.find('input[placeholder="Filter files"]');

    await fileFilter.setValue('agent');
    const fileButtons = nav.findAll('button').filter((button) => button.text().includes('.log'));
    expect(fileButtons.map((button) => button.find('span.block').text())).toEqual([
      'agent.err.log',
      'agent.out.log',
    ]);

    await fileFilter.setValue('does-not-exist');
    expect(nav.text()).toContain('No log files match this filter.');
    wrapper.unmount();
  });

  it('shows an empty state when no runtime files exist', async () => {
    state.logs = [];
    const wrapper = await renderPanel();

    expect(wrapper.text()).toContain('No panel logs yet');
    wrapper.unmount();
  });
});