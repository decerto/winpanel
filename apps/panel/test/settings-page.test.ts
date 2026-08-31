import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const state = vi.hoisted(() => ({
  saved: [] as any[],
  settings: {
    mode: 'local',
    fromAddress: 'existing@example.com',
    fromName: 'WinPanel',
    localPasswordConfigured: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    smtpUsername: null,
    smtpPasswordConfigured: false,
  } as any,
  localAddresses: [
    { value: 'existing@example.com', label: 'existing@example.com', hint: 'Current sender' },
    { value: 'alerts@example.com', label: 'alerts@example.com', hint: 'Alias for existing@example.com' },
  ],
  saveSettings: vi.fn(async (input: any) => {
    state.saved.push(input);
    const mode = input.mode === 'new' ? 'local' : input.mode;
    return {
      mode,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      localPasswordConfigured: mode === 'local',
      smtpHost: mode === 'external' ? input.smtpHost : null,
      smtpPort: mode === 'external' ? input.smtpPort : null,
      smtpSecurity: mode === 'external' ? input.smtpSecurity : null,
      smtpUsername: mode === 'external' ? input.smtpUsername : null,
      smtpPasswordConfigured: false,
    };
  }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    auth: { me: { query: vi.fn(async () => ({ id: 'owner', role: 'superadmin' })) } },
    system: {
      info: {
        query: vi.fn(async () => ({
          version: '1.13.2',
          hostname: 'server',
          addresses: ['192.0.2.10'],
          uptimeSeconds: 60,
          paths: { root: 'C:\\WinPanel', sites: 'C:\\Sites' },
          httpsEnabled: true,
        })),
      },
      backgroundServices: { query: vi.fn(async () => []) },
      panelCertificate: {
        query: vi.fn(async () => ({
          httpsEnabled: true,
          source: 'self-signed',
          hostname: null,
          url: null,
          issuer: null,
          expiresAt: null,
          fingerprint: null,
          dnsPointsHere: null,
          suggestedIpv4: '192.0.2.10',
        })),
      },
      releases: { query: vi.fn(async () => ({ repositoryUrl: 'https://github.com/decerto/winpanel', releases: [] })) },
    },
    mail: { serverStatus: { query: vi.fn(async () => null) } },
    gameServers: { settings: { query: vi.fn(async () => null) } },
    notifications: {
      settings: { query: vi.fn(async () => state.settings) },
      localAddresses: { query: vi.fn(async () => state.localAddresses) },
      saveSettings: { mutate: state.saveSettings },
      test: { mutate: vi.fn(async () => ({ ok: true })) },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const SettingsPage = (await import('../src/pages/SettingsPage.vue')).default;
const wrappers: any[] = [];

beforeEach(() => {
  state.saved = [];
  state.settings = {
    mode: 'local',
    fromAddress: 'existing@example.com',
    fromName: 'WinPanel',
    localPasswordConfigured: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    smtpUsername: null,
    smtpPasswordConfigured: false,
  };
  state.saveSettings.mockClear();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

async function render() {
  const wrapper = mount(SettingsPage, {
    global: {
      stubs: {
        ComponentsPanel: { template: '<div />' },
        PageHeader: { props: ['title'], template: '<h1>{{ title }}</h1>' },
        AlertMessage: { template: '<div><slot /></div>' },
        HowTo: { template: '<div><slot /></div>' },
        ServerPathPicker: { template: '<div />' },
        Tooltip: { template: '<div><slot /></div>' },
      },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  await flushPromises();
  return wrapper;
}

function senderForm(wrapper: any) {
  return wrapper.findAll('form').find((form: any) => form.find('#panel-email-address').exists());
}

describe('Settings panel email sender modes', () => {
  it('offers three modes and reuses a selected existing mailbox', async () => {
    const wrapper = await render();

    expect(wrapper.text()).toContain('From this server');
    expect(wrapper.text()).toContain('External SMTP');
    expect(wrapper.text()).toContain('Create New');

    await wrapper.get('#panel-email-address').trigger('click');
    await wrapper
      .findAll('[role="option"]')
      .find((option: any) => option.text().includes('alerts@example.com'))
      ?.trigger('click');
    await wrapper.get('#panel-email-local-password').setValue('mailbox secret');
    await senderForm(wrapper).trigger('submit');
    await flushPromises();

    expect(state.saved[0]).toMatchObject({
      mode: 'local',
      fromAddress: 'alerts@example.com',
      localPassword: 'mailbox secret',
    });
  });

  it('sends Create New as a separate mailbox setup mode', async () => {
    const wrapper = await render();

    await wrapper
      .findAll('button')
      .find((button: any) => button.text().trim() === 'Create New')
      ?.trigger('click');
    await wrapper.get('#panel-email-address').setValue('noreply@example.com');
    await senderForm(wrapper).trigger('submit');
    await flushPromises();

    expect(state.saved[0]).toMatchObject({
      mode: 'new',
      fromAddress: 'noreply@example.com',
    });
    expect(state.saved[0]).not.toHaveProperty('localPassword');
  });

  it('keeps external SMTP as the third delivery contract', async () => {
    const wrapper = await render();

    await wrapper
      .findAll('button')
      .find((button: any) => button.text().trim() === 'External SMTP')
      ?.trigger('click');
    await wrapper.get('#panel-email-address').setValue('owner@example.net');
    await wrapper.get('#panel-smtp-host').setValue('smtp.example.net');
    await senderForm(wrapper).trigger('submit');
    await flushPromises();

    expect(state.saved[0]).toMatchObject({
      mode: 'external',
      fromAddress: 'owner@example.net',
      smtpHost: 'smtp.example.net',
    });
  });
});
