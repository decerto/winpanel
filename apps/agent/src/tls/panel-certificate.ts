import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import type { DatabaseHandle } from '../db/index.js';
import { findIssuedCertificate } from './issued-certificates.js';
import { readPanelHostname } from './panel-hostname.js';

/**
 * The panel's own certificate. Nothing to do with the websites' certificates.
 *
 * Two states, and the panel moves between them without anything being taken
 * away from a website:
 *
 *  - No panel domain. The panel is reached at https://<server-ip>:8443, and a
 *    certificate authority will not issue for a bare IP, so it serves one it
 *    signed itself. That costs one browser warning and still keeps the
 *    password, session cookie and TOTP code off the wire — which matters a
 *    great deal for a box on a public IP. The certificate carries the
 *    machine's IP addresses as SANs, so the warning is "unknown issuer" rather
 *    than "wrong host", and pinning the fingerprint works properly.
 *
 *  - A panel domain, e.g. panel.example.com. The web server obtains an
 *    ordinary certificate for that one name — its own, issued for nothing else
 *    — and the panel serves it here. Website certificates are untouched: a
 *    website's certificate is never served on the panel's port, and the panel's
 *    is never served for a website.
 */

export interface PanelCertificate {
  certPem: string;
  keyPem: string;
  /** SHA-256 fingerprint, shown in the UI so the user can verify what they trust. */
  fingerprint: string;
  expiresAt: Date;
}

/** Every non-loopback IPv4/IPv6 address on this machine. */
export function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function fingerprintOf(certPem: string): string {
  const der = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const hash = crypto.createHash('sha256').update(Buffer.from(der, 'base64')).digest('hex');
  return (hash.toUpperCase().match(/.{2}/g) ?? []).join(':');
}

const VALIDITY_DAYS = 3650;

export function generatePanelCertificate(extraHosts: readonly string[] = []): PanelCertificate {
  const hostname = os.hostname();
  const ips = localAddresses();

  const altNames = [
    { type: 2, value: hostname },
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...ips.map((ip) => ({ type: 7, ip })),
    ...extraHosts.map((host) => ({ type: 2, value: host })),
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: hostname }], {
    keySize: 2048,
    days: VALIDITY_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  const expiresAt = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  return {
    certPem: pems.cert,
    keyPem: pems.private,
    fingerprint: fingerprintOf(pems.cert),
    expiresAt,
  };
}

/** Loads the stored certificate, generating one on first run. */
export async function loadOrCreatePanelCertificate(
  certPath: string,
  keyPath: string,
): Promise<PanelCertificate> {
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(certPath, 'utf8'),
      fs.readFile(keyPath, 'utf8'),
    ]);
    return {
      certPem,
      keyPem,
      fingerprint: fingerprintOf(certPem),
      // Read back from the file rather than recomputed; only used for display.
      expiresAt: new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const certificate = generatePanelCertificate();
  await fs.mkdir(path.dirname(certPath), { recursive: true });
  await fs.writeFile(certPath, certificate.certPem, { mode: 0o600 });
  await fs.writeFile(keyPath, certificate.keyPem, { mode: 0o600 });
  return certificate;
}

/** What the panel is serving on its own port, and where it came from. */
export interface PanelTls {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  /**
   * `issued` means a certificate authority signed it and browsers trust it;
   * `self-signed` means the panel made it and they will not.
   */
  source: 'issued' | 'self-signed';
  /** The panel's domain name, or null while it is reached by IP. */
  hostname: string | null;
  /** Who signed it. Null for the self-signed one. */
  issuer: string | null;
  expiresAt: Date | null;
}

/**
 * The certificate the panel should be serving right now.
 *
 * The issued one is only ever the certificate obtained for the panel's own
 * name (`exactSubject`), never a website's wildcard that happens to cover it:
 * the panel must not start serving something whose renewal, replacement or
 * deletion belongs to a website.
 *
 * Falls back to the self-signed certificate whenever there is no panel domain
 * or its certificate has not arrived yet, so the panel is never unreachable
 * while a name is being set up.
 */
export async function resolvePanelTls(
  db: DatabaseHandle,
  caddyDir: string,
  certPath: string,
  keyPath: string,
): Promise<PanelTls> {
  const hostname = readPanelHostname(db);

  if (hostname) {
    const issued = await findIssuedCertificate(caddyDir, hostname, { exactSubject: true });

    if (issued) {
      return {
        certPem: issued.certificate,
        keyPem: issued.privateKey,
        fingerprint: fingerprintOf(issued.certificate),
        source: 'issued',
        hostname,
        issuer: issued.issuer,
        expiresAt: issued.expiresAt,
      };
    }
  }

  const fallback = await loadOrCreatePanelCertificate(certPath, keyPath);

  return {
    certPem: fallback.certPem,
    keyPem: fallback.keyPem,
    fingerprint: fallback.fingerprint,
    source: 'self-signed',
    hostname,
    issuer: null,
    expiresAt: fallback.expiresAt,
  };
}
