import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { generatePanelCertificate, localAddresses } from '../src/tls/panel-certificate.js';

describe('panel certificate', () => {
  it('generates a usable certificate and matching key', () => {
    const cert = generatePanelCertificate();
    expect(cert.certPem).toContain('BEGIN CERTIFICATE');
    expect(cert.keyPem).toContain('PRIVATE KEY');

    // The key must actually correspond to the certificate, otherwise TLS
    // fails at handshake time with an error nobody enjoys debugging.
    const x509 = new X509Certificate(cert.certPem);
    const privateKey = crypto.createPrivateKey(cert.keyPem);
    expect(x509.checkPrivateKey(privateKey)).toBe(true);
  });

  it('includes loopback and the machine\u2019s real IPs as SANs', () => {
    // Without IP SANs the browser reports a hostname mismatch rather than a
    // plain "unknown issuer", which is a far more alarming warning.
    const cert = generatePanelCertificate();
    const x509 = new X509Certificate(cert.certPem);
    const san = x509.subjectAltName ?? '';

    expect(san).toContain('127.0.0.1');
    expect(san).toContain('localhost');

    for (const ip of localAddresses()) {
      if (ip.includes(':')) continue; // IPv6 formatting varies by platform
      expect(san, `missing SAN for ${ip}`).toContain(ip);
    }
  });

  it('accepts extra hostnames for later use', () => {
    const cert = generatePanelCertificate(['panel.example.com']);
    const x509 = new X509Certificate(cert.certPem);
    expect(x509.subjectAltName).toContain('panel.example.com');
  });

  it('is valid now and for a long time', () => {
    const cert = generatePanelCertificate();
    const x509 = new X509Certificate(cert.certPem);

    const notBefore = new Date(x509.validFrom).getTime();
    const notAfter = new Date(x509.validTo).getTime();
    const now = Date.now();

    expect(notBefore).toBeLessThanOrEqual(now + 60_000);
    expect(notAfter).toBeGreaterThan(now);
    // Long-lived on purpose: this certificate is trusted manually once, and a
    // renewal treadmill would just create a way to lock yourself out.
    expect(notAfter - now).toBeGreaterThan(3000 * 24 * 60 * 60 * 1000);
  });

  it('exposes a fingerprint the user can compare', () => {
    const cert = generatePanelCertificate();
    expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const x509 = new X509Certificate(cert.certPem);
    expect(cert.fingerprint).toBe(x509.fingerprint256);
  });

  it('generates a different certificate each time', () => {
    const a = generatePanelCertificate();
    const b = generatePanelCertificate();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
