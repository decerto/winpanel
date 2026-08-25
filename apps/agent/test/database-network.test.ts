import { describe, expect, it } from 'vitest';
import {
  databaseBindAddress,
  databaseFirewallRemoteIp,
  includeDatabaseServerAddress,
  databaseServerArgs,
  normaliseDatabaseNetworkPolicy,
  normaliseRemoteCidr,
  unmapIpv4,
} from '../src/databases/network.js';

describe('database network policy', () => {
  it('defaults engines to loopback and binds each service there', () => {
    const policy = normaliseDatabaseNetworkPolicy('loopback');

    expect(databaseBindAddress(policy)).toBe('127.0.0.1');
    expect(databaseServerArgs('mariadb', 'C:\\data\\database', policy)).toContain(
      '--bind-address=127.0.0.1',
    );
    expect(databaseServerArgs('postgres', 'C:\\data\\postgres', policy)).toEqual([
      '-D',
      'C:\\data\\postgres',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
    ]);
    expect(databaseServerArgs('mongodb', 'C:\\data\\mongodb', policy)).toContain('127.0.0.1');
    expect(databaseFirewallRemoteIp(policy)).toBeUndefined();
  });

  it('binds externally but restricts a whitelist to its canonical sources', () => {
    const policy = normaliseDatabaseNetworkPolicy('whitelist', [
      '203.0.113.42',
      '203.0.113.0/24',
      '203.0.113.42',
    ]);

    expect(policy.remoteCidrs).toEqual(['203.0.113.42', '203.0.113.0/24']);
    expect(databaseBindAddress(policy)).toBe('0.0.0.0');
    expect(databaseFirewallRemoteIp(policy)).toBe('203.0.113.42,203.0.113.0/24');
  });

  it('keeps the panel server address in a whitelist', () => {
    const policy = normaliseDatabaseNetworkPolicy('whitelist', ['203.0.113.42']);

    expect(includeDatabaseServerAddress(policy, '198.51.100.10')).toEqual({
      mode: 'whitelist',
      remoteCidrs: ['203.0.113.42', '198.51.100.10'],
    });
    expect(includeDatabaseServerAddress(policy, '203.0.113.42')).toEqual(policy);
  });

  it('canonicalises IPv4 and IPv6 network addresses', () => {
    expect(normaliseRemoteCidr('203.0.113.7/24')).toBe('203.0.113.0/24');
    expect(normaliseRemoteCidr('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normaliseRemoteCidr('2001:db8::1234/64')).toBe('2001:db8::/64');
  });

  it('treats an IPv4-mapped address as the IPv4 address it really is', () => {
    // A panel bound to :: reports the browser as ::ffff:203.0.113.42, and a
    // firewall rule written that way never matches the source it came from.
    expect(unmapIpv4('::ffff:203.0.113.42')).toBe('203.0.113.42');
    expect(normaliseRemoteCidr('::FFFF:203.0.113.42')).toBe('203.0.113.42');
    expect(unmapIpv4('2001:db8::1')).toBe('2001:db8::1');
    expect(unmapIpv4('203.0.113.42')).toBe('203.0.113.42');
  });

  it('requires a source when whitelist mode is selected', () => {
    expect(() => normaliseDatabaseNetworkPolicy('whitelist')).toThrow(/at least one/i);
    expect(() => normaliseDatabaseNetworkPolicy('any', ['not-an-ip'])).not.toThrow();
  });

  it('rejects malformed addresses and oversized ranges', () => {
    for (const value of ['203.0.113.999', '203.0.113.0/33', '2001:db8::/129', '1.2.3.4/abc']) {
      expect(() => normaliseRemoteCidr(value), value).toThrow();
    }
  });
});