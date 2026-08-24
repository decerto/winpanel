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
          problem: null,
        })),
      },
      attachableSites: { query: vi.fn(async () => []) },
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

beforeEach(() => {
  state.me = { id: 'me', role: 'superadmin' };
  state.databases = [];
  state.created = [];
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
});
