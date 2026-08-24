import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { siteContextKey } from '../src/lib/site-context';

/**
 * The Databases tab on a website.
 *
 * It is the same databases as the server-wide page, filtered to one site, and
 * it has drifted from it before: remote access was added to one and not the
 * other, so a customer who reached their database through their website could
 * not let their own machine connect. What is here is a guard against that
 * happening again.
 */

const state = vi.hoisted(() => ({
  me: { id: 'me', role: 'user' as string },
  databases: [] as any[],
  saved: [] as any[],
}));

vi.mock('vue-router', () => ({
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
  useRoute: () => ({ params: { slug: 'demo' } }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    auth: { me: { query: vi.fn(async () => state.me) } },
    databases: {
      overview: {
        query: vi.fn(async () => ({
          engines: [
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
          installed: true,
          databases: state.databases,
          limit: null,
          used: state.databases.length,
          problem: null,
        })),
      },
      networkAccess: {
        query: vi.fn(async () => ({
          policy: { mode: 'loopback', remoteCidrs: [] },
          yourIp: '203.0.113.9',
          addresses: ['57.129.70.162'],
          port: 27017,
        })),
      },
      setNetworkAccess: {
        mutate: vi.fn(async (input: any) => {
          state.saved.push(input);
          return { policy: { mode: input.mode, remoteCidrs: input.remoteCidrs } };
        }),
      },
      create: { mutate: vi.fn() },
      drop: { mutate: vi.fn() },
      setPassword: { mutate: vi.fn() },
      revealPassword: { query: vi.fn(async () => ({ password: 'revealed-secret' })) },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const SiteDatabasesPage = (await import('../src/pages/site/SiteDatabasesPage.vue')).default;

function database(over: Record<string, unknown> = {}) {
  return {
    id: 'db-1',
    engine: 'mongodb',
    engineLabel: 'MongoDB',
    browser: 'built-in',
    name: 'u_me_test',
    username: 'u_me_test',
    siteSlug: 'demo',
    siteName: 'Demo',
    ownerUsername: 'me',
    network: { mode: 'loopback', remoteCidrs: [] },
    createdAt: new Date(0),
    connection: {
      engine: 'mongodb',
      host: '127.0.0.1',
      port: 27017,
      database: 'u_me_test',
      username: 'u_me_test',
      uriTemplate: 'mongodb://u_me_test:PASSWORD@127.0.0.1:27017/u_me_test?authSource=u_me_test',
    },
    ...over,
  };
}

async function render() {
  const wrapper = mount(SiteDatabasesPage, {
    global: {
      provide: {
        [siteContextKey as unknown as symbol]: {
          site: ref({ slug: 'demo', displayName: 'Demo', runtime: 'php' }),
          reload: vi.fn(),
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

function button(wrapper: any, label: string) {
  return wrapper.findAll('button').find((node: any) => node.text().includes(label));
}

beforeEach(() => {
  state.me = { id: 'me', role: 'user' };
  state.databases = [database()];
  state.saved = [];
});

describe('a website\u2019s databases', () => {
  it('lets the owner open their own database to their own machine', async () => {
    const wrapper = await render();

    await button(wrapper, 'Remote access')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Who can reach u_me_test');

    const chosen = wrapper.findAll('button').find((node: any) => node.text() === 'Chosen addresses');
    await chosen!.trigger('click');
    await flushPromises();

    // The address they are connecting from, so nobody has to look it up.
    await button(wrapper, 'Add my IP (203.0.113.9)')!.trigger('click');
    await button(wrapper, 'Apply')!.trigger('click');
    await flushPromises();

    expect(state.saved).toEqual([
      { id: 'db-1', mode: 'whitelist', remoteCidrs: ['203.0.113.9'] },
    ]);
  });

  it('says so on the button when a database is already open', async () => {
    state.databases = [database({ network: { mode: 'any', remoteCidrs: [] } })];
    const wrapper = await render();

    expect(button(wrapper, 'Remote access on')).toBeDefined();
  });
});
