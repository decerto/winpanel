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
    messageId: ['<message-1@example.com>'],
    inReplyTo: [] as string[],
    references: [] as string[],
    text: 'Please buy this thing.' as string | null,
    html: null as string | null,
    truncated: false,
    attachments: [],
    thread: [] as unknown[],
  })),
  setSeen: vi.fn(async () => ({ ok: true })),
  send: vi.fn(async () => ({ ok: true, note: 'Sent.' })),
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
      send: { mutate: state.send },
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
  state.send.mockClear();
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

describe('WebmailPage conversations', () => {
  it('shows the full thread and keeps reply headers when sending', async () => {
    state.message.mockResolvedValueOnce({
      id: 'message-1',
      threadId: 'thread-1',
      from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
      to: [{ name: null, email: 'person@example.com' }],
      subject: 'Re: A suspicious offer',
      receivedAt: new Date().toISOString(),
      preview: 'A reply.',
      size: 120,
      seen: true,
      flagged: false,
      hasAttachment: false,
      cc: [],
      replyTo: [],
      messageId: ['<message-1@example.com>'],
      inReplyTo: ['<message-0@example.com>'],
      references: ['<message-0@example.com>'],
      text: 'A reply.',
      html: null,
      truncated: false,
      attachments: [],
      thread: [
        {
          id: 'message-0',
          threadId: 'thread-1',
          from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
          to: [{ name: null, email: 'person@example.com' }],
          subject: 'A suspicious offer',
          receivedAt: new Date(Date.now() - 60_000).toISOString(),
          preview: 'The first message.',
          size: 100,
          seen: true,
          flagged: false,
          hasAttachment: false,
          cc: [],
          replyTo: [],
          messageId: ['<message-0@example.com>'],
          inReplyTo: [],
          references: [],
          text: null,
          html: '<p>The first message.</p>',
          truncated: false,
          attachments: [],
        },
        {
          id: 'message-1',
          threadId: 'thread-1',
          from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
          to: [{ name: null, email: 'person@example.com' }],
          subject: 'Re: A suspicious offer',
          receivedAt: new Date().toISOString(),
          preview: 'A reply.',
          size: 120,
          seen: true,
          flagged: false,
          hasAttachment: false,
          cc: [],
          replyTo: [],
          messageId: ['<message-1@example.com>'],
          inReplyTo: ['<message-0@example.com>'],
          references: ['<message-0@example.com>'],
          text: 'A reply.',
          html: null,
          truncated: false,
          attachments: [],
        },
      ],
    });

    const wrapper = await openPage();
    const row = wrapper.findAll('li').find((item) => item.text().includes('A suspicious offer'));
    await row!.find('div').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-thread-message]')).toHaveLength(2);
    expect(wrapper.findAll('iframe')).toHaveLength(1);
    expect(wrapper.findAll('pre')).toHaveLength(1);

    const latestMessage = wrapper.findAll('[data-thread-message]').at(-1);
    const replyButton = latestMessage!
      .findAll('button')
      .find((button) => button.text().trim() === 'Reply to this message');
    await replyButton!.trigger('click');
    expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
      'Re: A suspicious offer',
    );

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(state.send).toHaveBeenCalledWith({
      token: 'mailbox-token',
      to: [{ name: null, email: 'Spam@Example.com' }],
      cc: [],
      subject: 'Re: A suspicious offer',
      text: expect.stringContaining('A reply.'),
      inReplyTo: '<message-1@example.com>',
      references: ['<message-0@example.com>', '<message-1@example.com>'],
      forwardOf: null,
    });
  });

  it('opens a forward compose with the original message attached to the send request', async () => {
    const wrapper = await openPage();
    const row = wrapper.findAll('li').find((item) => item.text().includes('A suspicious offer'));
    await row!.find('div').trigger('click');
    await flushPromises();

    const forwardButton = wrapper
      .findAll('[data-thread-message]')
      .at(-1)!
      .findAll('button')
      .find((button) => button.text().trim() === 'Forward this message');
    await forwardButton!.trigger('click');

    expect((wrapper.get('#draft-subject').element as HTMLInputElement).value).toBe(
      'Fwd: A suspicious offer',
    );
    expect((wrapper.get('#draft-text').element as HTMLTextAreaElement).value).toContain(
      'Forwarded message',
    );

    await wrapper.get('#draft-to').setValue('friend@example.com');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ name: null, email: 'friend@example.com' }],
        forwardOf: 'message-1',
        inReplyTo: null,
        references: [],
      }),
    );
  });

  it('quotes an HTML-only message and locks its frame down', async () => {
    state.message.mockResolvedValueOnce({
      id: 'message-1',
      threadId: 'thread-1',
      from: [{ name: 'Spammer', email: 'Spam@Example.com' }],
      to: [{ name: null, email: 'person@example.com' }],
      subject: 'An HTML-only message',
      receivedAt: new Date().toISOString(),
      preview: 'HTML preview',
      size: 100,
      seen: true,
      flagged: false,
      hasAttachment: false,
      cc: [],
      replyTo: [],
      messageId: ['<message-1@example.com>'],
      inReplyTo: [],
      references: [],
      text: null,
      html: '<p>Hello <strong>there</strong>.</p><p>Second line.</p>',
      truncated: false,
      attachments: [],
      thread: [] as unknown[],
    });

    const wrapper = await openPage();
    const row = wrapper.findAll('li').find((item) => item.text().includes('A suspicious offer'));
    await row!.find('div').trigger('click');
    await flushPromises();

    const frame = wrapper.get('iframe');
    const source = frame.attributes('srcdoc');
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("img-src data:");

    const replyButton = wrapper
      .findAll('button')
      .find((button) => button.text().trim() === 'Reply to this message');
    await replyButton!.trigger('click');

    expect((wrapper.get('#draft-text').element as HTMLTextAreaElement).value).toContain(
      '> Hello there.\n> Second line.',
    );
  });
});
