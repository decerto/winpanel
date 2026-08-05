import { STALWART_HTTP_PORT, WEB_PORTS } from '@winpanel/shared';

/**
 * Client for the mail server's management API.
 *
 * Stalwart is the source of truth for domains and mailboxes. The panel keeps
 * no shadow copy of them: two records of who has a mailbox is two records to
 * disagree, and the one that matters is the one the mail server reads.
 *
 * Since 0.16 that API is JMAP. The REST endpoints under `/api/principal` were
 * removed outright, and every management object — domains, accounts, and the
 * server's own settings — is now reached by posting JMAP method calls to the
 * JMAP endpoint under the `urn:stalwart:jmap` capability. Those objects are
 * named with an `x:` prefix to keep them apart from the mail objects JMAP
 * already defines.
 *
 * The API is bound to loopback only (see `ports.ts`), so the credential never
 * leaves this machine and the traffic never leaves the adapter.
 */

const DEFAULT_BASE_URL = `http://127.0.0.1:${STALWART_HTTP_PORT}`;

/**
 * Where method calls go. `/api` is a different thing on this server — login,
 * autodiscover, the schema — and answers 404 to a JMAP request, which reads
 * exactly like a build that has no management API at all.
 */
const JMAP_ENDPOINT = '/jmap';

/** Management objects live behind Stalwart's own capability. */
const CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

/** Nothing sensible is ever this large, and it bounds a runaway response. */
const PAGE_LIMIT = 500;

type ObjectType = 'x:Domain' | 'x:Account' | 'x:NetworkListener';

/** One entry of a JMAP `methodResponses` array. */
type MethodResponse = [string, Record<string, unknown>, string];

export class MailServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when the mail server could not be reached at all. */
    readonly unreachable = false,
    /** True when this build has no management API to talk to. */
    readonly unsupported = false,
  ) {
    super(message);
    this.name = 'MailServerError';
  }
}

/**
 * A principal as the panel thinks of it. Individuals are mailboxes; a domain
 * is a separate object in Stalwart, but the shape is close enough that one
 * type covers what the panel shows.
 */
export interface MailPrincipal {
  /** Full email address, which is also the login name. */
  name: string;
  type: 'individual' | 'group' | 'domain' | 'list';
  description: string;
  /** Primary address first, then aliases. */
  emails: string[];
  /** Bytes. Zero means no limit, which is the mail server's own convention. */
  quota: number;
  usedQuota: number;
}

interface DomainPayload {
  id?: string;
  name?: string;
  /** A BIND zone file for the domain, only when asked for by name. */
  dnsZoneFile?: string;
}

interface AliasPayload {
  name?: string;
  domainId?: string;
  enabled?: boolean;
}

interface ListenerPayload {
  id?: string;
  name?: string;
  bind?: Record<string, string> | string[];
}

interface AccountPayload {
  id?: string;
  '@type'?: string;
  name?: string;
  emailAddress?: string;
  description?: string | null;
  domainId?: string;
  aliases?: Record<string, AliasPayload> | AliasPayload[];
  quotas?: Record<string, number>;
  usedDiskQuota?: number;
}

/**
 * Fields holding a list are carried as maps keyed by position in this dialect,
 * so a single entry can be patched without resending the rest. Reading has to
 * cope with either shape.
 */
function valuesOf<T>(value: Record<string, T> | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

/** The counterpart for writing one back. */
function indexed<T>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries(values.map((value, index) => [String(index), value]));
}

/**
 * The port out of a bind address, which may be `1.2.3.4:80` or `[::]:443`.
 * The last colon is the separator in both, since IPv6 addresses are bracketed.
 */
