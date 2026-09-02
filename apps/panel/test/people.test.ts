import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { flushPromises } from '@vue/test-utils';

/**
 * The People page, which is the one screen where a mistake hands somebody
 * more of the server than they were meant to have.
 *
 * The server refuses anything it should not do, so these tests are about the
 * other half of the problem: an administrator should not be shown a button
 * that will only ever be refused, because a button that fails silently looks
 * like a broken panel rather than a boundary.
 */

const state = vi.hoisted(() => ({
  me: { id: 'me', role: 'superadmin' as string },
  people: [] as any[],
  list: vi.fn(async () => state.people),
  created: [] as any[],
  updated: [] as any[],
  games: [] as any[],
}));

vi.mock('../src/lib/api', () => ({
  api: {
    users: {
      list: { query: state.list },
      create: {
        mutate: vi.fn(async (input: unknown) => {
          state.created.push(input);
          return {};
        }),
      },
      update: {
        mutate: vi.fn(async (input: unknown) => {
          state.updated.push(input);
          return {};
        }),
      },
      setPassword: { mutate: vi.fn(async () => ({ ok: true })) },
      remove: { mutate: vi.fn(async () => ({ ok: true })) },
    },
    auth: { me: { query: vi.fn(async () => state.me) } },
    databases: { engines: { query: vi.fn(async () => ({ engines: [{ id: 'mariadb' }] })) } },
    gameServers: { catalogue: { query: vi.fn(async () => state.games) } },
  },
  describeError: (error: unknown) => String(error),
}));

const PeoplePage = (await import('../src/pages/PeoplePage.vue')).default;

const person = (over: Record<string, unknown>) => ({
  id: 'x',
  username: 'x',
  role: 'user',
  email: null,
  emailVerified: false,
  disabled: false,
  totpEnrolled: false,
  siteLimit: null,
  subdomainLimit: null,
  mailboxLimit: null,
  mailQuotaBytes: null,
  siteDiskQuotaBytes: null,
  gameServerLimit: null,
  databaseLimit: null,
  databaseQuotaBytes: null,
  gameServerProviders: [],
  lastLoginAt: null,
  createdAt: new Date(0),
  siteCount: 0,
  subdomainCount: 0,
  gameServerCount: 0,
  databaseCount: 0,
  databaseAllocatedBytes: 0,
  databaseUsedBytes: 0,
  mailboxCount: null,
  mailUsedBytes: null,
  ...over,
});

async function render() {
  const wrapper = mount(PeoplePage);
  await flushPromises();
  return wrapper;
}

/** The four per-row buttons, in the order they appear. */
function rowButtons(wrapper: any, index: number) {
  return wrapper.findAll('[data-person-row]')[index]!.findAll('button');
}

beforeEach(() => {
  state.me = { id: 'me', role: 'superadmin' };
  state.people = [
    person({ id: 'me', username: 'owner', role: 'superadmin' }),
    person({ id: 'a', username: 'admin', role: 'admin' }),
    person({ id: 'f', username: 'freya', role: 'user', siteLimit: 2, siteCount: 1 }),
  ];
  state.created = [];
  state.list.mockClear();
  state.updated = [];
  state.games = [];
});

describe('who the People page lets you manage', () => {
  it('does not turn a failed list request into an empty account state', async () => {
    state.list.mockRejectedValueOnce(new Error('The server is unavailable.'));
    const wrapper = await render();

    expect(wrapper.text()).toContain('Could not load people');
    expect(wrapper.text()).toContain('Use Refresh to try again.');
    expect(wrapper.text()).not.toContain('Nobody else yet');
  });

  it('never lets anybody manage their own account from here', async () => {
    /*
     * Changing your own role or switching yourself off is the one way to lock
     * a server out of its only owner, so the row for whoever is looking is
     * inert.
     */
    const wrapper = await render();

    for (const button of rowButtons(wrapper, 0)) {
      expect(button.attributes('disabled')).toBeDefined();
    }
  });

  it('lets the owner manage everybody else', async () => {
    const wrapper = await render();

    for (const index of [1, 2]) {
      for (const button of rowButtons(wrapper, index)) {
        expect(button.attributes('disabled')).toBeUndefined();
      }
    }
  });

  it('stops an administrator touching another administrator or the owner', async () => {
    state.me = { id: 'a', role: 'admin' };
    const wrapper = await render();

    // Rows 0 and 1 are the owner and the admin themselves; only the customer
    // is theirs to manage.
    for (const button of rowButtons(wrapper, 0)) {
      expect(button.attributes('disabled')).toBeDefined();
    }
    for (const button of rowButtons(wrapper, 1)) {
      expect(button.attributes('disabled')).toBeDefined();
    }
    for (const button of rowButtons(wrapper, 2)) {
      expect(button.attributes('disabled')).toBeUndefined();
    }
  });

  it('only offers an administrator the customer role', async () => {
    // Otherwise the page invites them to make another owner and then refuses.
    state.me = { id: 'a', role: 'admin' };
    const wrapper = await render();

    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    const options = wrapper.findAll('select option').map((option: any) => option.text());
    expect(options).toEqual(['Customer']);
  });

  it('offers the owner every role', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    const options = wrapper.findAll('select option').map((option: any) => option.text());
    expect(options).toEqual(['Owner', 'Administrator', 'Customer']);
  });
});

