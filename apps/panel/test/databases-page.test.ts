import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The Databases page, and the one thing somebody actually came to it for.
 *
 * Creating a database is only useful if you leave with something you can paste
 * into an application. The password is shown exactly once, so a page that
 * shows it without the host, port, username and the URI they go in is a page
 * that has to be used twice — and the second time, the password is gone.
 *
 * These tests are about that: what is on screen after a create, and what is
 * reachable afterwards for a database whose password you already have.
 */

const state = vi.hoisted(() => ({
  me: { id: 'me', role: 'superadmin' as string },
  engines: {
    engines: [
      {
        id: 'postgres',
        label: 'PostgreSQL',
        description: 'Relational.',
        port: 5432,
        sql: true,
        browser: 'adminer',
        ready: true,
      },
      {
        id: 'mongodb',
        label: 'MongoDB',
        description: 'Documents.',
        port: 27017,
        sql: false,
        browser: 'built-in',
        ready: true,
      },
    ],
    visible: true,
    any: true,
    unfinished: [] as string[],
  },
  databases: [] as any[],
  created: [] as any[],
  attachable: [] as any[],
  attached: [] as any[],
  resized: [] as any[],
  revealPassword: 'revealed-secret',
}));

vi.mock('vue-router', () => ({
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    auth: { me: { query: vi.fn(async () => state.me) } },
    databases: {
      engines: { query: vi.fn(async () => state.engines) },
      listAll: {
        query: vi.fn(async () => ({
          databases: state.databases,
          limit: null,
          used: state.databases.length,
          storageQuotaBytes: 0,
          storageAllocatedBytes: 0,
          problem: null,
        })),
      },
      attachableSites: { query: vi.fn(async () => state.attachable) },
      attachSite: {
        mutate: vi.fn(async (input: any) => {
          state.attached.push(input);
          return { ok: true, siteSlug: input.slug };
        }),
      },
      networkAccess: {
        query: vi.fn(async () => ({
          policy: { mode: 'loopback', remoteCidrs: [] },
          yourIp: '203.0.113.9',
          addresses: ['57.129.70.162'],
          port: 5432,
        })),
      },
      setNetworkAccess: {
        mutate: vi.fn(async (input: any) => ({
          policy: { mode: input.mode, remoteCidrs: input.remoteCidrs },
        })),
      },
      create: {
        mutate: vi.fn(async (input: any) => {
          state.created.push(input);
          return {
            id: 'new-id',
            engine: 'postgres',
            name: 'u_me_shop',
            username: 'u_me_shop',
            password: 'brand-new-secret',
            generated: true,
            connection: {
              engine: 'postgres',
              host: '127.0.0.1',
              port: 5432,
              database: 'u_me_shop',
              username: 'u_me_shop',
              uriTemplate: 'postgresql://u_me_shop:PASSWORD@127.0.0.1:5432/u_me_shop',
            },
          };
        }),
      },
      revealPassword: { query: vi.fn(async () => ({ password: state.revealPassword })) },
      setPassword: { mutate: vi.fn(async () => ({ name: 'x', password: 'p', generated: true })) },
      setSizeLimit: {
        mutate: vi.fn(async (input: any) => {
          state.resized.push(input);
          return { ok: true, sizeLimitBytes: input.sizeLimitBytes };
        }),
      },
      drop: { mutate: vi.fn(async () => ({ ok: true })) },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const DatabasesPage = (await import('../src/pages/DatabasesPage.vue')).default;

function database(over: Record<string, unknown> = {}) {
  return {
    id: 'db-1',
    engine: 'postgres',
    engineLabel: 'PostgreSQL',
    browser: 'adminer',
    name: 'u_me_shop',
    username: 'u_me_shop',
    siteSlug: null,
    siteName: null,
    ownerUsername: 'owner',
    sizeBytes: 512 * 1024 ** 2,
    sizeLimitBytes: 2 * 1024 ** 3,
    network: { mode: 'loopback', remoteCidrs: [] },
    createdAt: new Date(0),
    connection: {
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'u_me_shop',
      username: 'u_me_shop',
      uriTemplate: 'postgresql://u_me_shop:PASSWORD@127.0.0.1:5432/u_me_shop',
    },
    ...over,
  };
}

async function render() {
  const wrapper = mount(DatabasesPage);
  await flushPromises();
  return wrapper;
}

/** A button found by the words on it, the way somebody using the page finds it. */
function button(wrapper: any, label: string) {
  return wrapper.findAll('button').find((node: any) => node.text().includes(label));
}

async function chooseSearchableOption(
  wrapper: any,
  triggerLabel: string,
  optionLabel: string,
  filter?: string,
): Promise<void> {
  await wrapper.find(`button[aria-label="${triggerLabel}"]`).trigger('click');
  if (filter) await wrapper.find('input[placeholder*="filter"]').setValue(filter);

  const option = wrapper
    .findAll('button[role="option"]')
    .find((node: any) => node.text().trim() === optionLabel);
  expect(option).toBeDefined();
  await option!.trigger('click');
}

beforeEach(() => {
  state.me = { id: 'me', role: 'superadmin' };
  state.databases = [];
  state.created = [];
  state.attachable = [];
  state.attached = [];
  state.resized = [];
  state.engines.unfinished = [];
});

describe('after making a database', () => {
  it('hands over the connection string with the password already in it', async () => {
    const wrapper = await render();

    await button(wrapper, 'Add a database')!.trigger('click');
    await wrapper.find('#db-name').setValue('shop');
    await button(wrapper, 'Create database')!.trigger('click');
    await flushPromises();

    const text = wrapper.text();
    // The whole point: something that can be pasted into an application as-is.
    expect(text).toContain('postgresql://u_me_shop:brand-new-secret@127.0.0.1:5432/u_me_shop');
    // And the pieces, for configuration formats that ask for them separately.
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('5432');
    expect(text).toContain('u_me_shop');
    expect(text).toContain('brand-new-secret');
  });

  it('says where the connection string normally goes', async () => {
    const wrapper = await render();

    await button(wrapper, 'Add a database')!.trigger('click');
    await wrapper.find('#db-name').setValue('shop');
    await button(wrapper, 'Create database')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('DATABASE_URL');
  });

  it('sends the chosen storage allowance in bytes', async () => {
    const wrapper = await render();
    await button(wrapper, 'Add a database')!.trigger('click');
    await wrapper.find('#db-name').setValue('shop');
    await wrapper.find('#db-size').setValue('2.5');
    await button(wrapper, 'Create database')!.trigger('click');
    await flushPromises();

    expect(state.created[0].sizeLimitBytes).toBe(2.5 * 1024 ** 3);
  });
});

describe('an existing database', () => {
  it('offers its connection details without revealing the password', async () => {
    state.databases = [database()];
    const wrapper = await render();

    await button(wrapper, 'Connect')!.trigger('click');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('postgresql://u_me_shop:PASSWORD@127.0.0.1:5432/u_me_shop');
    // Nothing live on screen for somebody walking past.
    expect(text).not.toContain('revealed-secret');
  });

  it('fills the password into the connection string when it is shown', async () => {
    state.databases = [database()];
    const wrapper = await render();

    await button(wrapper, 'Show password')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(
      'postgresql://u_me_shop:revealed-secret@127.0.0.1:5432/u_me_shop',
    );
  });

  it('uses the server host when remote access is enabled', async () => {
    state.databases = [
      database({
        connection: {
          engine: 'postgres',
          host: '203.0.113.10',
          port: 5432,
          database: 'u_me_shop',
          username: 'u_me_shop',
          uriTemplate: 'postgresql://u_me_shop:PASSWORD@203.0.113.10:5432/u_me_shop',
        },
      }),
    ];
    const wrapper = await render();

    await button(wrapper, 'Connect')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('postgresql://u_me_shop:PASSWORD@203.0.113.10:5432/u_me_shop');
    expect(wrapper.text()).toContain('Remote access is enabled');
  });

  it("tells a MongoDB database where its login lives", async () => {
    // A driver told nothing looks in `admin`, finds no such user, and reports
    // the password as wrong — so the authSource has to be on screen.
    state.databases = [
      database({
        engine: 'mongodb',
        engineLabel: 'MongoDB',
        browser: 'built-in',
        connection: {
          engine: 'mongodb',
          host: '127.0.0.1',
          port: 27017,
          database: 'u_me_shop',
          username: 'u_me_shop',
          uriTemplate:
            'mongodb://u_me_shop:PASSWORD@127.0.0.1:27017/u_me_shop?authSource=u_me_shop',
        },
      }),
    ];

    const wrapper = await render();
    await button(wrapper, 'Connect')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Auth source');
    expect(wrapper.text()).toContain('authSource=u_me_shop');
    expect(wrapper.text()).toContain('MONGODB_URI');
  });

  it('shows usage and changes the storage allowance', async () => {
    state.databases = [database()];
    const wrapper = await render();

    expect(wrapper.text()).toContain('512.0 MB used of 2.0 GB');
    await button(wrapper, 'Storage')!.trigger('click');
    await wrapper.find('#db-size-db-1').setValue('3');
    await button(wrapper, 'Save allowance')!.trigger('click');
    await flushPromises();

    expect(state.resized).toEqual([{ id: 'db-1', sizeLimitBytes: 3 * 1024 ** 3 }]);
  });
});

describe('what the page offers', () => {
  it('only lets you choose an engine the server actually has', async () => {
    state.engines.engines = state.engines.engines.filter((engine) => engine.id === 'postgres');
    const wrapper = await render();

    await button(wrapper, 'Add a database')!.trigger('click');
    await flushPromises();

    const options = wrapper.find('#db-engine').findAll('option');
    expect(options.map((option: any) => option.text())).toEqual(['PostgreSQL']);
  });

  /*
   * A database is regularly made before anybody knows which website will use
   * it, and the choice made at creation used to be the only one on offer —
   * so getting it wrong meant deleting the database and starting again.
   */
  it('moves an existing database to another website', async () => {
    state.databases = [database()];
    state.attachable = [
      { slug: 'other-site', name: 'Another website' },
      { slug: 'kitora-io', name: 'Kitora' },
    ];
    const wrapper = await render();

    expect(wrapper.find('button[aria-label="Website using u_me_shop"]').exists()).toBe(true);
    await chooseSearchableOption(wrapper, 'Website using u_me_shop', 'Kitora', 'kitora');
    await flushPromises();

    expect(state.attached).toEqual([{ id: 'db-1', slug: 'kitora-io' }]);
  });

  it('unties a database from its website', async () => {
    state.databases = [database({ siteSlug: 'kitora-io', siteName: 'Kitora' })];
    state.attachable = [{ slug: 'kitora-io', name: 'Kitora' }];
    const wrapper = await render();

    await chooseSearchableOption(
      wrapper,
      'Website using u_me_shop',
      'Not tied to a website',
    );
    await flushPromises();

    expect(state.attached).toEqual([{ id: 'db-1', slug: null }]);
  });

  it('does not show website assignment to customer accounts', async () => {
    state.me = { id: 'me', role: 'user' };
    state.databases = [database()];
    state.attachable = [{ slug: 'kitora-io', name: 'Kitora' }];
    const wrapper = await render();

    expect(wrapper.find('button[aria-label="Website using u_me_shop"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Used by');
  });

  /*
   * Remote access belongs to whoever owns the database, so it is offered here
   * rather than in the server's settings — the panel's owner is not the person
   * who connects to it.
   */
  it('offers remote access per database, with the address you are on', async () => {
    state.databases = [database()];
    const wrapper = await render();

    await button(wrapper, 'Remote access')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Who can reach u_me_shop');

    const chosen = wrapper.findAll('button').find((node: any) => node.text() === 'Chosen addresses');
    await chosen!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Add my IP (203.0.113.9)');
  });
});
