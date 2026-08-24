import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { RouterLinkStub } from '@vue/test-utils';

/**
 * Server Settings belong to administrators. A customer who can manage a game
 * server must still be able to paste a Workshop link, but must never be
 * pointed at /settings — they cannot open that page.
 */

const state = vi.hoisted(() => ({
  status: {
    supported: true,
    searchable: false,
    steamcmdInstalled: true,
    needsAccount: false,
    browseUrl: 'https://steamcommunity.com/app/108600/workshop/',
    installed: 0,
    limit: 200,
    configPath: 'Server/testerino.ini',
  },
  items: [] as unknown[],
}));

vi.mock('../src/lib/api', () => ({
  api: {
    gameServers: {
      workshop: {
        status: { query: vi.fn(async () => state.status) },
        list: { query: vi.fn(async () => state.items) },
        browse: { query: vi.fn(async () => ({ total: 0, page: 1, pageSize: 24, items: [] })) },
        lookup: { mutate: vi.fn() },
        add: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        remove: { mutate: vi.fn() },
      },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const GameWorkshopPanel = (await import('../src/components/GameWorkshopPanel.vue')).default;

async function render(isAdmin: boolean) {
  const wrapper = mount(GameWorkshopPanel, {
    props: { slug: 'testerino', isAdmin },
    global: {
      stubs: { RouterLink: RouterLinkStub },
    },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  state.status = {
    supported: true,
    searchable: false,
    steamcmdInstalled: true,
    needsAccount: false,
    browseUrl: 'https://steamcommunity.com/app/108600/workshop/',
    installed: 0,
    limit: 200,
    configPath: 'Server/testerino.ini',
  };
  state.items = [];
});

describe('Workshop Settings hints', () => {
  it('shows the Steam Web API key hint only to administrators', async () => {
    const admin = await render(true);
    expect(admin.text()).toContain('Add a Steam Web API key');
    expect(admin.text()).toContain('Settings');
    expect(admin.findAllComponents(RouterLinkStub).some((link) => link.props('to') === '/settings')).toBe(true);

    const customer = await render(false);
    expect(customer.text()).not.toContain('Add a Steam Web API key');
    expect(customer.text()).not.toContain('Settings');
    expect(customer.findAllComponents(RouterLinkStub).some((link) => link.props('to') === '/settings')).toBe(false);
  });

  it('tells a customer to ask an administrator when SteamCMD is missing', async () => {
    state.status.steamcmdInstalled = false;

    const admin = await render(true);
    expect(admin.text()).toContain('Install it in Settings');

    const customer = await render(false);
    expect(customer.text()).toContain('Ask an administrator to install it.');
    expect(customer.text()).not.toContain('Settings');
  });
});
