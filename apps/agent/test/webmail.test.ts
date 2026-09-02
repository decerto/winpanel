import { describe, expect, it } from 'vitest';
import { sanitiseHtml } from '../src/api/routers/webmail.js';
import {
  MAX_ATTACHMENT_BYTES,
  WebmailClient,
} from '../src/mail/webmail-client.js';
import { WebmailSessions } from '../src/mail/webmail-sessions.js';

function webmailClient(
  handler: (request: { url: string; init: RequestInit | undefined }) => Response | Promise<Response>,
  address = 'person@example.com',
  loginAddress?: string,
) {
  return new WebmailClient(
    address,
    'secret',
    (async (url: string, init?: RequestInit) => handler({ url, init })) as typeof fetch,
    'http://mail.test',
    loginAddress,
  );
}

/**
 * Webmail shows attacker-supplied HTML inside the panel that administers the
 * whole server, so the two things that stand between a message and that panel
 * — the sanitiser and the credential store — are tested directly.
 */

describe('sanitiseHtml', () => {
  it('removes scripts and their contents', () => {
    expect(sanitiseHtml('<p>hi</p><script>fetch("/evil")</script>')).toBe('<p>hi</p>');
  });

  it('removes event handlers however they are quoted', () => {
    expect(sanitiseHtml('<img src="a.png" onerror=alert(1)>')).toBe('<img>');
    expect(sanitiseHtml('<div ONCLICK="x()">a</div>')).toBe('<div>a</div>');
  });

  it('removes remote resources but keeps inline image data', () => {
    const html =
      '<img src="https://tracking.example/pixel.gif">' +
      '<img src="data:image/png;base64,AAAA">' +
      '<div style="background-image: url(https://tracking.example/pixel.gif); color: red">x</div>';

    expect(sanitiseHtml(html)).toBe(
      '<img><img src="data:image/png;base64,AAAA"><div>x</div>',
    );
  });

  it('defuses javascript links', () => {
    expect(sanitiseHtml('<a href="javascript:alert(1)">go</a>')).toBe('<a href="#">go</a>');
    expect(sanitiseHtml('<a href="data:text/html,<script>alert(1)</script>">go</a>')).toBe(
      '<a href="#">go</a>',
    );
  });

  it('removes frames, which could load the panel itself', () => {
    expect(sanitiseHtml('<iframe src="/settings"></iframe><p>x</p>')).toBe('<p>x</p>');
  });

  it('leaves ordinary formatting alone', () => {
    const html = '<p><strong>Invoice</strong> attached. <a href="https://x.test">View</a></p>';
    expect(sanitiseHtml(html)).toBe(html);
  });
});

describe('WebmailSessions', () => {
  it('hands back the credentials for a token it issued', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open('user-a', { address: 'a@example.com', password: 'secret' });

    expect(sessions.get(token, 'user-a')).toEqual({ address: 'a@example.com', password: 'secret' });
  });

  it('does not let another panel user use or close the token', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open('user-a', { address: 'a@example.com', password: 'secret' });

    expect(sessions.get(token, 'user-b')).toBeNull();
    sessions.close(token, 'user-b');
    expect(sessions.get(token, 'user-a')).not.toBeNull();

    sessions.closeForUser('user-a');
    expect(sessions.get(token, 'user-a')).toBeNull();
  });

  it('does not recognise a token it never issued', () => {
    expect(new WebmailSessions().get('made-up', 'user-a')).toBeNull();
  });

  it('forgets a sitting that has been idle too long', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open('user-a', { address: 'a@example.com', password: 'secret' });

    now += 61 * 60 * 1000;
    expect(sessions.get(token, 'user-a')).toBeNull();
  });

  it('keeps a sitting alive while it is being used', () => {
    let now = 0;
    const sessions = new WebmailSessions(() => now);
    const { token } = sessions.open('user-a', { address: 'a@example.com', password: 'secret' });

    for (let step = 0; step < 5; step++) {
      now += 50 * 60 * 1000;
      expect(sessions.get(token, 'user-a')).not.toBeNull();
    }
  });

  it('ends a sitting when it is closed', () => {
    const sessions = new WebmailSessions();
    const { token } = sessions.open('user-a', { address: 'a@example.com', password: 'secret' });

    sessions.close(token, 'user-a');
    expect(sessions.get(token, 'user-a')).toBeNull();
  });
});

