import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIssuedCertificate, waitForIssuedCertificate } from '../src/mail/certificate.js';
import { caddyDataDir } from '../src/tls/site-certificates.js';

/**
 * The mail server serves a certificate it made for itself until it is handed a
 * better one. Webmail never notices, because it reaches the mail server over
 * loopback and validates nothing; Outlook refuses the account outright. So the
 * panel copies across the certificate the web server already holds — and this
 * is about finding the right one to copy.
 */

let caddyDir: string;

beforeEach(async () => {
  caddyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-mail-cert-'));
});

afterEach(async () => {
  await fs.rm(caddyDir, { recursive: true, force: true });
});

async function storeCertificate(options: {
  issuerDir: string;
  subject: string;
  altNames: readonly string[];
  days: number;
  withKey?: boolean;
}): Promise<void> {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: options.altNames[0] ?? options.subject }],
    {
      keySize: 2048,
      days: options.days,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: options.altNames.map((value) => ({ type: 2, value })),
        },
      ],
    },
  );

  const dir = path.join(caddyDataDir(caddyDir), 'certificates', options.issuerDir, options.subject);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${options.subject}.crt`), pems.cert);

  if (options.withKey !== false) {
    await fs.writeFile(path.join(dir, `${options.subject}.key`), pems.private);
  }
}

const ACME = 'acme-v02.api.letsencrypt.org-directory';

describe('the certificate to give the mail server', () => {
  it('is nothing at all when the web server has issued none', async () => {
    expect(await findIssuedCertificate(caddyDir, 'mail.example.com')).toBeNull();
  });

  it('finds the one covering the mail hostname, with its key', async () => {
    await storeCertificate({
      issuerDir: ACME,
      subject: 'mail.example.com',
      altNames: ['mail.example.com'],
      days: 90,
    });

    const found = await findIssuedCertificate(caddyDir, 'mail.example.com');

    expect(found?.certificate).toContain('BEGIN CERTIFICATE');
    expect(found?.privateKey).toContain('PRIVATE KEY');
    expect(found?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /*
   * Caddy's own authority is no more trusted by Outlook than the certificate
   * the mail server already made for itself, so installing it would replace a
   * useless certificate with a different useless one and report success.
   */
  it('ignores the web server\u2019s internal authority', async () => {
    await storeCertificate({
      issuerDir: 'local',
      subject: 'mail.example.com',
      altNames: ['mail.example.com'],
      days: 90,
    });

    expect(await findIssuedCertificate(caddyDir, 'mail.example.com')).toBeNull();
  });

  it('ignores a certificate issued for another name', async () => {
    await storeCertificate({
      issuerDir: ACME,
      subject: 'example.com',
      altNames: ['example.com', 'www.example.com'],
      days: 90,
    });

    expect(await findIssuedCertificate(caddyDir, 'mail.example.com')).toBeNull();
  });

  // A renewal leaves the previous certificate on disk until Caddy tidies it.
  it('prefers the newest of several that match', async () => {
    await storeCertificate({
      issuerDir: ACME,
      subject: 'old',
      altNames: ['mail.example.com'],
      days: 10,
    });
    await storeCertificate({
      issuerDir: ACME,
      subject: 'new',
      altNames: ['mail.example.com'],
      days: 90,
    });

    expect((await findIssuedCertificate(caddyDir, 'mail.example.com'))?.subject).toBe('new');
  });

  // Half-written pairs appear during a renewal, and are not a fault.
  it('skips a certificate whose key has not been written yet', async () => {
    await storeCertificate({
      issuerDir: ACME,
      subject: 'mail.example.com',
      altNames: ['mail.example.com'],
      days: 90,
      withKey: false,
    });

    expect(await findIssuedCertificate(caddyDir, 'mail.example.com')).toBeNull();
  });

  it('accepts a wildcard that covers the mail hostname', async () => {
    await storeCertificate({
      issuerDir: ACME,
      subject: 'wildcard_.example.com',
      altNames: ['*.example.com'],
      days: 90,
    });

    expect(await findIssuedCertificate(caddyDir, 'mail.example.com')).not.toBeNull();
  });
});

describe('waiting for one to be issued', () => {
  it('picks it up once the web server has written it', async () => {
    setTimeout(() => {
      void storeCertificate({
        issuerDir: ACME,
        subject: 'mail.example.com',
        altNames: ['mail.example.com'],
        days: 90,
      });
    }, 60);

    const issued = await waitForIssuedCertificate(caddyDir, 'mail.example.com', 5_000, 50);
    expect(issued?.subject).toBe('mail.example.com');
  });

  it('gives up rather than hanging when none arrives', async () => {
    expect(await waitForIssuedCertificate(caddyDir, 'mail.example.com', 120, 50)).toBeNull();
  });
});
