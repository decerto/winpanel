import { STALWART_HTTP_PORT } from '@winpanel/shared';

/**
 * Client for the mail server's management API.
 *
 * Stalwart is the source of truth for domains and mailboxes. The panel keeps
 * no shadow copy of them: two records of who has a mailbox is two records to
 * disagree, and the one that matters is the one the mail server reads.
 *
 * The API is bound to loopback only (see `ports.ts`), so the credential never
 * leaves this machine and the traffic never leaves the adapter.
 */

const DEFAULT_BASE_URL = `http://127.0.0.1:${STALWART_HTTP_PORT}`;

/**
 * What can be learned about the mail server before any credentials exist.
 *
 * Needed because "running" and "manageable from here" are different
 * questions, and asking someone for an administrator password that this
 * version will never accept is worse than telling them so.
 */
export async function probeMailServer(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<{ running: boolean; manageable: boolean }> {
  const alive = await fetchImpl(`${baseUrl}/healthz/live`)
    .then((response) => response.ok)
    .catch(() => false);

  if (!alive) return { running: false, manageable: false };

  // Unauthenticated, a build that has this API answers 401; one that does not
  // answers 404. Either way no credentials are needed to tell them apart.
  const probe = await fetchImpl(`${baseUrl}/api/principal?types=domain&limit=1`).catch(() => null);

  return { running: true, manageable: probe !== null && probe.status !== 404 };
}

export class MailServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when the mail server could not be reached at all. */
    readonly unreachable = false,
  ) {
    super(message);
    this.name = 'MailServerError';
  }
}

/**
 * A principal as the mail server models it. Individuals are mailboxes; the
 * domain itself is also a principal, which is why one type covers both.
 */
export interface MailPrincipal {
  /** Login name. The panel always uses the full address. */
  name: string;
  type: 'individual' | 'group' | 'domain' | 'list';
  description: string;
  emails: string[];
  /** Bytes. Zero means no limit, which is the mail server's own convention. */
  quota: number;
  usedQuota: number;
}

interface PrincipalPayload {
  name?: string;
  type?: string;
  description?: string;
  emails?: string[];
  quota?: number;
  usedQuota?: number;
}

interface ListPayload {
  items?: PrincipalPayload[];
  total?: number;
}