describe('WebmailClient attachments', () => {
  it('rejects a response that exceeds the limit even when its metadata understates it', async () => {
    const client = webmailClient(({ url }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
            apiUrl: 'http://mail.test/jmap',
          }),
        );
      }

      return new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
    });

    await expect(client.attachment('blob-1', 0)).rejects.toThrow(/too large/i);
  });

  it('rejects an oversized response from its content length before reading it', async () => {
    const client = webmailClient(({ url }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
            apiUrl: 'http://mail.test/jmap',
          }),
        );
      }

      return new Response(null, {
        headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) },
      });
    });

    await expect(client.attachment('blob-1', 1)).rejects.toThrow(/too large/i);
  });

  it('reports a failed attachment download instead of returning partial data', async () => {
    const client = webmailClient(({ url }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            downloadUrl: 'http://mail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
            apiUrl: 'http://mail.test/jmap',
          }),
        );
      }

      return new Response(null, { status: 503 });
    });

    await expect(client.attachment('blob-1', 1)).rejects.toThrow(
      'The mail server answered with an error (503).',
    );
  });
});

describe('WebmailClient sender blocks', () => {
  it('creates and activates a Sieve script through an uploaded blob', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/upload/{accountId}/',
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            capabilities: { 'urn:ietf:params:jmap:sieve': {} },
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }
      if (url.includes('/upload/')) return new Response(JSON.stringify({ blobId: 'blob-1' }));

      const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      return new Response(
        JSON.stringify({
          methodResponses: body.methodCalls.map(([name, , id]) =>
            name === 'SieveScript/get'
              ? [name, { list: [] }, id]
              : [name, { created: { senderBlocks: { id: 'script-1' } } }, id],
          ),
        }),
      );
    });

    await client.setSenderBlocked('Spam@example.com', true);

    const upload = calls.find((call) => call.url.includes('/upload/'));
    expect(upload?.init?.method).toBe('POST');
    expect(String(upload?.init?.body)).toContain('address :is ["From"] "spam@example.com"');
    const uploadedScript = String(upload?.init?.body);
    expect(uploadedScript).toContain('fileinto "Junk";');
    expect(uploadedScript).not.toContain(',if address');

    const jmapBodies = calls
      .filter((call) => call.url === 'http://mail.test/jmap')
      .map((call) => JSON.parse(String(call.init?.body)) as {
        using: string[];
        methodCalls: [string, Record<string, unknown>, string][];
      });
    const getBody = jmapBodies[0];
    const setBody = jmapBodies[1];
    expect(getBody?.using).toContain('urn:ietf:params:jmap:sieve');
    expect(getBody?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    });
    expect(setBody?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      create: { senderBlocks: { name: 'winpanel-blocked-senders', blobId: 'blob-1' } },
      onSuccessActivateScript: '#senderBlocks',
    });
  });

  it('updates an active script without removing its existing rules', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/upload/{accountId}/',
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}',
            capabilities: { 'urn:ietf:params:jmap:sieve': {} },
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }
      if (url.includes('/download/')) {
        return new Response('require ["fileinto"];\nfileinto "Receipts";\n');
      }
      if (url.includes('/upload/')) return new Response(JSON.stringify({ blobId: 'blob-2' }));

      const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      return new Response(
        JSON.stringify({
          methodResponses: body.methodCalls.map(([name, , id]) =>
            name === 'SieveScript/get'
              ? [
                  name,
                  {
                    list: [{ id: 'script-1', name: 'personal', blobId: 'blob-old', isActive: true }],
                  },
                  id,
                ]
              : [name, {}, id],
          ),
        }),
      );
    });

    await client.setSenderBlocked('blocked@example.com', true);

    const upload = calls.find((call) => call.url.includes('/upload/'));
    expect(String(upload?.init?.body)).toContain('fileinto "Receipts";');
    expect(String(upload?.init?.body)).toContain('blocked@example.com');

    const jmapBodies = calls
      .filter((call) => call.url === 'http://mail.test/jmap')
      .map((call) => JSON.parse(String(call.init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      });
    expect(jmapBodies[1]?.methodCalls[0]?.[1]).toEqual({
      accountId: 'u1',
      update: { 'script-1': { blobId: 'blob-2' } },
    });
  });
});

