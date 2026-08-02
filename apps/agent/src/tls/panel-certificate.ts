import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';

/**
 * The panel's own certificate.
 *
 * The panel is reached at https://<server-ip>:8443 with no domain name, so a
 * publicly-trusted certificate is not on the table without extra machinery.
 * A self-signed certificate costs the user nothing beyond clicking through one
 * browser warning, and it keeps the password, session cookie and TOTP code off
 * the wire in plaintext — which matters a great deal for a box on a public IP.
 *
 * The certificate carries the machine's IP addresses as SANs, so the warning
 * is purely "unknown issuer" rather than "wrong host", and pinning the
 * fingerprint in the browser works properly.
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