/** Turns a failed response into something worth showing a person. */
function explain(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return (
      'The mail server rejected the panel\u2019s credentials. Reconnect it on the ' +
      'Settings page with the current administrator password.'
    );
  }
  if (status === 404) {
    return (
      'The mail server did not recognise that request. This version may not offer the ' +
      'mailbox management API the panel uses.'
    );
  }
  if (status === 409) return 'Something with that name already exists on the mail server.';

  try {
    const parsed = JSON.parse(body) as { details?: string; error?: string; reason?: string };
    const detail = parsed.details ?? parsed.reason ?? parsed.error;
    if (detail) return `The mail server refused the request: ${detail}`;
  } catch {
    // Not JSON. The status alone will have to do.
  }

  return 'The mail server refused the request.';
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorisation,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new MailServerError(explain(response.status, text), response.status);
      }

      // Deletes answer with an empty body.
      if (text.length === 0) return undefined as T;
      return (JSON.parse(text) as { data: T }).data;
    } catch (error) {
      if (error instanceof MailServerError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new MailServerError('The mail server did not respond in time.', undefined, true);
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

  /**
   * Confirms the mail server is running, that the credentials work, and that
   * this build exposes the mailbox management API.
   *
   * Three separate answers because they need three different actions:
   * install it, fix the password, or manage mailboxes in the mail server's own
   * administration. Stalwart 0.16 serves `/healthz/live` and `/api/account`
   * but dropped the principal API this panel uses, and a single "mail is
   * broken" would send people to the wrong place for all three.
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
     * Whether this build has the management API is checked before the
     * credentials are. On a version without it no password would help, so
     * reporting "wrong password" first would send someone off to reset one
     * that was never the problem.
     */
    const probe = await this.fetchImpl(`${this.baseUrl}/api/principal?types=domain&limit=1`, {
      headers: { authorization: this.authorisation, accept: 'application/json' },
    }).catch(() => null);

    if (!probe || probe.status === 404) {
      return {
        reachable: true,
        authorised: false,
        manageable: false,
        message:
          'The mail server is running, but this version does not offer the mailbox management ' +
          'API the panel uses. Mailboxes have to be managed in the mail server itself.',
      };
    }

    if (probe.status === 401 || probe.status === 403) {
      return {
        reachable: true,
        authorised: false,
        manageable: true,
        message:
          'The mail server is running but rejected the panel\u2019s credentials. Check the ' +
          'administrator name and password.',
      };
    }

    return {
      reachable: true,
      authorised: true,
      manageable: true,
      message: 'Connected to the mail server.',
    };
  }

  private static toPrincipal(payload: PrincipalPayload): MailPrincipal {
    return {
      name: payload.name ?? '',
      type: (payload.type as MailPrincipal['type']) ?? 'individual',
      description: payload.description ?? '',
      emails: payload.emails ?? [],
      quota: payload.quota ?? 0,
      usedQuota: payload.usedQuota ?? 0,
    };
  }

  private async listPrincipals(type: MailPrincipal['type']): Promise<MailPrincipal[]> {
    const payload = await this.request<ListPayload>(
      'GET',
      `/api/principal?types=${type}&page=1&limit=500`,
    );
    return (payload.items ?? []).map(StalwartClient.toPrincipal);
  }

  async listDomains(): Promise<string[]> {
    return (await this.listPrincipals('domain')).map((principal) => principal.name);
  }

  async createDomain(domain: string): Promise<void> {
    await this.request('POST', '/api/principal', { type: 'domain', name: domain.toLowerCase() });
  }

  async deleteDomain(domain: string): Promise<void> {
    await this.request('DELETE', `/api/principal/${encodeURIComponent(domain.toLowerCase())}`);
  }

  /**
   * Mailboxes, optionally narrowed to one domain.
   *
   * Filtering happens here rather than in a server-side query because the
   * panel needs the address to match exactly, and a substring filter would
   * also return `someone@notthisdomain.example`.
   */
  async listMailboxes(domain?: string): Promise<MailPrincipal[]> {
    const all = await this.listPrincipals('individual');
    if (!domain) return all;

    const suffix = `@${domain.toLowerCase()}`;
    return all.filter((principal) =>
      principal.emails.some((email) => email.toLowerCase().endsWith(suffix)),
    );
  }

  async getMailbox(address: string): Promise<MailPrincipal> {
    const payload = await this.request<PrincipalPayload>(
      'GET',
      `/api/principal/${encodeURIComponent(address.toLowerCase())}`,
    );
    return StalwartClient.toPrincipal(payload);
  }

  async createMailbox(input: {
    address: string;
    password: string;
    displayName: string;
    quotaBytes: number;
  }): Promise<void> {
    const address = input.address.toLowerCase();

    await this.request('POST', '/api/principal', {
      type: 'individual',
      // Name and address are deliberately the same. A separate login name is
      // one more thing to remember and to get wrong in a mail client.
      name: address,
      description: input.displayName,
      secrets: [input.password],
      emails: [address],
      quota: input.quotaBytes,
    });
  }

  private async patch(address: string, changes: unknown[]): Promise<void> {
    await this.request(
      'PATCH',
      `/api/principal/${encodeURIComponent(address.toLowerCase())}`,
      changes,
    );
  }

  async setQuota(address: string, quotaBytes: number): Promise<void> {
    await this.patch(address, [{ action: 'set', field: 'quota', value: quotaBytes }]);
  }

  async setPassword(address: string, password: string): Promise<void> {
    await this.patch(address, [{ action: 'set', field: 'secrets', value: [password] }]);
  }

  async setDisplayName(address: string, displayName: string): Promise<void> {
    await this.patch(address, [{ action: 'set', field: 'description', value: displayName }]);
  }

  async deleteMailbox(address: string): Promise<void> {
    await this.request('DELETE', `/api/principal/${encodeURIComponent(address.toLowerCase())}`);
  }
}
