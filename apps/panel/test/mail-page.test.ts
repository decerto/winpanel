import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const state = vi.hoisted(() => ({
  me: { id: 'admin', role: 'admin' as string },
  blockedIps: [
    {
      id: 'rule-opaque-id',
      address: '203.0.113.0/24',
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ],
  blockIp: vi.fn(async () => ({ ok: true, id: 'new-rule' })),
  unblockIp: vi.fn(async () => ({ ok: true })),
  blockedIpsQuery: vi.fn(async () => state.blockedIps),
}));

vi.mock('vue-router', () => ({
  RouterLink: { template: '<a><slot /></a>' },
}));

vi.mock('../src/lib/api', () => ({
  api: {
    auth: { me: { query: vi.fn(async () => state.me) } },
    sites: {
      list: {
        query: vi.fn(async () => [
          { slug: 'example', displayName: 'Example', domains: ['example.com'] },
        ]),
      },
    },
    mail: {
      serverStatus: { query: vi.fn(async () => ({ connected: true, message: 'Ready' })) },
      available: { query: vi.fn(async () => ({ connected: true, message: 'Ready' })) },
      mailboxes: { query: vi.fn(async () => []) },
      blockedIps: { query: state.blockedIpsQuery },
      blockIp: { mutate: state.blockIp },
      unblockIp: { mutate: state.unblockIp },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const MailPage = (await import('../src/pages/MailPage.vue')).default;

beforeEach(() => {
  state.me = { id: 'admin', role: 'admin' };
  state.blockedIps = [
    {
      id: 'rule-opaque-id',
      address: '203.0.113.0/24',
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  ];
  state.blockIp.mockClear();
  state.unblockIp.mockClear();
  state.blockedIpsQuery.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function render() {
  const wrapper = mount(MailPage);
  await flushPromises();
  return wrapper;
}

describe('MailPage inbound access', () => {
  it('shows blocked addresses only to administrators', async () => {
    const wrapper = await render();

    expect(wrapper.get('#inbound-access-heading').text()).toBe('Inbound access');
    expect(wrapper.text()).toContain('203.0.113.0/24');
    expect(state.blockedIpsQuery).toHaveBeenCalledOnce();
  });

  it('removes a block by its opaque server rule id', async () => {
    const wrapper = await render();

    await wrapper
      .get('button[aria-label="Allow connections from 203.0.113.0/24"]')
      .trigger('click');
    await flushPromises();

    expect(state.unblockIp).toHaveBeenCalledWith({ id: 'rule-opaque-id' });
  });

  it('creates an address block from the form', async () => {
    const wrapper = await render();
    await wrapper.get('#blocked-ip-address').setValue('2001:db8::/32');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(state.blockIp).toHaveBeenCalledWith({ address: '2001:db8::/32' });
  });

  it('does not expose machine-wide blocks to customers', async () => {
    state.me = { id: 'customer', role: 'user' };
    const wrapper = await render();

    expect(wrapper.find('#inbound-access-heading').exists()).toBe(false);
    expect(state.blockedIpsQuery).not.toHaveBeenCalled();
  });
});