describe('the limits on the People page', () => {
  it('shows what a customer has used against what they are allowed', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toContain('1 of 2');
  });

  it('shows and sends the separate subdomain allowance', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      subdomainLimit: 3,
      subdomainCount: 2,
    });
    const wrapper = await render();
    expect(wrapper.text()).toContain('2 of 3');

    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');
    await wrapper.find('#person-username').setValue('subdomain-user');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('#person-subdomains').setValue('8');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({
      role: 'user',
      subdomainLimit: 8,
    });
  });

  it('loads the saved subdomain allowance when editing a customer', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      subdomainLimit: 7,
      subdomainCount: 4,
    });
    const wrapper = await render();

    await rowButtons(wrapper, 2)[0]!.trigger('click');

    expect(wrapper.find('#person-subdomains').element).toHaveProperty('value', '7');
  });

  it('saves the mailbox allowance when editing a customer', async () => {
    const wrapper = await render();

    await rowButtons(wrapper, 2)[0]!.trigger('click');
  await wrapper.findAll('input[name="mailbox-limit-mode"]')[0]!.trigger('change');
    await wrapper.find('#person-mailboxes').setValue('20');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.updated[0]).toMatchObject({
      userId: 'f',
      mailboxLimit: 20,
    });
  });

  it('describes a staff account as reaching everything', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toContain('All websites');
  });

  it('sends no limits at all when the account is not a customer', async () => {
    /*
     * A capped administrator would be an administrator in name only, and the
     * number would sit in the database waiting to surprise somebody. The
     * server drops them too; the page must not disagree with it.
     */
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('sam');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('select').setValue('admin');

    // The gigabyte fields are gone, not merely ignored.
    expect(wrapper.find('#person-sites').exists()).toBe(false);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      username: 'sam',
      role: 'admin',
      siteLimit: null,
      subdomainLimit: null,
      mailQuotaBytes: null,
      siteDiskQuotaBytes: null,
    });
  });

  it('sends an optional notification email when creating a customer', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('freya2');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('#person-email').setValue('freya2@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({
      username: 'freya2',
      role: 'user',
      email: 'freya2@example.com',
    });
  });

  it('loads and updates an existing staff notification email', async () => {
    state.people[1] = person({
      id: 'a',
      username: 'admin',
      role: 'admin',
      email: 'old@example.com',
      emailVerified: true,
    });
    const wrapper = await render();

    expect(wrapper.text()).toContain('old@example.com');
    expect(wrapper.text()).toContain('Verified');
    await rowButtons(wrapper, 1)[0]!.trigger('click');
    expect(wrapper.find('#person-email').element).toHaveProperty('value', 'old@example.com');

    await wrapper.find('#person-email').setValue('new@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.updated[0]).toMatchObject({
      userId: 'a',
      role: 'admin',
      email: 'new@example.com',
    });
  });

  it('preserves a customer notification email when editing limits', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      role: 'user',
      email: 'freya@example.com',
      emailVerified: true,
      siteLimit: 2,
    });
    const wrapper = await render();

    await rowButtons(wrapper, 2)[0]!.trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.updated[0]).toMatchObject({
      userId: 'f',
      role: 'user',
      email: 'freya@example.com',
    });
  });

  it('requires an explicit no-limit choice instead of treating a blank as unlimited', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('freya2');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.findAll('input[name="site-limit-mode"]')[1]!.trigger('change');
    await wrapper.find('#person-mail').setValue('5');

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({
      role: 'user',
      siteLimit: null,
      mailQuotaBytes: 5 * 1024 ** 3,
    });
  });

  it('sends zero game servers as no access', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('no-games');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('#person-game-servers').setValue('0');

    expect(wrapper.text()).toContain('No game servers can be created.');
    expect(wrapper.find('[data-game-access]').exists()).toBe(false);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({ role: 'user', gameServerLimit: 0 });
  });

  it('sends no limit as unlimited game servers', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('all-games');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.findAll('input[name="game-server-limit-mode"]')[1]!.trigger('change');

    expect(wrapper.find('#person-game-servers').exists()).toBe(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({ role: 'user', gameServerLimit: null });
  });

  it('shows and sends the mailbox allowance separately from email storage', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      mailboxLimit: 3,
      mailboxCount: 0,
    });
    const wrapper = await render();
    expect(wrapper.text()).toContain('0 of 3');

    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');
    await wrapper.find('#person-username').setValue('mail-user');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('#person-mailboxes').setValue('8');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0]).toMatchObject({ role: 'user', mailboxLimit: 8 });
  });

  it('shows live mailbox and email storage usage against the allowances', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      mailboxLimit: 20,
      mailboxCount: 18,
      mailQuotaBytes: 20 * 1024 ** 3,
      mailUsedBytes: 18 * 1024 ** 3,
    });
    const wrapper = await render();

    expect(wrapper.text()).toContain('18 of 20');
    expect(wrapper.text()).toContain('18.0 GB used of 20.0 GB');
  });

  it('labels mailbox and email usage unavailable instead of showing zero', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      mailboxLimit: 20,
      mailQuotaBytes: 20 * 1024 ** 3,
    });
    const wrapper = await render();

    expect(wrapper.text()).toContain('Usage unavailable of 20');
    expect(wrapper.text()).toContain('Usage unavailable of 20.0 GB');
  });

  it('does not submit malformed limits', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((b: any) => b.text().includes('Add someone'))!.trigger('click');

    await wrapper.find('#person-username').setValue('bad-limit');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('#person-sites').setValue('not-a-number');

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Websites: enter a whole number');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created).toHaveLength(0);
  });

  it('shows and saves the account database storage quota', async () => {
    state.people[2] = person({
      id: 'f',
      username: 'freya',
      databaseQuotaBytes: 10 * 1024 ** 3,
      databaseAllocatedBytes: 4 * 1024 ** 3,
      databaseUsedBytes: 11 * 1024 ** 2,
    });
    const wrapper = await render();
    expect(wrapper.text()).toContain('11.0 MB used of 10.0 GB');

    await wrapper.findAll('button').find((node: any) => node.text().includes('Add someone'))!.trigger('click');
    await wrapper.find('#person-username').setValue('storage-user');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('input[name="database-quota-mode"]').trigger('change');
    await wrapper.find('#person-database-storage').setValue('12.5');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0].databaseQuotaBytes).toBe(12.5 * 1024 ** 3);
  });

  it('sends zero database storage as no storage', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((node: any) => node.text().includes('Add someone'))!.trigger('click');
    await wrapper.find('#person-username').setValue('no-database-storage');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('input[name="database-quota-mode"]').trigger('change');
    await wrapper.find('#person-database-storage').setValue('0');

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0].databaseQuotaBytes).toBe(0);
  });

  it('sends No limit database storage as null', async () => {
    const wrapper = await render();
    await wrapper.findAll('button').find((node: any) => node.text().includes('Add someone'))!.trigger('click');
    await wrapper.find('#person-username').setValue('unlimited-database-storage');
    await wrapper.find('#person-password').setValue('a-password-long-enough');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(state.created[0].databaseQuotaBytes).toBeNull();
  });

  it('gives the selected-game picker the full dialog width', async () => {
    state.games = [
      { id: 'minecraft', name: 'Minecraft Java', genre: 'Sandbox', status: 'ready' },
    ];
    const wrapper = await render();
    await wrapper.findAll('button').find((node: any) => node.text().includes('Add someone'))!.trigger('click');

    expect(wrapper.find('[data-person-dialog]').classes()).toContain('max-w-3xl');
    await wrapper.find('[data-game-access-mode="selected"]').trigger('change');
    expect(wrapper.find('[data-game-picker]').classes()).toContain('sm:col-span-2');
  });
});
