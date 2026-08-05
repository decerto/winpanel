import { describe, expect, it } from 'vitest';
import type { DnsRecord } from '@winpanel/shared';
import {
  mergeSpf,
  planMailRecords,
  recommendedMailRecords,
  spfAuthorisesUs,
} from '../src/dns/mail-records.js';
import { parseDkimZoneRecords } from '../src/mail/stalwart-client.js';

/**
 * Publishing mail DNS redirects every message anybody sends to a domain, so
 * the planner is tested against the zones it will actually meet: a domain
 * moved from another host, one already half configured, and one that is
 * already correct and must therefore change nothing.
 */

const BASE = {
  zoneId: 'zone1',
  domain: 'example.com',
  serverIpv4: '203.0.113.10',
};

function record(partial: Partial<DnsRecord> & Pick<DnsRecord, 'type' | 'name' | 'content'>): DnsRecord {
  return {
    id: partial.id ?? `id-${partial.type}-${partial.name}`,
    zoneId: 'zone1',
    ttl: 1,
    proxied: false,
    ...partial,
  };
}

function find(changes: ReturnType<typeof planMailRecords>, type: string, name: string) {
  return changes.filter((change) => change.record.type === type && change.record.name === name);
}

describe('recommendedMailRecords', () => {
  it('never proxies the hostname mail is delivered to', () => {
    const records = recommendedMailRecords(BASE);
    expect(records.every((entry) => entry.proxied === false)).toBe(true);
  });

  it('includes the DKIM keys the mail server supplies', () => {
    const records = recommendedMailRecords({
      ...BASE,
      dkim: [{ name: 'sel._domainkey.example.com', value: 'v=DKIM1; p=abc' }],
    });

    expect(records.some((entry) => entry.name === 'sel._domainkey.example.com')).toBe(true);
  });
});

describe('planMailRecords', () => {
  it('creates everything on an empty zone', () => {
    const changes = planMailRecords({ ...BASE, existing: [] });

    expect(changes.every((change) => change.action === 'create')).toBe(true);
    expect(find(changes, 'A', 'mail.example.com')[0]?.record.content).toBe('203.0.113.10');
    expect(find(changes, 'MX', 'example.com')[0]?.record.priority).toBe(10);
  });

  it('removes MX records still delivering mail to the previous host', () => {
    const changes = planMailRecords({
      ...BASE,
      existing: [
        record({ type: 'MX', name: 'example.com', content: 'mx1.oldhost.net', priority: 10 }),
        record({ type: 'MX', name: 'example.com', content: 'mx2.oldhost.net', priority: 20 }),
      ],
    });

    const deletions = changes.filter((change) => change.action === 'delete');
    expect(deletions).toHaveLength(2);
    expect(deletions[0]?.reason).toContain('oldhost.net');
  });

  it('changes nothing when the zone is already correct', () => {
    const changes = planMailRecords({
      ...BASE,
      dkim: [{ name: 'sel._domainkey.example.com', value: 'v=DKIM1; p=abc' }],
      existing: [
        record({ type: 'A', name: 'mail.example.com', content: '203.0.113.10' }),
        record({ type: 'MX', name: 'example.com', content: 'mail.example.com', priority: 10 }),
        record({ type: 'TXT', name: 'example.com', content: 'v=spf1 mx -all' }),
        record({ type: 'TXT', name: 'sel._domainkey.example.com', content: 'v=DKIM1; p=abc' }),
        record({
          type: 'TXT',
          name: '_dmarc.example.com',
          content: 'v=DMARC1; p=reject',
        }),
      ],
    });

    expect(changes.every((change) => change.action === 'unchanged')).toBe(true);
  });

  it('takes the mail hostname off Cloudflare\u2019s proxy', () => {
    const changes = planMailRecords({
      ...BASE,
      existing: [
        record({ type: 'A', name: 'mail.example.com', content: '203.0.113.10', proxied: true }),
      ],
    });

    const host = find(changes, 'A', 'mail.example.com')[0];
    expect(host?.action).toBe('update');
    expect(host?.record.proxied).toBe(false);
  });

  it('deletes a CNAME that would block the mail hostname', () => {
    const changes = planMailRecords({
      ...BASE,
      existing: [
        record({ type: 'CNAME', name: 'mail.example.com', content: 'ghs.googlehosted.com' }),
      ],
    });

    expect(find(changes, 'CNAME', 'mail.example.com')[0]?.action).toBe('delete');
    expect(find(changes, 'A', 'mail.example.com')[0]?.action).toBe('create');
  });

  it('merges into an existing SPF record rather than adding a second one', () => {
    const changes = planMailRecords({
      ...BASE,
      existing: [
        record({ type: 'TXT', name: 'example.com', content: 'v=spf1 include:mailchimp.com -all' }),
      ],
    });

    const spf = find(changes, 'TXT', 'example.com');
    expect(spf).toHaveLength(1);
    expect(spf[0]?.action).toBe('update');
    expect(spf[0]?.record.content).toBe('v=spf1 include:mailchimp.com mx -all');
  });

  it('leaves an existing DMARC policy alone', () => {
    const changes = planMailRecords({
      ...BASE,
      existing: [record({ type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject' })],
    });

    expect(find(changes, 'TXT', '_dmarc.example.com')[0]?.action).toBe('unchanged');
  });

  it('republishes a signing key that no longer matches', () => {
    const changes = planMailRecords({
      ...BASE,
      dkim: [{ name: 'sel._domainkey.example.com', value: 'v=DKIM1; p=new' }],
      existing: [
        record({ type: 'TXT', name: 'sel._domainkey.example.com', content: 'v=DKIM1; p=old' }),
      ],
    });

    expect(find(changes, 'TXT', 'sel._domainkey.example.com')[0]?.action).toBe('update');
  });
});

describe('mergeSpf', () => {
  it('keeps the all mechanism last', () => {
    expect(mergeSpf('v=spf1 include:a.com ~all')).toBe('v=spf1 include:a.com mx ~all');
  });

  it('appends when there is no all mechanism', () => {
    expect(mergeSpf('v=spf1 include:a.com')).toBe('v=spf1 include:a.com mx');
  });
});

describe('spfAuthorisesUs', () => {
  it('accepts the address as well as the mechanism', () => {
    expect(spfAuthorisesUs('v=spf1 ip4:203.0.113.10 -all', 'mail.example.com', '203.0.113.10')).toBe(
      true,
    );
    expect(spfAuthorisesUs('v=spf1 include:other.com -all', 'mail.example.com', '203.0.113.10')).toBe(
      false,
    );
  });
});

describe('parseDkimZoneRecords', () => {
  it('takes only the signing keys out of a zone file', () => {
    const zone = [
      '; DKIM',
      'sel._domainkey.example.com. IN TXT "v=DKIM1; k=ed25519; p=abcdef"',
      'example.com. IN MX 10 mail.otherhost.net.',
      'example.com. IN TXT "v=spf1 mx -all"',
    ].join('\n');

    expect(parseDkimZoneRecords(zone)).toEqual([
      { name: 'sel._domainkey.example.com', value: 'v=DKIM1; k=ed25519; p=abcdef' },
    ]);
  });

  it('joins the pieces of a key split across several quoted strings', () => {
    const zone = 'rsa._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=AAAA" "BBBB"';

    expect(parseDkimZoneRecords(zone)[0]?.value).toBe('v=DKIM1; k=rsa; p=AAAABBBB');
  });
});
