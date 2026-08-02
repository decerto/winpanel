import { describe, expect, it } from 'vitest';
import { validateDnsRecord } from '../src/dns.js';

/**
 * Proxying the wrong record breaks mail or certificate renewal silently, and
 * the resulting symptoms point nowhere near DNS. So these are hard rejections,
 * not warnings.
 */
describe('validateDnsRecord', () => {
  it('allows any record that is not proxied', () => {
    expect(validateDnsRecord({ type: 'MX', name: 'example.com', proxied: false }).ok).toBe(true);
    expect(
      validateDnsRecord({ type: 'A', name: 'mail.example.com', proxied: false }).ok,
    ).toBe(true);
  });

  it('allows proxying an ordinary website record', () => {
    expect(validateDnsRecord({ type: 'A', name: 'example.com', proxied: true }).ok).toBe(true);
    expect(
      validateDnsRecord({ type: 'CNAME', name: 'www.example.com', proxied: true }).ok,
    ).toBe(true);
  });

  it('rejects proxying record types Cloudflare cannot proxy', () => {
    for (const type of ['MX', 'TXT', 'SRV', 'CAA', 'NS'] as const) {
      const result = validateDnsRecord({ type, name: 'example.com', proxied: true });
      expect(result.ok, type).toBe(false);
    }
  });

  it('rejects proxying mail hostnames', () => {
    for (const name of [
      'mail.example.com',
      'smtp.example.com',
      'imap.example.com',
      'autodiscover.example.com',
      'autoconfig.example.com',
      'mta-sts.example.com',
    ]) {
      const result = validateDnsRecord({ type: 'A', name, proxied: true });
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason).toContain('Route traffic through Cloudflare');
    }
  });

  it('rejects proxying the ACME challenge record', () => {
    const result = validateDnsRecord({
      type: 'A',
      name: '_acme-challenge.example.com',
      proxied: true,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects proxying an A record that an MX points at', () => {
    // The hostname carries no mail-ish prefix, so only the MX target list
    // reveals that proxying it would break delivery.
    const result = validateDnsRecord(
      { type: 'A', name: 'edge01.example.com', proxied: true },
      ['edge01.example.com'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('email is delivered');
  });

  it('is case-insensitive about hostnames', () => {
    expect(validateDnsRecord({ type: 'A', name: 'MAIL.example.com', proxied: true }).ok).toBe(
      false,
    );
  });

  it('explains the fix in plain English without jargon', () => {
    const result = validateDnsRecord({ type: 'A', name: 'mail.example.com', proxied: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toMatch(/orange cloud|proxied|DNS-01/i);
    }
  });
});