export function portOfBindAddress(address: string): number | null {
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Pulls the DKIM records out of a BIND zone file.
 *
 * Only DKIM is taken. The mail server also offers MX, SPF, autodiscover and
 * the rest, but it composes those from its own configured hostname, which the
 * panel does not set — so publishing them would point mail at whatever name
 * the mail server happens to think it has. DKIM is different: the signing key
 * exists nowhere else, so it can only come from here.
 *
 * A line reads `sel._domainkey.example.com. IN TXT "v=DKIM1; ..."`, and a long
 * RSA key is split across several quoted strings on one line, which DNS
 * concatenates back together with nothing in between.
 */
export function parseDkimZoneRecords(zoneFile: string): Array<{ name: string; value: string }> {
  const records: Array<{ name: string; value: string }> = [];

  for (const line of zoneFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(';') || !trimmed.includes('._domainkey.')) continue;

    const match = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?TXT\s+(.+)$/i.exec(trimmed);
    if (!match) continue;

    const segments = [...(match[2] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((quoted) =>
      (quoted[1] ?? '').replace(/\\(.)/g, '$1'),
    );
    const value = segments.length > 0 ? segments.join('') : (match[2] ?? '').trim();
    if (!value.toLowerCase().startsWith('v=dkim1')) continue;

    records.push({ name: (match[1] ?? '').replace(/\.$/, '').toLowerCase(), value });
  }

  return records;
}

/** Turns a failed HTTP response into something worth showing a person. */
function explainStatus(status: number): string {
  if (status === 401 || status === 403) {
    return (
      'The mail server rejected the panel\u2019s credentials. Reconnect it on the ' +
      'Settings page with the current administrator password.'
    );
  }
  if (status === 404) {
    return (
      'The mail server did not offer its management API. This version may be older than the ' +
      'panel expects, or it may still be waiting for its own first-time setup.'
    );
  }
  if (status === 429) return 'The mail server asked the panel to slow down. Try again shortly.';

  return `The mail server refused the request (error ${status}).`;
}

/**
 * Turns a JMAP error into a sentence.
 *
 * The `type` is the part worth branching on: a missing permission and a
 * missing method both arrive as a refusal, and they need opposite actions —
 * one is fixed on the mail server's account, the other cannot be fixed at all.
 */
export function explainJmapError(type: string | undefined, description?: string): MailServerError {
  switch (type) {
    case 'unknownMethod':
    case 'unknownCapability':
      return new MailServerError(
        'This mail server does not offer the management API the panel uses, so mailboxes have ' +
          'to be managed in the mail server\u2019s own administration.',
        undefined,
        false,
        true,
      );
    case 'forbidden':
    case 'accountReadOnly':
      return new MailServerError(
        'The mail server signed the panel in, but that account is not allowed to manage ' +
          'domains and mailboxes. Give it the administrator role on the mail server.',
      );
    case 'invalidArguments':
    case 'invalidProperties':
      return new MailServerError(
        description
          ? `The mail server would not accept that: ${description}`
          : 'The mail server would not accept those details.',
      );
    case 'alreadyExists':
    case 'primaryKeyViolation':
      return new MailServerError('Something with that name already exists on the mail server.');
    case 'invalidForeignKey':
      return new MailServerError(
        'The mail server does not know about that domain yet. Add the domain first.',
      );
    default:
      return new MailServerError(
        description
          ? `The mail server refused the request: ${description}`
          : 'The mail server refused the request.',
      );
  }
}

/** The one error shape a `Foo/set` reports per object rather than per call. */
function throwFirstSetError(args: Record<string, unknown>): void {
  for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
    const failures = args[key] as
      | Record<string, { type?: string; description?: string }>
      | undefined;
    const first = failures && Object.values(failures)[0];
    if (first) throw explainJmapError(first.type, first.description);
  }
}

/**
 * What can be learned about the mail server before any credentials exist.
 *
 * Needed because "running" and "manageable from here" are different questions,
 * and asking someone for an administrator password that this version will
 * never accept is worse than telling them so.
 */
export async function probeMailServer(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<{ running: boolean; manageable: boolean }> {
  const alive = await fetchImpl(`${baseUrl}/healthz/live`)
    .then((response) => response.ok)
    .catch(() => false);

  if (!alive) return { running: false, manageable: false };

  // Unauthenticated, a build with this API answers 401; one without it answers
  // 404. Either way no credentials are needed to tell them apart.
  const probe = await fetchImpl(`${baseUrl}${JMAP_ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ using: CAPABILITIES, methodCalls: [] }),
  }).catch(() => null);

  return { running: true, manageable: probe !== null && probe.status !== 404 };
}

export class StalwartClient {
  private readonly authorisation: string;

  constructor(
    username: string,
    password: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.authorisation = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  /** Posts one JMAP request and hands back the raw method responses. */
  private async post(methodCalls: MethodResponse[]): Promise<MethodResponse[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${JMAP_ENDPOINT}`, {
        method: 'POST',
        headers: {
          authorization: this.authorisation,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ using: CAPABILITIES, methodCalls }),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new MailServerError(
          explainStatus(response.status),
          response.status,
          false,
          response.status === 404,
        );
      }

      const parsed = JSON.parse(text) as { methodResponses?: MethodResponse[] };
      return parsed.methodResponses ?? [];
    } catch (error) {
      if (error instanceof MailServerError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new MailServerError('The mail server did not respond in time.', undefined, true);
      }
      if (error instanceof SyntaxError) {
        throw new MailServerError('The mail server sent back something the panel could not read.');
      }
      throw new MailServerError(
        'Could not reach the mail server. It may not be installed or running yet.',
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** One method call, with both layers of JMAP error reporting unwrapped. */
  private async invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const responses = await this.post([[name, args, 'c0']]);
    const first = responses[0];

    if (!first) {
      throw new MailServerError('The mail server answered without saying anything.');
    }

    if (first[0] === 'error') {
      throw explainJmapError(first[1]['type'] as string, first[1]['description'] as string);
    }

    return first[1] as T;
  }

  private async queryIds(type: ObjectType, filter?: Record<string, unknown>): Promise<string[]> {
    const result = await this.invoke<{ ids?: string[] }>(`${type}/query`, {
      ...(filter ? { filter } : {}),
      limit: PAGE_LIMIT,
    });
    return result.ids ?? [];
  }

  private async fetchByIds<T>(type: ObjectType, ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const result = await this.invoke<{ list?: T[] }>(`${type}/get`, { ids: [...ids] });
    return result.list ?? [];
  }

  private async set(
    type: ObjectType,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.invoke<Record<string, unknown>>(`${type}/set`, args);
    throwFirstSetError(result);
    return result;
  }

  /**
   * Confirms the mail server is running, that the credentials work, and that
   * this build exposes the management API.
   *
   * Three separate answers because they need three different actions: install
   * it, fix the credentials, or manage mailboxes in the mail server's own
   * administration. A single "mail is broken" would send people to the wrong
   * place for all three.
   */
  async ping(): Promise<{
    reachable: boolean;
    authorised: boolean;
    manageable: boolean;
    message: string;
  }> {
    const offline = {
      reachable: false,
      authorised: false,
      manageable: false,
      message: 'Could not reach the mail server. It may not be installed or running yet.',
    };

    try {
      const health = await this.fetchImpl(`${this.baseUrl}/healthz/live`, {
        headers: { accept: 'application/json' },
      });
      if (!health.ok) return offline;
    } catch {
      return offline;
    }

    /*
     * Listing domains is the smallest request that settles every remaining
     * question at once: whether the API is there, whether the credentials are
     * accepted, and whether the account they belong to may manage anything.
     */
    try {
      await this.queryIds('x:Domain');

      return {
        reachable: true,
        authorised: true,
        manageable: true,
        message: 'Connected to the mail server.',
      };
    } catch (error) {
      if (!(error instanceof MailServerError)) throw error;
      if (error.unreachable) return offline;

      return {
        reachable: true,
        authorised: false,
        manageable: !error.unsupported,
        message: error.message,
      };
    }
  }

  private async allDomains(): Promise<DomainPayload[]> {
    return await this.fetchByIds<DomainPayload>('x:Domain', await this.queryIds('x:Domain'));
  }

  async listDomains(): Promise<string[]> {
    return (await this.allDomains())
      .map((domain) => domain.name ?? '')
      .filter((name) => name.length > 0);
  }

  /**
   * The record for one domain.
   *
   * The server's `name` filter matches on text rather than exactly, so the
   * result is confirmed here — `example.com` must not resolve to
   * `mail.example.com`.
   */
  private async domainRecord(domain: string): Promise<DomainPayload | null> {
    const wanted = domain.toLowerCase();
    const found = await this.fetchByIds<DomainPayload>(
      'x:Domain',
      await this.queryIds('x:Domain', { name: wanted }),
    );

    return found.find((candidate) => candidate.name?.toLowerCase() === wanted) ?? null;
  }

  private async requireDomainId(domain: string): Promise<string> {
    const record = await this.domainRecord(domain);

    if (!record?.id) {
      throw new MailServerError(
        `The mail server does not handle mail for ${domain} yet. Add the domain first.`,
      );
    }

    return record.id;
  }

  async createDomain(domain: string): Promise<void> {
    await this.set('x:Domain', {
      create: {
        new1: {
          name: domain.toLowerCase(),
          aliases: {},
          /*
           * The panel issues certificates through the web server and publishes
           * DNS itself when Cloudflare is connected, so the mail server is
           * asked to manage neither. DKIM is the one thing only it can do,
           * because only it holds the signing key.
           */
          certificateManagement: { '@type': 'Manual' },
          dkimManagement: { '@type': 'Automatic' },
          dnsManagement: { '@type': 'Manual' },
          subAddressing: { '@type': 'Enabled' },
        },
      },
    });
  }

  async deleteDomain(domain: string): Promise<void> {
    const record = await this.domainRecord(domain);
    if (!record?.id) return;

    await this.set('x:Domain', { destroy: [record.id] });
  }

  /**
   * The DKIM records to publish for a domain.
   *
   * Empty rather than an error when the mail server does not offer them: a
   * domain can be perfectly deliverable without DKIM, and refusing to set up
   * MX and SPF because the signing key could not be read would be a worse
   * outcome than setting them up unsigned.
   */
  async dkimRecords(domain: string): Promise<Array<{ name: string; value: string }>> {
    const record = await this.domainRecord(domain);
    if (!record?.id) return [];

    try {
      const result = await this.invoke<{ list?: DomainPayload[] }>('x:Domain/get', {
        ids: [record.id],
        properties: ['id', 'name', 'dnsZoneFile'],
      });

      return parseDkimZoneRecords(result.list?.[0]?.dnsZoneFile ?? '');
    } catch (error) {
      if (error instanceof MailServerError) return [];
      throw error;
    }
  }

  /** Every address an account answers to, given the domains it may use. */
  private static addressesOf(account: AccountPayload, domains: Map<string, string>): string[] {
    const composed =
      account.name && account.domainId && domains.has(account.domainId)
        ? `${account.name}@${domains.get(account.domainId)}`
        : (account.name ?? '');

    const aliases = valuesOf(account.aliases)
      .filter((alias) => alias.enabled !== false && alias.name && alias.domainId)
      .map((alias) => `${alias.name}@${domains.get(alias.domainId ?? '') ?? ''}`)
      .filter((address) => !address.endsWith('@'));

    return [account.emailAddress ?? composed, ...aliases].filter((address) => address.length > 0);
  }

  private static toPrincipal(account: AccountPayload, domains: Map<string, string>): MailPrincipal {
    const emails = StalwartClient.addressesOf(account, domains);

    return {
      name: emails[0] ?? account.name ?? '',
      type: account['@type'] === 'Group' ? 'group' : 'individual',
      description: account.description ?? '',
      emails,
      quota: account.quotas?.['maxDiskQuota'] ?? 0,
      usedQuota: account.usedDiskQuota ?? 0,
    };
  }

  /** Domain id to domain name, so an account can be given a full address. */
  private async domainNames(): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    for (const domain of await this.allDomains()) {
      if (domain.id && domain.name) map.set(domain.id, domain.name);
    }

    return map;
  }

  /** Mailboxes, optionally narrowed to one domain. */
  async listMailboxes(domain?: string): Promise<MailPrincipal[]> {
    const domains = await this.domainNames();

    let filter: Record<string, unknown> | undefined;

    if (domain) {
      const wanted = domain.toLowerCase();
      const domainId = [...domains.entries()].find(
        ([, name]) => name.toLowerCase() === wanted,
      )?.[0];

      // A domain the mail server has never heard of has no mailboxes, which is
      // not an error: it is the normal state before the first one is made.
      if (!domainId) return [];
      filter = { domainId };
    }

    const accounts = await this.fetchByIds<AccountPayload>(
      'x:Account',
      await this.queryIds('x:Account', filter),
    );

    return accounts
      .filter((account) => account['@type'] !== 'Group')
      .map((account) => StalwartClient.toPrincipal(account, domains));
  }

  private async accountRecord(address: string): Promise<AccountPayload | null> {
    const wanted = address.toLowerCase();
    const [local, domain] = wanted.split('@');
    if (!local || !domain) return null;

    const domainRecord = await this.domainRecord(domain);
    if (!domainRecord?.id) return null;

    const accounts = await this.fetchByIds<AccountPayload>(
      'x:Account',
      await this.queryIds('x:Account', { name: local, domainId: domainRecord.id }),
    );

    return (
      accounts.find(
        (account) =>
          account.emailAddress?.toLowerCase() === wanted ||
          (account.name?.toLowerCase() === local && account.domainId === domainRecord.id),
      ) ?? null
    );
  }

  private async requireAccountId(address: string): Promise<string> {
    const account = await this.accountRecord(address);

    if (!account?.id) {
      throw new MailServerError(`There is no mailbox for ${address} on the mail server.`);
    }

    return account.id;
  }

  async getMailbox(address: string): Promise<MailPrincipal> {
    const account = await this.accountRecord(address);

    if (!account) {
      throw new MailServerError(`There is no mailbox for ${address} on the mail server.`);
    }

    return StalwartClient.toPrincipal(account, await this.domainNames());
  }

  async createMailbox(input: {
    address: string;
    password: string;
    displayName: string;
    quotaBytes: number;
  }): Promise<void> {
    const address = input.address.toLowerCase();
    const [local, domain] = address.split('@');

    if (!local || !domain) {
      throw new MailServerError('That is not a complete email address.');
    }

    const domainId = await this.requireDomainId(domain);

    await this.set('x:Account', {
      create: {
        new1: {
          '@type': 'User',
          // The login name is the local part; the mail server composes the
          // address from it and the domain and returns it as `emailAddress`.
          name: local,
          domainId,
          description: input.displayName,
          aliases: {},
          credentials: { '0': { '@type': 'Password', secret: input.password } },
          memberGroupIds: {},
          permissions: { '@type': 'Inherit' },
          quotas: input.quotaBytes > 0 ? { maxDiskQuota: input.quotaBytes } : {},
          roles: { '@type': 'User' },
          encryptionAtRest: { '@type': 'Disabled' },
        },
      },
    });
  }

  private async update(address: string, changes: Record<string, unknown>): Promise<void> {
    const id = await this.requireAccountId(address);
    await this.set('x:Account', { update: { [id]: changes } });
  }

  async setQuota(address: string, quotaBytes: number): Promise<void> {
    await this.update(address, { quotas: quotaBytes > 0 ? { maxDiskQuota: quotaBytes } : {} });
  }

  async setPassword(address: string, password: string): Promise<void> {
    await this.update(address, {
      credentials: { '0': { '@type': 'Password', secret: password } },
    });
  }

  async setDisplayName(address: string, displayName: string): Promise<void> {
    await this.update(address, { description: displayName });
  }

  async deleteMailbox(address: string): Promise<void> {
    const id = await this.requireAccountId(address);
    await this.set('x:Account', { destroy: [id] });
  }

  /**
   * Takes the mail server off ports 80 and 443.
   *
   * Stalwart ships with an implicit-TLS listener on `[::]:443` and binds it on
   * first start, which is correct for a machine where it is the only server
   * and catastrophic here: whichever of it and Caddy starts first wins the
   * port, and the loser cannot bind at all. After an update — which stops
   * everything and starts it again — the winner is decided by a race, and once
   * the mail server has 443 the web server can never start again, on any
   * restart or reboot, so every website on the machine stays dark.
   *
   * Caddy already fronts the mail server's admin interface and issues its
   * certificates, so nothing is lost by moving it off the edge. A listener
   * that binds nothing else is removed rather than left with an empty address
   * list, which the mail server rejects.
   *
   * @returns a description of each listener changed, empty when nothing was.
   */
  async releaseWebPorts(): Promise<string[]> {
    const listeners = await this.fetchByIds<ListenerPayload>(
      'x:NetworkListener',
      await this.queryIds('x:NetworkListener'),
    );

    const changes: string[] = [];
    const destroy: string[] = [];
    const update: Record<string, Record<string, unknown>> = {};

    for (const listener of listeners) {
      if (!listener.id) continue;

      const bound = valuesOf(listener.bind);
      const taken = bound.filter((address) => {
        const port = portOfBindAddress(address);
        return port !== null && (WEB_PORTS as readonly number[]).includes(port);
      });
      if (taken.length === 0) continue;

      const name = listener.name ?? listener.id;
      const kept = bound.filter((address) => !taken.includes(address));

      if (kept.length === 0) {
        destroy.push(listener.id);
        changes.push(`Removed the mail server\u2019s "${name}" listener on ${taken.join(', ')}.`);
      } else {
        update[listener.id] = { bind: indexed(kept) };
        changes.push(`Took the mail server\u2019s "${name}" listener off ${taken.join(', ')}.`);
      }
    }

    if (changes.length === 0) return [];

    await this.set('x:NetworkListener', {
      ...(Object.keys(update).length > 0 ? { update } : {}),
      ...(destroy.length > 0 ? { destroy } : {}),
    });

    return changes;
  }
}
