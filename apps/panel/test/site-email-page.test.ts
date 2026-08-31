import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { siteContextKey } from '../src/lib/site-context';

const state = vi.hoisted(() => ({
  mailboxes: [] as any[],
  created: [] as any[],
  receivingChanges: [] as any[],
  createMailbox: vi.fn(async (input: any) => {
    state.created.push(input);
    return {
      address: input.address,
      password: 'generated-password',
      generated: true,
      mailHostname: 'mail.example.com',
    };
  }),
  setMailboxReceiving: vi.fn(async (input: any) => {
    state.receivingChanges.push(input);
    state.mailboxes = state.mailboxes.map((mailbox) =>
      mailbox.address === input.address
        ? { ...mailbox, receivesMail: input.receivesMail }
        : mailbox,
    );
    return { ok: true, note: 'Saved.' };
  }),
}));

vi.mock('vue-router', () => ({
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
}));

vi.mock('../src/lib/api', () => ({
  api: {
    mail: {
      available: { query: vi.fn(async () => ({ connected: true, message: 'Ready' })) },
      mailboxes: { query: vi.fn(async () => state.mailboxes) },
      createMailbox: { mutate: state.createMailbox },
      setMailboxReceiving: { mutate: state.setMailboxReceiving },
      dnsStatus: {
        query: vi.fn(async () => ({
          pointsHere: true,
          canFix: false,
          checks: {
            spf: { ok: true },
            dkim: { ok: true },
            dmarc: { ok: true },
            mx: { ok: true, summary: '' },
          },
          recommended: [],
        })),
      },
      certificate: { query: vi.fn(async () => ({ handlesMail: false })) },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const SiteEmailPage = (await import('../src/pages/site/SiteEmailPage.vue')).default;

function mailbox(over: Record<string, unknown> = {}) {
  return {
    address: 'sam@example.com',
    displayName: 'Sam',
    quotaBytes: 5 * 1024 ** 3,
    usedBytes: 0,
    receivesMail: true,
    aliases: [],
    ...over,
  };
}

async function render() {
  const wrapper = mount(SiteEmailPage, {
    global: {
      provide: {
        [siteContextKey as unknown as symbol]: {
          site: ref({ slug: 'demo', domains: ['example.com'] }),
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  state.mailboxes = [];
  state.created = [];
  state.receivingChanges = [];
  state.createMailbox.mockClear();
  state.setMailboxReceiving.mockClear();
});

describe('website mailbox receiving mode', () => {
  it('creates a no-reply mailbox with receiving disabled', async () => {
    const wrapper = await render();

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('New mailbox'))
      ?.trigger('click');
    await wrapper.get('#local-part').setValue('noreply');
    await wrapper.get('#mailbox-type').setValue('false');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(state.createMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'noreply@example.com',
        receivesMail: false,
      }),
    );
  });

  it('edits an existing mailbox from receiving to send-only', async () => {
    state.mailboxes = [mailbox()];
    const wrapper = await render();

    await wrapper
      .get('select[aria-label="Mailbox type for sam@example.com"]')
      .setValue('false');
    await flushPromises();

    expect(state.setMailboxReceiving).toHaveBeenCalledWith({
      address: 'sam@example.com',
      receivesMail: false,
    });
  });
});