describe('WebmailClient send', () => {
  it('submits a plain-text and HTML alternative from the authenticated mailbox', async () => {
    const client = webmailClient(({ url, init }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [first, second, third] = body.methodCalls;

      if (first?.[0] === 'Mailbox/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, 'c0'],
            ],
          }),
        );
      }

      if (first?.[0] === 'Identity/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Identity/get', { list: [{ id: 'identity-1', email: 'person@example.com' }] }, 'c0'],
            ],
          }),
        );
      }

      expect(first?.[0]).toBe('Email/set');
      expect(second?.[0]).toBe('EmailSubmission/set');
      expect(third).toBeUndefined();
      return new Response(JSON.stringify({ methodResponses: [
        ['Email/set', {}, 'draft'],
        ['EmailSubmission/set', {}, 'send'],
      ] }));
    });

    await client.send({
      to: [{ name: null, email: 'recipient@example.com' }],
      subject: 'A panel message',
      text: 'Plain version',
      html: '<p>HTML version</p>',
    });
  });

  it('authenticates as the primary mailbox while sending from its alias', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = webmailClient(
      ({ url, init }) => {
        calls.push({ url, init });
        if (url.endsWith('/.well-known/jmap')) {
          return new Response(
            JSON.stringify({
              apiUrl: 'http://mail.test/jmap',
              primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
            }),
          );
        }

        const body = JSON.parse(String(init?.body)) as {
          methodCalls: [string, Record<string, unknown>, string][];
        };
        const [first, second] = body.methodCalls;
        if (first?.[0] === 'Identity/get') {
          return new Response(
            JSON.stringify({
              methodResponses: [
                ['Identity/get', { list: [{ id: 'identity-1', email: 'alerts@example.com' }] }, 'c0'],
              ],
            }),
          );
        }
        if (first?.[0] === 'Mailbox/get') {
          return new Response(
            JSON.stringify({
              methodResponses: [
                ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, 'c0'],
              ],
            }),
          );
        }

        expect(first?.[0]).toBe('Email/set');
        expect(second?.[0]).toBe('EmailSubmission/set');
        if (!first || !second) throw new Error('The send request did not contain both JMAP calls.');
        expect((first[1].create as { draft: { from: unknown } }).draft.from).toEqual([
          { email: 'alerts@example.com' },
        ]);
        expect(
          (second[1].create as { submission: { envelope: Record<string, unknown> } }).submission
            .envelope,
        ).toMatchObject({
          mailFrom: { email: 'alerts@example.com' },
        });
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Email/set', {}, 'draft'],
              ['EmailSubmission/set', {}, 'send'],
            ],
          }),
        );
      },
      'alerts@example.com',
      'person@example.com',
    );

    await client.send({
      to: [{ name: null, email: 'recipient@example.com' }],
      subject: 'Alias message',
      text: 'Plain version',
    });

    const sessionRequest = calls.find((call) => call.url.endsWith('/.well-known/jmap'));
    expect(sessionRequest?.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('person@example.com:secret').toString('base64')}`,
    });
  });
});

describe('WebmailClient conversations', () => {
  it('loads every message in a thread and orders them oldest first', async () => {
    let detailRequest = 0;
    const client = webmailClient(({ url, init }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [name, args, callId] = body.methodCalls[0]!;

      if (name === 'Email/get') {
        detailRequest += 1;
        const email = (id: string, receivedAt: string, subject: string, text: string) => ({
          id,
          threadId: 'thread-1',
          from: [{ name: 'Sender', email: 'sender@example.com' }],
          to: [{ name: null, email: 'person@example.com' }],
          subject,
          receivedAt,
          preview: text,
          size: text.length,
          keywords: { $seen: true },
          bodyValues: { body: { value: text } },
          textBody: [{ partId: 'body', type: 'text/plain' }],
          messageId: [`<${id}@example.com>`],
        });

        const list =
          detailRequest === 1
            ? [email('message-2', '2026-02-09T10:00:00.000Z', 'Re: Topic', 'Second message')]
            : [
                email('message-2', '2026-02-09T10:00:00.000Z', 'Re: Topic', 'Second message'),
                email('message-1', '2026-02-09T09:00:00.000Z', 'Topic', 'First message'),
              ];

        return new Response(JSON.stringify({ methodResponses: [['Email/get', { list }, callId]] }));
      }

      expect(name).toBe('Thread/get');
      expect(args).toEqual({ accountId: 'u1', ids: ['thread-1'] });
      return new Response(
        JSON.stringify({
          methodResponses: [
            ['Thread/get', { list: [{ id: 'thread-1', emailIds: ['message-1', 'message-2'] }] }, callId],
          ],
        }),
      );
    });

    const thread = await client.thread('message-2');

    expect(thread.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(thread.map((message) => message.text)).toEqual(['First message', 'Second message']);
    expect(thread[1]?.messageId).toEqual(['<message-2@example.com>']);
  });

  it('copies source attachments and reply headers into a forwarded message', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let emailGetRequest = 0;
    let draft: Record<string, unknown> | undefined;
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/jmap/upload/{accountId}/',
            downloadUrl: 'http://mail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      if (url.includes('/download/')) return new Response('attachment bytes');
      if (url.includes('/upload/')) return new Response(JSON.stringify({ blobId: 'uploaded-blob' }));

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [name, args, callId] = body.methodCalls[0]!;

      if (name === 'Identity/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'person@example.com' }] }, callId]],
          }),
        );
      }

      if (name === 'Mailbox/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              [
                'Mailbox/get',
                { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] },
                callId,
              ],
            ],
          }),
        );
      }

      if (name === 'Email/get') {
        emailGetRequest += 1;
        const source = {
          id: 'source-message',
          threadId: 'thread-1',
          from: [{ name: 'Sender', email: 'sender@example.com' }],
          to: [{ name: null, email: 'person@example.com' }],
          subject: 'Original subject',
          receivedAt: '2026-02-09T09:00:00.000Z',
          preview: 'Original body',
          size: 100,
          keywords: { $seen: true },
          bodyValues: { body: { value: 'Original body' } },
          textBody: [{ partId: 'body', type: 'text/plain' }],
          attachments: [
            {
              blobId: 'source-blob',
              name: 'invoice.pdf',
              type: 'application/pdf',
              size: 17,
              disposition: 'attachment',
            },
          ],
          messageId: ['<source@example.com>'],
          inReplyTo: ['<parent@example.com>'],
          references: ['<grandparent@example.com>', '<parent@example.com>'],
        };
        expect(emailGetRequest).toBe(1);
        return new Response(JSON.stringify({ methodResponses: [['Email/get', { list: [source] }, callId]] }));
      }

      expect(name).toBe('Email/set');
      draft = (args.create as { draft: Record<string, unknown> }).draft;
      return new Response(
        JSON.stringify({
          methodResponses: [
            ['Email/set', {}, callId],
            ['EmailSubmission/set', {}, 'send'],
          ],
        }),
      );
    });

    await client.send({
      to: [{ name: null, email: 'friend@example.com' }],
      subject: 'Fwd: Original subject',
      text: 'Forwarded body',
      inReplyTo: '<source@example.com>',
      references: ['<parent@example.com>', '<source@example.com>'],
      forwardOf: 'source-message',
    });

    expect(draft).toMatchObject({
      inReplyTo: ['<source@example.com>'],
      references: ['<parent@example.com>', '<source@example.com>'],
      attachments: [
        {
          blobId: 'uploaded-blob',
          name: 'invoice.pdf',
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    });

    const download = calls.find((call) => call.url.includes('/download/'));
    const upload = calls.find((call) => call.url.includes('/upload/'));
    expect(download?.url).toBe(
      'http://mail.test/jmap/download/u1/source-blob/attachment?accept=application%2Foctet-stream',
    );
    expect(upload?.url).toBe('http://mail.test/jmap/upload/u1/');
    expect(upload?.init?.method).toBe('POST');
    expect((upload?.init?.headers as Record<string, string>)['content-type']).toBe('application/pdf');
  });

  it('reports a failed attachment upload before creating the forwarded message', async () => {
    const client = webmailClient(({ url, init }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/jmap/upload/{accountId}/',
            downloadUrl: 'http://mail.test/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      if (url.includes('/download/')) return new Response('attachment bytes');
      if (url.includes('/upload/')) return new Response(null, { status: 502 });

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [name, , callId] = body.methodCalls[0]!;

      if (name === 'Identity/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'person@example.com' }] }, callId]],
          }),
        );
      }

      if (name === 'Mailbox/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }] }, callId]],
          }),
        );
      }

      if (name === 'Email/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              [
                'Email/get',
                {
                  list: [
                    {
                      id: 'source-message',
                      attachments: [
                        {
                          blobId: 'source-blob',
                          name: 'invoice.pdf',
                          type: 'application/pdf',
                          size: 17,
                        },
                      ],
                    },
                  ],
                },
                callId,
              ],
            ],
          }),
        );
      }

      throw new Error(`Unexpected JMAP call: ${name}`);
    });

    await expect(
      client.send({
        to: [{ name: null, email: 'friend@example.com' }],
        subject: 'Fwd: Original subject',
        text: 'Forwarded body',
        forwardOf: 'source-message',
      }),
    ).rejects.toThrow('The mail server answered with an error (502).');
  });

  it('forwards a message without calling blob endpoints when it has no attachments', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const jmapCalls: string[] = [];
    const client = webmailClient(({ url, init }) => {
      calls.push({ url, init });

      if (url.endsWith('/.well-known/jmap')) {
        return new Response(
          JSON.stringify({
            apiUrl: 'http://mail.test/jmap',
            uploadUrl: 'http://mail.test/upload/{accountId}/{type}',
            downloadUrl: 'http://mail.test/download/{accountId}/{blobId}/{type}/{name}',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u1' },
          }),
        );
      }

      if (url.includes('/download/') || url.includes('/upload/')) {
        throw new Error('A no-attachment forward must not call a blob endpoint.');
      }

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const [name, , callId] = body.methodCalls[0]!;
      jmapCalls.push(name);

      if (name === 'Identity/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'person@example.com' }] }, callId]],
          }),
        );
      }

      if (name === 'Mailbox/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              ['Mailbox/get', { list: [{ id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] }, callId],
            ],
          }),
        );
      }

      if (name === 'Email/get') {
        return new Response(
          JSON.stringify({
            methodResponses: [
              [
                'Email/get',
                {
                  list: [
                    {
                      id: 'source-message',
                      threadId: 'thread-1',
                      subject: 'Original subject',
                      receivedAt: '2026-02-09T09:00:00.000Z',
                      attachments: [],
                    },
                  ],
                },
                callId,
              ],
            ],
          }),
        );
      }

      expect(name).toBe('Email/set');
      expect(body.methodCalls[1]?.[0]).toBe('EmailSubmission/set');
      return new Response(
        JSON.stringify({
          methodResponses: [
            ['Email/set', {}, callId],
            ['EmailSubmission/set', {}, 'send'],
          ],
        }),
      );
    });

    await client.send({
      to: [{ name: null, email: 'friend@example.com' }],
      subject: 'Fwd: Original subject',
      text: 'Forwarded body',
      forwardOf: 'source-message',
    });

    expect(jmapCalls).toEqual(['Identity/get', 'Mailbox/get', 'Email/get', 'Email/set']);
    expect(calls.some((call) => call.url.includes('/download/') || call.url.includes('/upload/'))).toBe(
      false,
    );
  });
});
