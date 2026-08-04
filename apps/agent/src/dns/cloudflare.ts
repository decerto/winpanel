import {
  CLOUDFLARE_PERMISSION_SUMMARY,
  validateDnsRecord,
  type CloudflareZone,
  type DnsRecord,
  type DnsRecordType,
} from '@winpanel/shared';

/**
 * Cloudflare API client.
 *
 * Every write goes through `validateDnsRecord` first. That check is not
 * advisory: proxying a mail hostname makes SMTP unreachable, and proxying the
 * certificate challenge record stops renewals — both fail silently, and the
 * resulting symptoms point nowhere near DNS. Refusing up front is far kinder
 * than letting someone discover it three weeks later when a certificate
 * expires.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errors: ReadonlyArray<{ code: number; message: string }> = [],
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

/** Turns Cloudflare's error codes into something a person can act on. */
function explain(status: number, errors: ReadonlyArray<{ code: number; message: string }>): string {
  const first = errors[0];

  if (status === 401 || status === 403 || first?.code === 9109 || first?.code === 10000) {
    return (
      'Cloudflare rejected the access token. Copy it again from Cloudflare — it is the long ' +
      'value shown once when the token is created, not the token name or your account API key ' +
      `— and check its permissions include ${CLOUDFLARE_PERMISSION_SUMMARY}.`
    );
  }
  if (first?.code === 81057) {
    return 'A record with that name already exists.';
  }
  if (first?.code === 1004 || first?.code === 9005) {
    return `Cloudflare rejected the record: ${first.message}`;
  }
  if (status === 429) {
    return 'Cloudflare is rate limiting requests. Wait a moment and try again.';
  }
  return first?.message ?? 'Cloudflare rejected the request.';
}

export class CloudflareClient {
  private readonly token: string;

