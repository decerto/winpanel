import {
  CLOUDFLARE_PERMISSION_SUMMARY,
  CloudflareMinTlsVersion,
  CloudflareSslMode,
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

/** Cloudflare's own SSL settings for one zone, as the panel presents them. */
export interface ZoneSslSettings {
  /** False when the token cannot see zone settings at all. */
  readable: boolean;
  /** False when the plan does not allow the settings to be changed. */
  editable: boolean;
  sslMode: CloudflareSslMode | null;
  alwaysUseHttps: boolean | null;
  automaticHttpsRewrites: boolean | null;
  minTlsVersion: CloudflareMinTlsVersion | null;
  tls13: boolean | null;
}

const UNKNOWN_SSL_SETTINGS: ZoneSslSettings = {
  readable: true,
  editable: false,
  sslMode: null,
  alwaysUseHttps: null,
  automaticHttpsRewrites: null,
  minTlsVersion: null,
  tls13: null,
};

/** Turns Cloudflare's error codes into something a person can act on. */
function explain(status: number, errors: ReadonlyArray<{ code: number; message: string }>): string {
  const first = errors[0];

  if (status === 400 && /required data field/i.test(first?.message ?? '')) {
    return (
      `Cloudflare rejected the record: ${first?.message}. The panel could not break that ` +
      'record into the parts Cloudflare wants \u2014 check its value.'
    );
  }

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

/** `0 issue "letsencrypt.org"` -> the three fields Cloudflare wants. */
function parseCaa(content: string): { flags: number; tag: string; value: string } {
  const match = /^\s*(\d{1,3})\s+(issue|issuewild|iodef)\s+"?([^"]*)"?\s*$/i.exec(content);

  if (!match) {
    throw new CloudflareError(
      `"${content}" is not a certificate authority record. It should read like ` +
        '0 issue "letsencrypt.org".',
    );
  }

  return { flags: Number(match[1]), tag: match[2]!.toLowerCase(), value: match[3]!.trim() };
}

/** `10 5 443 sip.example.com` — or the same without the leading priority. */
function parseSrv(
  content: string,
  priority: number | undefined,
): { priority: number; weight: number; port: number; target: string } {
  const parts = content.trim().split(/\s+/);
  const fields = parts.length === 4 ? parts : [String(priority ?? 0), ...parts];
  const [p, weight, port, target] = fields;

  if (fields.length !== 4 || !target || [p, weight, port].some((n) => !/^\d+$/.test(n ?? ''))) {
    throw new CloudflareError(
      `"${content}" is not a service record. It should read like 10 5 443 sip.example.com.`,
    );
  }

  return {
    priority: Number(p),
    weight: Number(weight),
    port: Number(port),
    target: target.replace(/\.$/, ''),
  };
}

/**
 * The body Cloudflare expects for a write.
 *
 * Most types are a single `content` string, but CAA and SRV are structured:
 * sent as text they are rejected with "flags is a required data field" (or the
 * SRV equivalent), which says nothing about which record was at fault.
 * Cloudflare still *returns* them as one string, so the rest of the panel deals
 * in strings and the split happens only here.
 */
function recordPayload(record: Omit<DnsRecord, 'id'>): Record<string, unknown> {
  const base = {
    type: record.type,
    name: record.name,
    ttl: record.ttl,
    proxied: record.proxied,
  };

  if (record.type === 'CAA') return { ...base, data: parseCaa(record.content) };
  if (record.type === 'SRV') return { ...base, data: parseSrv(record.content, record.priority) };

  return {
    ...base,
    content: record.content,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
  };
}

