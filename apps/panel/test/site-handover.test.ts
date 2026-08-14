import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { siteContextKey } from '../src/lib/site-context';

/**
 * Handing a website to somebody, from the site's Settings tab.
 *
 * The server already refuses anything it should not do (users.assignSite is
 * admin-only and re-checks the customer's website limit), so these tests are
 * about the other half: an administrator should see a clear, honest control,
 * and a customer should not see the control at all — a button that only ever
 * fails looks like a broken panel rather than a boundary.
 */

const state = vi.hoisted(() => ({
  me: { id: 'me', role: 'superadmin' as string },
  people: [] as any[],
  assigned: [] as any[],
  peopleAsked: 0,
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { slug: 'demo' } }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    auth: { me: { query: vi.fn(async () => state.me) } },
    users: {
      list: {
        query: vi.fn(async () => {
          state.peopleAsked += 1;
          return state.people;
        }),
      },
      assignSite: {
        mutate: vi.fn(async (input: unknown) => {
          state.assigned.push(input);
          return { ok: true };
        }),
      },
    },
    sites: {
      getEnv: { query: vi.fn(async () => ({})) },
      setEnv: { mutate: vi.fn(async () => ({ note: '' })) },
      setSharedFolder: { mutate: vi.fn(async () => ({ note: '' })) },
      setNodeVersion: { mutate: vi.fn(async () => ({ note: '' })) },
      remove: { mutate: vi.fn(async () => ({})) },
    },
    system: { nodeVersions: { query: vi.fn(async () => []) } },
  },
  describeError: (error: unknown) => String(error),
}));

const SiteSettingsPage = (await import('../src/pages/site/SiteSettingsPage.vue')).default;

function makeSite(ownerUserId: string | null) {
  return {
    slug: 'demo',
    displayName: 'Demo',
    runtime: 'static',
    manifest: null,
    sharedFolderEnabled: true,
    ownerUserId,
  };
}

async function render(ownerUserId: string | null = null) {
  const site = ref<any>(makeSite(ownerUserId));
  const reload = vi.fn(async () => {});
  const wrapper = mount(SiteSettingsPage, {
    global: {
      provide: {
        [siteContextKey as unknown as string]: {
          site,
          reload,
          deploy: vi.fn(async () => {}),
          deploying: ref(false),
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, reload };
}

beforeEach(() => {
  state.me = { id: 'me', role: 'superadmin' };
  state.people = [
    { id: 'me', username: 'owner', role: 'superadmin' },
    { id: 'f', username: 'freya', role: 'user' },
  ];
  state.assigned = [];
  state.peopleAsked = 0;
});

describe('handing a website over', () => {
  it('offers everybody on the server, with the server itself first', async () => {
    const { wrapper } = await render();

    const options = wrapper.findAll('#handover-to option').map((option: any) => option.text());
    expect(options).toEqual(['The server (nobody in particular)', 'owner', 'freya']);
  });

  it('starts on whoever the website belongs to now', async () => {
    const { wrapper } = await render('f');

    expect((wrapper.find('#handover-to').element as HTMLSelectElement).value).toBe('f');
    // Nothing to do while the choice matches reality.
    expect(
      wrapper.findAll('button').find((b: any) => b.text().includes('Hand it over'))!.attributes(
        'disabled',
      ),
    ).toBeDefined();
  });

  it('hands the website to the chosen person', async () => {
    const { wrapper, reload } = await render();

    await wrapper.find('#handover-to').setValue('f');
    await wrapper
      .findAll('button')
      .find((b: any) => b.text().includes('Hand it over'))!
      .trigger('click');
    await flushPromises();

    expect(state.assigned).toEqual([{ slug: 'demo', userId: 'f' }]);
    expect(reload).toHaveBeenCalled();
    expect(wrapper.text()).toContain('now belongs to freya');
  });

  it('gives the website back to the server when nobody is chosen', async () => {
    const { wrapper } = await render('f');

    await wrapper.find('#handover-to').setValue('');
    await wrapper
      .findAll('button')
      .find((b: any) => b.text().includes('Hand it over'))!
      .trigger('click');
    await flushPromises();

    expect(state.assigned).toEqual([{ slug: 'demo', userId: null }]);
    expect(wrapper.text()).toContain('belongs to the server again');
  });

  it('can move a website on again, away from the customer it was given to', async () => {
    /*
     * A handover is not one-way: the wrong person is chosen, or the site
     * needs moving to somebody else entirely. Whoever runs the server must be
     * able to open a customer's website and hand it straight on - the current
     * owner is only the pre-selected choice, never a lock.
     */
    state.people.push({ id: 'g', username: 'greg', role: 'user' });
    const { wrapper, reload } = await render('f');

    // It starts on the current owner and is free to move from there.
    expect((wrapper.find('#handover-to').element as HTMLSelectElement).value).toBe('f');

    await wrapper.find('#handover-to').setValue('g');
    await wrapper
      .findAll('button')
      .find((b: any) => b.text().includes('Hand it over'))!
      .trigger('click');
    await flushPromises();

    expect(state.assigned).toEqual([{ slug: 'demo', userId: 'g' }]);
    expect(reload).toHaveBeenCalled();
    expect(wrapper.text()).toContain('now belongs to greg');
  });

  it('is not shown to a customer at all', async () => {
    state.me = { id: 'c', role: 'user' };
    const { wrapper } = await render('c');

    expect(wrapper.text()).not.toContain('Who it belongs to');
    expect(wrapper.find('#handover-to').exists()).toBe(false);
    // Listing every account is admin-only information; the page must not ask.
    expect(state.peopleAsked).toBe(0);
  });
});
