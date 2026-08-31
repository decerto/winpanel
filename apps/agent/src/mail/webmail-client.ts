import { STALWART_HTTP_PORT } from '@winpanel/shared';

/**
 * Reading and sending mail as an ordinary mailbox owner.
 *
 * Separate from `stalwart-client.ts` on purpose. That one speaks as the server
 * administrator and manages who exists; this one speaks as one person and can
 * only ever see that person's mail. Sharing a client between the two would
 * mean one bug could show somebody else's inbox, so they do not share a class,
 * a credential, or a capability set.
 *
 * The reason this exists at all: the panel already knows the mailbox is here
 * and already has a hostname for it, but "check your email" otherwise means
 * installing a mail program and typing four server settings correctly. A
 * webmail that is one click from the mailbox you just created removes that
 * step, and — more usefully — proves the mailbox works before anyone has
 * committed to it.
 *
 * JMAP rather than IMAP because the mail server already speaks it over the
 * loopback HTTP port the panel is talking to anyway. IMAP would mean a second
 * protocol, a second connection pool, and MIME parsing here.
 */

const DEFAULT_BASE_URL = `http://127.0.0.1:${STALWART_HTTP_PORT}`;

const CAPABILITIES = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
  'urn:ietf:params:jmap:sieve',
];
const BASE_CAPABILITIES = CAPABILITIES.slice(0, 3);
const SIEVE_CAPABILITY = 'urn:ietf:params:jmap:sieve';

const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';

/** Bodies are shown in a browser; past this the browser is the problem. */
const MAX_BODY_BYTES = 512 * 1024;

/** Attachments come back through the API as base64, so this is a real limit. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Nothing here is worth waiting on for longer than this. */
const REQUEST_TIMEOUT_MS = 20_000;

const SENDER_BLOCK_SCRIPT_NAME = 'winpanel-blocked-senders';
const PANEL_SENDER_REQUIRE =
  '# winpanel sender block requirement\nrequire ["address", "fileinto"];\n';
const SENDER_BLOCK_START = '# winpanel sender blocks begin';
const SENDER_BLOCK_END = '# winpanel sender blocks end';
const SENDER_BLOCK_PATTERN = new RegExp(
  `^${SENDER_BLOCK_START}\\r?\\n([\\s\\S]*?)^${SENDER_BLOCK_END}\\r?\\n?`,
  'm',
);
const PANEL_SENDER_REQUIRE_PATTERN =
  /^# winpanel sender block requirement\r?\nrequire \["address", "(?:discard|fileinto)"\];\r?\n/m;

export class WebmailError extends Error {
  constructor(
    message: string,
    /** True when the mailbox password was refused, rather than the request. */
    readonly unauthorised = false,
  ) {
    super(message);
    this.name = 'WebmailError';
  }
}

export interface MailFolder {
  id: string;
  name: string;
  /** `inbox`, `sent`, `drafts`, `trash`, `junk`, `archive`, or null. */
  role: string | null;
  parentId: string | null;
  total: number;
  unread: number;
  sortOrder: number;
}

export interface MailAddress {
  name: string | null;
  email: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  from: MailAddress[];
  to: MailAddress[];
  subject: string;
  receivedAt: string;
  preview: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
}

export interface MessageAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
  /** True for images referenced from the body rather than listed separately. */
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  text: string | null;
  html: string | null;
  truncated: boolean;
  attachments: MessageAttachment[];
}

interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  accountId: string;
  sieve: boolean;
}

type MethodCall = [string, Record<string, unknown>, string];

interface EmailBodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string | null;
  size?: number;
  disposition?: string | null;
  cid?: string | null;
}

interface EmailPayload {
  id?: string;
  threadId?: string;
  from?: MailAddress[] | null;
  to?: MailAddress[] | null;
  cc?: MailAddress[] | null;
  replyTo?: MailAddress[] | null;
  subject?: string | null;
  receivedAt?: string;
  preview?: string;
  size?: number;
  keywords?: Record<string, boolean>;
  hasAttachment?: boolean;
  bodyValues?: Record<string, { value?: string; isTruncated?: boolean }>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
  messageId?: string[] | null;
  references?: string[] | null;
}