  constructor(
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = API_BASE,
  ) {
    // Tokens are pasted, and a stray newline makes Cloudflare answer with the
    // same "invalid token" it gives a genuinely wrong one.
    this.token = token.trim();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<CloudflareResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const payload = (await response.json()) as CloudflareResponse<T>;

      if (!response.ok || !payload.success) {
        throw new CloudflareError(
          explain(response.status, payload.errors ?? []),
          response.status,
          payload.errors ?? [],
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new CloudflareError('Cloudflare did not respond in time.');
      }
      throw new CloudflareError(
        'Could not reach Cloudflare. Check the server\u2019s internet connection.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Confirms the token works and has the permissions we need.
   *
   * Run when the token is entered rather than at first use, so the failure
   * surfaces while the user is looking at the field they just filled in.
   */
  async verifyToken(): Promise<{ valid: boolean; message: string }> {
    try {
      await this.request<{ id: string; status: string }>('GET', '/user/tokens/verify');
    } catch (error) {
      return {
        valid: false,
        message: error instanceof CloudflareError ? error.message : 'The token is not valid.',
      };
    }

    // Verification only proves the token exists. Listing zones proves it can
    // actually do the job.
    let zones: CloudflareZone[];
    try {
      zones = await this.listZones();
    } catch {
      return {
        valid: false,
        message:
          'The token works but cannot read your domains. Add the permission ' +
          `${CLOUDFLARE_PERMISSION_SUMMARY} to it in Cloudflare.`,
      };
    }

    if (zones.length === 0) {
      return {
        valid: false,
        message:
          'The token works but no domains are in reach of it. Under Zone Resources, include ' +
          'the domains this server should manage \u2014 and check the token was made in the ' +
          'Cloudflare account those domains belong to.',
      };
    }

    return { valid: true, message: 'Connected to Cloudflare.' };
  }

  async listZones(): Promise<CloudflareZone[]> {
    const payload = await this.request<
      Array<{ id: string; name: string; status: string }>
    >('GET', '/zones?per_page=50');

    return payload.result.map((zone) => ({
      id: zone.id,
      name: zone.name,
      status: zone.status,
      sslMode: null,
    }));
  }

  /** Finds the zone that owns a hostname, e.g. shop.example.com -> example.com. */
  async findZoneForHostname(hostname: string): Promise<CloudflareZone | null> {
    const zones = await this.listZones();
    const lower = hostname.toLowerCase();

    // Longest match wins, so a delegated subdomain zone beats its parent.
    const matches = zones
      .filter((zone) => lower === zone.name || lower.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length);

    return matches[0] ?? null;
  }

  async listRecords(zoneId: string): Promise<DnsRecord[]> {
    const payload = await this.request<
      Array<{
        id: string;
        type: string;
        name: string;
        content: string;
        ttl: number;
        priority?: number;
        proxied?: boolean;
      }>
    >('GET', `/zones/${zoneId}/dns_records?per_page=500`);

    return payload.result.map((record) => ({
      id: record.id,
      zoneId,
      type: record.type as DnsRecordType,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
      proxied: record.proxied ?? false,
    }));
  }

  /** The hostnames the zone's MX records point at, so they can be protected. */
  async mailHostnames(zoneId: string): Promise<string[]> {
    const records = await this.listRecords(zoneId);
    return records
      .filter((record) => record.type === 'MX')
      .map((record) => record.content.toLowerCase().replace(/\.$/, ''));
  }

  async createRecord(record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    await this.assertSafeToWrite(record);

    const payload = await this.request<{ id: string }>(
      'POST',
      `/zones/${record.zoneId}/dns_records`,
      {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
        ...(record.priority !== undefined ? { priority: record.priority } : {}),
      },
    );

    return { ...record, id: payload.result.id };
  }

  async updateRecord(record: DnsRecord): Promise<DnsRecord> {
    if (!record.id) throw new CloudflareError('That record has no identifier.');
    await this.assertSafeToWrite(record);

    await this.request('PUT', `/zones/${record.zoneId}/dns_records/${record.id}`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
    });

    return record;
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  }

  /**
   * Creates or updates, matching on name and type.
   *
   * Used by "set up DNS for me", which must be safe to run twice without
   * producing duplicate records.
   */
  async upsertRecord(record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    const existing = await this.listRecords(record.zoneId);
    const match = existing.find(
      (candidate) =>
        candidate.type === record.type &&
        candidate.name.toLowerCase() === record.name.toLowerCase() &&
        // Several MX records legitimately coexist, so those match on content.
        (record.type !== 'MX' || candidate.content === record.content),
    );

    if (match?.id) {
      return await this.updateRecord({ ...record, id: match.id });
    }
    return await this.createRecord(record);
  }

  /**
   * Cloudflare's SSL mode.
   *
   * Anything other than Full (strict) while proxying means the leg between
   * Cloudflare and this server is unverified, which quietly undoes much of the
   * point of having a certificate at all.
   */
  async setStrictSsl(zoneId: string): Promise<void> {
    await this.request('PATCH', `/zones/${zoneId}/settings/ssl`, { value: 'strict' });
  }

  async getSslMode(zoneId: string): Promise<string | null> {
    try {
      const payload = await this.request<{ value: string }>(
        'GET',
        `/zones/${zoneId}/settings/ssl`,
      );
      return payload.result.value;
    } catch {
      return null;
    }
  }

  /** Rejects a write that would break mail or certificate renewal. */
  private async assertSafeToWrite(record: Omit<DnsRecord, 'id'>): Promise<void> {
    let mailHosts: string[] = [];
    if (record.proxied) {
      // Only worth the extra call when the proxy is actually being turned on.
      try {
        mailHosts = await this.mailHostnames(record.zoneId);
      } catch {
        mailHosts = [];
      }
    }

    const validation = validateDnsRecord(record, mailHosts);
    if (!validation.ok) {
      throw new CloudflareError(validation.reason);
    }
  }
}

/**
 * The records a website needs, ready to be applied in one action.
 */
export function recommendedWebsiteRecords(input: {
  zoneId: string;
  domain: string;
  serverIpv4: string;
  proxied: boolean;
}): Array<Omit<DnsRecord, 'id'>> {
  const records: Array<Omit<DnsRecord, 'id'>> = [
    {
      zoneId: input.zoneId,
      type: 'A',
      name: input.domain,
      content: input.serverIpv4,
      ttl: 1,
      proxied: input.proxied,
    },
    {
      zoneId: input.zoneId,
      type: 'CNAME',
      name: `www.${input.domain}`,
      content: input.domain,
      ttl: 1,
      proxied: input.proxied,
    },
  ];

  // Restricts which authorities may issue certificates for this domain.
  records.push({
    zoneId: input.zoneId,
    type: 'CAA',
    name: input.domain,
    content: '0 issue "letsencrypt.org"',
    ttl: 1,
    proxied: false,
  });

  return records;
}
