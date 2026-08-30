import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const state = vi.hoisted(() => ({
  blockSender: vi.fn(async () => ({ ok: true, sender: 'spam@example.com' })),
  unblockSender: vi.fn(async () => ({ ok: true, sender: 'blocked@example.com' })),
  blockedSenders: vi.fn(async () => ['blocked@example.com']),
  folders: vi.fn(async () => [
    {
      id: 'inbox',
      name: 'Inbox',
      role: 'inbox',
      parentId: null,
      total: 1,
      unread: 1,
      sortOrder: 0,
    },
    {
      id: 'trash',
      name: 'Trash',
      role: 'trash',
      parentId: null,
      total: 0,
      unread: 0,
      sortOrder: 5,
    },
  ]),
  messages: vi.fn(async () => ({
    messages: [
      {
        id: 'message-1',
        threadId: 'thread-1',
        from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
        to: [{ name: null, email: 'person@example.com' }],
        subject: 'A suspicious offer',
        receivedAt: new Date().toISOString(),
        preview: 'Please buy this thing.',
        size: 100,
        seen: false,
        flagged: false,
        hasAttachment: false,
      },
    ],
    total: 1,
    position: 0,
  })),
  message: vi.fn(async () => ({
    id: 'message-1',
    threadId: 'thread-1',
    from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
    to: [{ name: null, email: 'person@example.com' }],
    subject: 'A suspicious offer',
    receivedAt: new Date().toISOString(),
    preview: 'Please buy this thing.',
    size: 100,
    seen: true,
    flagged: false,
    hasAttachment: false,
    cc: [],
    replyTo: [],
    text: 'Please buy this thing.',
    html: null,
    truncated: false,
    attachments: [],
  })),
  setSeen: vi.fn(async () => ({ ok: true })),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}));

vi.mock('../src/lib/api', () => ({
  api: {
    webmail: {
      signIn: { mutate: vi.fn() },
      signOut: { mutate: vi.fn() },
      folders: { query: state.folders },
      messages: { query: state.messages },
      message: { query: state.message },
      blockedSenders: { query: state.blockedSenders },
      blockSender: { mutate: state.blockSender },
      unblockSender: { mutate: state.unblockSender },
      setSeen: { mutate: state.setSeen },
      setFlagged: { mutate: vi.fn() },
      move: { mutate: vi.fn() },
      destroy: { mutate: vi.fn() },
      attachment: { query: vi.fn() },
      send: { mutate: vi.fn() },
    },
  },
  describeError: (error: unknown) => String(error),
}));

const WebmailPage = (await import('../src/pages/WebmailPage.vue')).default;

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('winpanel.webmail.token', 'mailbox-token');
  sessionStorage.setItem('winpanel.webmail.address', 'person@example.com');
  state.blockSender.mockClear();
  state.unblockSender.mockClear();
  state.blockedSenders.mockClear();
  state.folders.mockClear();
  state.messages.mockClear();
  state.message.mockClear();
  state.setSeen.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

async function openPage() {
  const wrapper = mount(WebmailPage);
  await flushPromises();
  return wrapper;
}

describe('WebmailPage sender blocks', () => {
  it('blocks the sender from the open message and updates the action', async () => {
    const wrapper = await openPage();
    const row = wrapper.findAll('li').find((item) => item.text().includes('A suspicious offer'));

    expect(row).toBeDefined();
    await row!.find('div').trigger('click');
    await flushPromises();

    await wrapper.get('button[title="Block this sender"]').trigger('click');
    await flushPromises();

    expect(state.blockSender).toHaveBeenCalledWith({
      token: 'mailbox-token',
      sender: 'spam@example.com',
    });
    expect(wrapper.text()).toContain('Messages from spam@example.com are now blocked.');
    expect(wrapper.get('button[title="Allow this sender"]')).toBeDefined();
  });

  it('unblocks a sender from the mailbox list', async () => {
    const wrapper = await openPage();

    await wrapper
      .get('button[aria-label="Allow messages from blocked@example.com"]')
      .trigger('click');
    await flushPromises();

    expect(state.unblockSender).toHaveBeenCalledWith({
      token: 'mailbox-token',
      sender: 'blocked@example.com',
    });
    expect(wrapper.text()).toContain('Messages from blocked@example.com are allowed again.');
  });
});