interface SieveScriptPayload {
  id?: string;
  name?: string;
  blobId?: string;
  isActive?: boolean;
}

const LIST_PROPERTIES = [
  'id',
  'threadId',
  'from',
  'to',
  'subject',
  'receivedAt',
  'preview',
  'size',
  'keywords',
  'hasAttachment',
];

function addressesOf(value: MailAddress[] | null | undefined): MailAddress[] {
  return (value ?? []).map((entry) => ({
    name: entry.name?.trim() || null,
    email: entry.email,
  }));
}

function summarise(email: EmailPayload): MessageSummary {
  return {
    id: email.id ?? '',
    threadId: email.threadId ?? '',
    from: addressesOf(email.from),
    to: addressesOf(email.to),
    subject: email.subject?.trim() || '(no subject)',
    receivedAt: email.receivedAt ?? new Date(0).toISOString(),
    preview: email.preview ?? '',
    size: email.size ?? 0,
    seen: email.keywords?.['$seen'] === true,
    flagged: email.keywords?.['$flagged'] === true,
    hasAttachment: email.hasAttachment === true,
  };
}

/** The first body part that actually carries text, with its value. */
function bodyOf(
  email: EmailPayload,
  parts: EmailBodyPart[] | undefined,
): { value: string; truncated: boolean } | null {
  for (const part of parts ?? []) {
    const found = part.partId ? email.bodyValues?.[part.partId] : undefined;
    if (found?.value) return { value: found.value, truncated: found.isTruncated === true };
  }
  return null;
}

function sieveString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function stripPanelSenderBlocks(script: string): string {
  return script.replace(SENDER_BLOCK_PATTERN, '').replace(PANEL_SENDER_REQUIRE_PATTERN, '');
}