/** Trailing dots and case are Cloudflare's, not the user's. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
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
      recordPayload(record),
    );

    return { ...record, id: payload.result.id };
  }

  async updateRecord(record: DnsRecord): Promise<DnsRecord> {
    if (!record.id) throw new CloudflareError('That record has no identifier.');
    await this.assertSafeToWrite(record);

    await this.request(
      'PUT',
      `/zones/${record.zoneId}/dns_records/${record.id}`,
      recordPayload(record),
    );

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
    // Several MX and CAA records legitimately coexist under one name, so those
    // match on content as well; replacing one by name would quietly delete a
    // second mail server or a second certificate authority.
    const contentMatters = record.type === 'MX' || record.type === 'CAA';
    const match = existing.find(
      (candidate) =>
        candidate.type === record.type &&
        normaliseName(candidate.name) === normaliseName(record.name) &&
        (!contentMatters || candidate.content === record.content),
    );

    if (match?.id) {
      return await this.updateRecord({ ...record, id: match.id });
    }
    return await this.createRecord(record);
  }

  /**
   * Runs a plan from `planWebsiteRecords`.
   *
   * Deletions go first and that ordering is load-bearing: a CNAME cannot
   * coexist with anything else at the same name, so creating the new A record
   * before removing the old CNAME fails outright.
   */
  async applyPlan(changes: readonly DnsChange[]): Promise<void> {
    const order: Record<DnsChange['action'], number> = {
      delete: 0,
      update: 1,
      create: 2,
      unchanged: 3,
    };

    for (const change of [...changes].sort((a, b) => order[a.action] - order[b.action])) {
      if (change.action === 'delete') {
        await this.deleteRecord(change.record.zoneId, change.record.id!);
      } else if (change.action === 'update') {
        await this.updateRecord(change.record);
      } else if (change.action === 'create') {
        await this.createRecord(change.record);
      }
    }
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

  /**
   * Everything on the SSL/TLS screen of Cloudflare's own dashboard.
   *
   * One call for the lot, because Cloudflare charges the same round trip per
   * setting and there are five of them. A token without Zone Settings
   * permission is refused here while it still works perfectly well for DNS,
   * so the caller is told which of the two it is rather than being handed a
   * blank screen.
   */
  async getSslSettings(zoneId: string): Promise<ZoneSslSettings> {
    let entries: Array<{ id: string; value: unknown; editable?: boolean }>;

    try {
      const payload = await this.request<
        Array<{ id: string; value: unknown; editable?: boolean }>
      >('GET', `/zones/${zoneId}/settings`);
      entries = payload.result ?? [];
    } catch (error) {
      if (error instanceof CloudflareError && (error.status === 403 || error.status === 401)) {
        return { ...UNKNOWN_SSL_SETTINGS, readable: false };
      }
      throw error;
    }

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const value = (id: string): unknown => byId.get(id)?.value;
    const onOff = (id: string): boolean | null => {
      const raw = value(id);
      return raw === 'on' ? true : raw === 'off' ? false : null;
    };

    const sslMode = CloudflareSslMode.safeParse(value('ssl'));
    const minTls = CloudflareMinTlsVersion.safeParse(value('min_tls_version'));

    return {
      readable: true,
      // Cloudflare marks a setting uneditable when the plan does not include
      // it, so the panel can grey the control instead of failing on save.
      editable: byId.get('ssl')?.editable !== false,
      sslMode: sslMode.success ? sslMode.data : null,
      alwaysUseHttps: onOff('always_use_https'),
      automaticHttpsRewrites: onOff('automatic_https_rewrites'),
      minTlsVersion: minTls.success ? minTls.data : null,
      // `zrt` is zero-round-trip resumption, which is 1.3 with an extra.
      tls13: value('tls_1_3') === 'off' ? false : value('tls_1_3') === undefined ? null : true,
    };
  }

  /** Changes one setting. Cloudflare has no bulk write worth the risk. */
  async setSslSetting(zoneId: string, setting: string, value: unknown): Promise<void> {
    await this.request('PATCH', `/zones/${zoneId}/settings/${setting}`, { value });
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

/** One edit the panel intends to make, with the reason in the user's terms. */
export interface DnsChange {
  readonly action: 'create' | 'update' | 'delete' | 'unchanged';
  readonly reason: string;
  readonly record: DnsRecord;
  /** What the record said before, when it is being changed or removed. */
  readonly was?: string;
}

/** Types that cannot share a name with the one we are about to write. */
function conflicts(desired: DnsRecordType, existing: DnsRecordType): boolean {
  // A CNAME may not coexist with any other record for the same name, in
  // either direction.
  if (desired === 'CNAME') return existing === 'A' || existing === 'AAAA' || existing === 'CNAME';
  if (desired === 'A') return existing === 'CNAME' || existing === 'AAAA';
  return false;
}

function conflictReason(existing: DnsRecord): string {
  if (existing.type === 'AAAA') {
    return `Removed: it sent visitors on IPv6 to ${existing.content} instead of this server.`;
  }
  return `Removed: a ${existing.type} record cannot share a name with the one this website needs.`;
}

/**
 * Works out every edit needed to make a domain reach this server.
 *
 * Upserting the two or three records a website wants is only right on an empty
 * zone. A domain moved from another host arrives with a full set: a second
 * A record at the apex round-robins half the visitors back to the old machine,
 * an AAAA sends every IPv6 visitor there permanently, a CNAME at the apex or at
 * www blocks the write entirely, and the mail, ftp and webmail names still
 * resolve to a server that is being switched off. None of that shows up as an
 * error — the site simply works for some people and not others.
 *
 * So the whole zone is read first and reconciled. Records that have nothing to
 * do with addressing (MX, TXT, SRV, NS, and any CAA already present) are never
 * touched: they are how mail and domain verification keep working.
 */
export function planWebsiteRecords(input: {
  zoneId: string;
  domain: string;
  serverIpv4: string;
  proxied: boolean;
  existing: ReadonlyArray<DnsRecord>;
  /** Also repoint other names that still resolve to the previous server. */
  repointStale?: boolean;
}): DnsChange[] {
  const domain = normaliseName(input.domain);
  const managed = new Set([domain, `www.${domain}`]);
  const changes: DnsChange[] = [];
  const handled = new Set<string>();

  const at = (name: string) =>
    input.existing.filter((record) => normaliseName(record.name) === name);

  /*
   * Addresses the domain resolves to today and shouldn't. Anything else in the
   * zone still pointing at one of them is pointing at the old server, which is
   * what makes repointing mail/ftp/webmail safe to offer rather than a guess.
   */
  const previous = new Set(
    at(domain)
      .filter((record) => record.type === 'A' && record.content !== input.serverIpv4)
      .map((record) => record.content),
  );

  const [apex, www] = recommendedWebsiteRecords({
    zoneId: input.zoneId,
    domain,
    serverIpv4: input.serverIpv4,
    proxied: input.proxied,
  });

  for (const desired of [apex!, www!]) {
    const name = normaliseName(desired.name);
    let kept = false;

    for (const record of at(name)) {
      if (!record.id || handled.has(record.id)) continue;

      if (record.type === desired.type) {
        handled.add(record.id);

        if (kept) {
          changes.push({
            action: 'delete',
            reason: `Removed: a second ${record.type} record here would send some visitors to ${record.content}.`,
            record,
            was: record.content,
          });
          continue;
        }

        kept = true;
        const sameTarget = normaliseName(record.content) === normaliseName(desired.content);
        const same = sameTarget && record.proxied === desired.proxied;

        changes.push({
          action: same ? 'unchanged' : 'update',
          reason: same
            ? 'Already correct.'
            : sameTarget
              ? `Already points here; only the Cloudflare setting changes.`
              : `Updated from ${record.content}.`,
          record: { ...desired, id: record.id },
          ...(same ? {} : { was: record.content }),
        });
        continue;
      }

      if (conflicts(desired.type, record.type)) {
        handled.add(record.id);
        changes.push({
          action: 'delete',
          reason: conflictReason(record),
          record,
          was: record.content,
        });
      }
    }

    if (!kept) {
      changes.push({
        action: 'create',
        reason: 'Added: this is what makes the address reach this server.',
        record: { ...desired, id: null },
      });
    }
  }

  /*
   * CAA is additive — several may name several authorities — so an existing one
   * is never replaced. Ours is only added when Let's Encrypt is not already
   * allowed, otherwise renewals would start failing the moment somebody else's
   * CAA record was overwritten.
   */
  const caa = recommendedWebsiteRecords({
    zoneId: input.zoneId,
    domain,
    serverIpv4: input.serverIpv4,
    proxied: false,
  })[2]!;

  const hasLetsEncrypt = at(domain).some(
    (record) => record.type === 'CAA' && /issue\s+"?letsencrypt\.org/i.test(record.content),
  );

  if (!hasLetsEncrypt) {
    changes.push({
      action: 'create',
      reason: 'Added: allows this server to renew the HTTPS certificate.',
      record: { ...caa, id: null },
    });
  }

  if (input.repointStale !== false) {
    for (const record of input.existing) {
      if (!record.id || handled.has(record.id)) continue;
      if (record.type !== 'A') continue;
      if (managed.has(normaliseName(record.name))) continue;
      if (!previous.has(record.content)) continue;

      handled.add(record.id);
      changes.push({
        action: 'update',
        // The proxy setting is kept: mail hostnames must not be proxied, and
        // this record's existing value already reflects that.
        record: { ...record, content: input.serverIpv4 },
        reason: `Updated from ${record.content}, the server this website is moving off.`,
        was: record.content,
      });
    }
  }

  return changes;
}