function leadingRequirementsEnd(script: string): number {
  const requirement = /^[\t \r\n]*(?:(?:#[^\r\n]*(?:\r\n|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*require\b[\s\S]*?;\s*/;
  let offset = 0;

  while (offset < script.length) {
    const match = requirement.exec(script.slice(offset));
    if (!match) break;
    offset += match[0].length;
  }

  return offset;
}

function senderBlocksIn(script: string): string[] {
  const match = SENDER_BLOCK_PATTERN.exec(script);
  if (!match) return [];

  const addresses = [
    ...(match[1] ?? '').matchAll(
      /^if address :is \["From"\] "((?:\\.|[^"\\])*)" \{\s*$/gm,
    ),
  ]
    .map((entry) => (entry[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase())
    .filter((address) => address.length > 0);

  return [...new Set(addresses)];
}

function withSenderBlocks(script: string, senders: readonly string[]): string {
  const base = stripPanelSenderBlocks(script);

  if (senders.length === 0) return base.trim().length > 0 ? base : 'keep;\n';

  const withRequirement = `${PANEL_SENDER_REQUIRE}${base}`;
  const block = [SENDER_BLOCK_START];
  for (const sender of senders) {
    block.push(`if address :is ["From"] ${sieveString(sender)} {`, '    fileinto "Junk";', '}');
  }
  block.push(SENDER_BLOCK_END, '');
  const insertion = leadingRequirementsEnd(withRequirement);

  return `${withRequirement.slice(0, insertion)}${block.join('\n')}\n${withRequirement.slice(insertion)}`;
}

export class WebmailClient {
  private readonly authorisation: string;
  private cachedSession: JmapSession | null = null;

  constructor(
    private readonly address: string,
    password: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.authorisation = `Basic ${Buffer.from(`${address}:${password}`).toString('base64')}`;
  }

  /**
   * Puts a URL the mail server gave us back onto the loopback address.
   *
   * The session document advertises absolute URLs built from the mail
   * server's own configured hostname, which is a public name that may not
   * resolve from the server itself and would leave the machine to come back
   * in. Only the path is ours to keep.
   */
  private rebase(url: string): string {
    try {
      const parsed = new URL(url);
      return `${this.baseUrl}${parsed.pathname}${parsed.search}`;
    } catch {
      return `${this.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, authorization: this.authorisation },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new WebmailError(
        'Could not reach the mail server. It may have stopped or be restarting.',
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new WebmailError(
        'The mail server rejected that email address and password.',
        true,
      );
    }

    if (!response.ok) {
      throw new WebmailError(`The mail server answered with an error (${response.status}).`);
    }

    return response;
  }

  /** The session document, which also proves the password is right. */
  async session(): Promise<JmapSession> {
    if (this.cachedSession) return this.cachedSession;

    const response = await this.request(`${this.baseUrl}/.well-known/jmap`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });

    const body = (await response.json()) as {
      apiUrl?: string;
      uploadUrl?: string;
      downloadUrl?: string;
      capabilities?: Record<string, unknown>;
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, unknown>;
    };

    const accountId =
      body.primaryAccounts?.[MAIL_CAPABILITY] ?? Object.keys(body.accounts ?? {})[0];

    if (!body.apiUrl || !accountId) {
      throw new WebmailError('The mail server did not offer a mailbox for that address.');
    }

    this.cachedSession = {
      apiUrl: this.rebase(body.apiUrl),
      uploadUrl: body.uploadUrl ? this.rebase(body.uploadUrl) : '',
      downloadUrl: body.downloadUrl ?? '',
      accountId,
      sieve: body.capabilities?.[SIEVE_CAPABILITY] !== undefined,
    };

    return this.cachedSession;
  }

  /** Confirms the credentials work, and reports what they belong to. */
  async signIn(): Promise<{ address: string; accountId: string }> {
    const session = await this.session();
    return { address: this.address, accountId: session.accountId };
  }

  private async post(calls: MethodCall[]): Promise<MethodCall[]> {
    const session = await this.session();

    const response = await this.request(session.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        using: session.sieve ? CAPABILITIES : BASE_CAPABILITIES,
        methodCalls: calls,
      }),
    });

    const body = (await response.json()) as { methodResponses?: MethodCall[] };
    const responses = body.methodResponses ?? [];

    for (const entry of responses) {
      if (entry[0] === 'error') {
        throw new WebmailError(
          (entry[1]['description'] as string | undefined) ??
            'The mail server refused that request.',
        );
      }
    }

    return responses;
  }

  private async invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const [first] = await this.post([[name, args, 'c0']]);

    if (!first) throw new WebmailError('The mail server answered without saying anything.');
    return first[1] as T;
  }

  /**
   * `Foo/set` reports per-object failures in the body rather than as an error,
   * so a silent no-op is the default unless they are looked for.
   */
  private static throwSetErrors(result: Record<string, unknown>): void {
    for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
      const failures = result[key] as Record<string, { description?: string }> | undefined;
      const first = failures ? Object.values(failures)[0] : undefined;

      if (first) {
        throw new WebmailError(first.description ?? 'The mail server refused that change.');
      }
    }
  }

  async folders(): Promise<MailFolder[]> {
    const { accountId } = await this.session();
    const result = await this.invoke<{
      list?: Array<{
        id?: string;
        name?: string;
        role?: string | null;
        parentId?: string | null;
        totalEmails?: number;
        unreadEmails?: number;
        sortOrder?: number;
      }>;
    }>('Mailbox/get', { accountId, ids: null });

    return (result.list ?? [])
      .filter((folder) => folder.id)
      .map((folder) => ({
        id: folder.id!,
        name: folder.name ?? 'Folder',
        role: folder.role ?? null,
        parentId: folder.parentId ?? null,
        total: folder.totalEmails ?? 0,
        unread: folder.unreadEmails ?? 0,
        sortOrder: folder.sortOrder ?? 0,
      }));
  }

  /**
   * One page of a folder, newest first.
   *
   * Two calls rather than one because JMAP separates "which messages" from
   * "what they say", which is what lets the list be paged without fetching
   * every message in a mailbox that may hold tens of thousands.
   */
  async messages(input: {
    mailboxId: string;
    position?: number;
    limit?: number;
    search?: string;
  }): Promise<{ messages: MessageSummary[]; total: number; position: number }> {
    const { accountId } = await this.session();
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const position = Math.max(input.position ?? 0, 0);

    const search = input.search?.trim();
    const filter = search
      ? { operator: 'AND', conditions: [{ inMailbox: input.mailboxId }, { text: search }] }
      : { inMailbox: input.mailboxId };

    const responses = await this.post([
      [
        'Email/query',
        {
          accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit,
          calculateTotal: true,
        },
        'q',
      ],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: LIST_PROPERTIES,
        },
        'g',
      ],
    ]);

    const query = responses.find((entry) => entry[2] === 'q')?.[1] as
      | { ids?: string[]; total?: number }
      | undefined;
    const get = responses.find((entry) => entry[2] === 'g')?.[1] as
      | { list?: EmailPayload[] }
      | undefined;

    // `Email/get` may answer in any order; the query's order is the one the
    // user asked for.
    const byId = new Map((get?.list ?? []).map((email) => [email.id ?? '', email]));
    const messages = (query?.ids ?? [])
      .map((id) => byId.get(id))
      .filter((email): email is EmailPayload => email !== undefined)
      .map(summarise);

    return { messages, total: query?.total ?? messages.length, position };
  }

  async message(id: string): Promise<MessageDetail | null> {
    const { accountId } = await this.session();

    const result = await this.invoke<{ list?: EmailPayload[] }>('Email/get', {
      accountId,
      ids: [id],
      properties: [
        ...LIST_PROPERTIES,
        'cc',
        'replyTo',
        'messageId',
        'references',
        'bodyValues',
        'textBody',
        'htmlBody',
        'attachments',
      ],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: MAX_BODY_BYTES,
    });

    const email = result.list?.[0];
    if (!email) return null;

    const text = bodyOf(email, email.textBody);
    const html = bodyOf(email, email.htmlBody);

    return {
      ...summarise(email),
      cc: addressesOf(email.cc),
      replyTo: addressesOf(email.replyTo),
      text: text?.value ?? null,
      html: html?.value ?? null,
      truncated: (text?.truncated ?? false) || (html?.truncated ?? false),
      attachments: (email.attachments ?? [])
        .filter((part) => part.blobId)
        .map((part) => ({
          blobId: part.blobId!,
          name: part.name?.trim() || 'attachment',
          type: part.type ?? 'application/octet-stream',
          size: part.size ?? 0,
          inline: part.disposition === 'inline' || Boolean(part.cid),
        })),
    };
  }

  async setSeen(ids: readonly string[], seen: boolean): Promise<void> {
    if (ids.length === 0) return;
    const { accountId } = await this.session();

    const update = Object.fromEntries(
      ids.map((id) => [id, { 'keywords/$seen': seen ? true : null }]),
    );

    WebmailClient.throwSetErrors(
      await this.invoke<Record<string, unknown>>('Email/set', { accountId, update }),
    );
  }

  async setFlagged(ids: readonly string[], flagged: boolean): Promise<void> {
    if (ids.length === 0) return;
    const { accountId } = await this.session();

    const update = Object.fromEntries(
      ids.map((id) => [id, { 'keywords/$flagged': flagged ? true : null }]),
    );

    WebmailClient.throwSetErrors(
      await this.invoke<Record<string, unknown>>('Email/set', { accountId, update }),
    );
  }

  /** Moves messages wholesale, which is what "move to a folder" means here. */
  async move(ids: readonly string[], mailboxId: string): Promise<void> {
    if (ids.length === 0) return;
    const { accountId } = await this.session();

    const update = Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [mailboxId]: true } }]));

    WebmailClient.throwSetErrors(
      await this.invoke<Record<string, unknown>>('Email/set', { accountId, update }),
    );
  }

  /** Permanent. Only ever reached from a folder that is already the bin. */
  async destroy(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const { accountId } = await this.session();

    WebmailClient.throwSetErrors(
      await this.invoke<Record<string, unknown>>('Email/set', {
        accountId,
        destroy: [...ids],
      }),
    );
  }

  private async uploadScript(script: string): Promise<string> {
    const session = await this.session();

    if (!session.uploadUrl) {
      throw new WebmailError('This mail server does not offer mailbox filters.');
    }

    const response = await this.request(
      session.uploadUrl
        .replace('{accountId}', encodeURIComponent(session.accountId))
        .replace('{type}', 'text%2Fplain'),
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', accept: 'application/json' },
        body: Buffer.from(script, 'utf8'),
      },
    );
    const body = (await response.json()) as { blobId?: string };

    if (!body.blobId) {
      throw new WebmailError('The mail server accepted the filter without returning its blob.');
    }

    return body.blobId;
  }

  private async downloadScript(blobId: string): Promise<string> {
    const session = await this.session();
    const url = this.rebase(
      session.downloadUrl
        .replace('{accountId}', encodeURIComponent(session.accountId))
        .replace('{blobId}', encodeURIComponent(blobId))
        .replace('{type}', 'text%2Fplain')
        .replace('{name}', 'filter.sieve'),
    );
    const response = await this.request(url, { method: 'GET' });
    return Buffer.from(await response.arrayBuffer()).toString('utf8');
  }

  private async sieveScripts(): Promise<SieveScriptPayload[]> {
    const session = await this.session();
    if (!session.sieve) {
      throw new WebmailError('This mail server does not support mailbox filters.');
    }

    const { accountId } = session;
    const result = await this.invoke<{ list?: SieveScriptPayload[] }>('SieveScript/get', {
      accountId,
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    });

    return (result.list ?? []).filter((script) => script.id && script.blobId);
  }

  async blockedSenders(): Promise<string[]> {
    const active = (await this.sieveScripts()).find((script) => script.isActive);
    if (!active?.blobId) return [];

    return senderBlocksIn(await this.downloadScript(active.blobId));
  }

  async setSenderBlocked(sender: string, blocked: boolean): Promise<void> {
    const session = await this.session();
    const scripts = await this.sieveScripts();
    const active = scripts.find((script) => script.isActive);
    const managed = scripts.find((script) => script.name === SENDER_BLOCK_SCRIPT_NAME);
    let target = blocked ? active ?? managed : undefined;
    let currentScript = '';

    if (target?.blobId) {
      currentScript = await this.downloadScript(target.blobId);
    } else if (!blocked) {
      if (!managed?.blobId) return;
      const managedScript = await this.downloadScript(managed.blobId);
      if (!SENDER_BLOCK_PATTERN.test(managedScript)) return;
      target = managed;
      currentScript = managedScript;
    }

    if (!target && !blocked) return;

    if (!blocked && !SENDER_BLOCK_PATTERN.test(currentScript)) return;

    const senders = new Set(senderBlocksIn(currentScript));
    const wanted = sender.trim().toLowerCase();

    if (blocked) {
      if (senders.has(wanted)) return;
      senders.add(wanted);
    } else {
      if (!senders.has(wanted)) return;
      senders.delete(wanted);
    }

    const script = withSenderBlocks(currentScript, [...senders].sort());
    const blobId = await this.uploadScript(script);

    if (target?.id) {
      const result = await this.invoke<Record<string, unknown>>('SieveScript/set', {
        accountId: session.accountId,
        update: { [target.id]: { blobId } },
        ...(blocked && !target.isActive ? { onSuccessActivateScript: target.id } : {}),
      });
      WebmailClient.throwSetErrors(result);
      return;
    }

    const result = await this.invoke<Record<string, unknown>>('SieveScript/set', {
      accountId: session.accountId,
      create: {
        senderBlocks: {
          name: SENDER_BLOCK_SCRIPT_NAME,
          blobId,
        },
      },
      onSuccessActivateScript: '#senderBlocks',
    });
    WebmailClient.throwSetErrors(result);
  }

  /** One attachment, as bytes. Refused rather than truncated when huge. */
  async attachment(blobId: string, expectedSize: number): Promise<Buffer> {
    if (expectedSize > MAX_ATTACHMENT_BYTES) {
      throw new WebmailError(
        'That attachment is too large to open here. Use a mail program such as Outlook or ' +
          'Thunderbird for this message.',
      );
    }

    const session = await this.session();
    const url = this.rebase(
      session.downloadUrl
        .replace('{accountId}', encodeURIComponent(session.accountId))
        .replace('{blobId}', encodeURIComponent(blobId))
        .replace('{type}', 'application%2Foctet-stream')
        .replace('{name}', 'attachment'),
    );

    const response = await this.request(url, { method: 'GET' });
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Sends a message.
   *
   * Three steps, because JMAP separates the message from the act of sending
   * it. The draft is created first, the submission refers to it, and the
   * submission's own success is what files the copy into Sent — so a message
   * that failed to send never appears there, which is the behaviour anyone
   * would expect and the reason this is not done optimistically.
   */
  async send(input: {
    to: MailAddress[];
    cc?: MailAddress[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string | null;
    references?: string[] | null;
  }): Promise<{ ok: true }> {
    const { accountId } = await this.session();

    const identities = await this.invoke<{
      list?: Array<{ id?: string; email?: string }>;
    }>('Identity/get', { accountId, ids: null });

    const identity =
      identities.list?.find(
        (candidate) => candidate.email?.toLowerCase() === this.address.toLowerCase(),
      ) ?? identities.list?.[0];

    if (!identity?.id) {
      throw new WebmailError('This mailbox is not allowed to send mail.');
    }

    const folders = await this.folders();
    const drafts = folders.find((folder) => folder.role === 'drafts');
    const sent = folders.find((folder) => folder.role === 'sent');

    if (!drafts) {
      throw new WebmailError('This mailbox has no Drafts folder, so nothing can be composed.');
    }

    const recipients = [...input.to, ...(input.cc ?? [])];

    if (recipients.length === 0) {
      throw new WebmailError('Add at least one recipient.');
    }

    const responses = await this.post([
      [
        'Email/set',
        {
          accountId,
          create: {
            draft: {
              mailboxIds: { [drafts.id]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ email: this.address }],
              to: input.to,
              ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
              subject: input.subject,
              ...(input.inReplyTo ? { inReplyTo: [input.inReplyTo] } : {}),
              ...(input.references && input.references.length > 0
                ? { references: input.references }
                : {}),
              bodyValues: {
                body: { value: input.text },
                ...(input.html ? { html: { value: input.html } } : {}),
              },
              textBody: [{ partId: 'body', type: 'text/plain' }],
              ...(input.html ? { htmlBody: [{ partId: 'html', type: 'text/html' }] } : {}),
            },
          },
        },
        'draft',
      ],
      [
        'EmailSubmission/set',
        {
          accountId,
          create: {
            submission: {
              emailId: '#draft',
              identityId: identity.id,
              envelope: {
                mailFrom: { email: this.address },
                rcptTo: recipients.map((address) => ({ email: address.email })),
              },
            },
          },
          onSuccessUpdateEmail: {
            '#submission': {
              [`mailboxIds/${drafts.id}`]: null,
              ...(sent ? { [`mailboxIds/${sent.id}`]: true } : {}),
              'keywords/$draft': null,
            },
          },
        },
        'send',
      ],
    ]);

    for (const entry of responses) {
      WebmailClient.throwSetErrors(entry[1]);
    }

    return { ok: true };
  }
}
