import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { caddyDataDir } from '../tls/site-certificates.js';

/**
 * Giving the mail server the same certificate the web server already has.
 *
 * Stalwart generates its own self-signed certificate on first start and serves
 * it on 993, 995 and 465. That is fine for the panel's webmail, which reaches
 * the mail server over loopback and validates nothing, and fatal for every
 * real mail client: Outlook, Apple Mail and the phone clients all refuse to
 * sign in rather than offering to continue. The symptom is exactly the one
 * people report — webmail works, Outlook says "something went wrong".
 *
 * Caddy already holds a publicly-trusted certificate for `mail.<domain>`,
 * because the reconciler adds that name to the site's DNS challenge. So there
 * is nothing to obtain here: the certificate exists on disk and only has to be
 * copied into the mail server's own store.
 */

export interface IssuedCertificate {
  /** The folder Caddy filed it under, which is the name it was issued for. */
  subject: string;
  /** PEM chain, leaf first. */
  certificate: string;
  privateKey: string;
  issuer: string;
  expiresAt: Date;
}

/**
 * Caddy's own certificate authority, used for internal names.
 *
 * Skipped: a certificate from it is no more trusted by Outlook than the one
 * the mail server made for itself, so installing it would replace a useless
 * certificate with a different useless certificate and report success.
 */
const UNTRUSTED_ISSUER = /^local$/i;

function issuerNameOf(certificate: X509Certificate): string {
  const match = /^O=(.+)$/m.exec(certificate.issuer);
  return match?.[1]?.trim() ?? certificate.issuer.split('\n')[0] ?? 'Unknown';
}

/**
 * The publicly-trusted certificate the web server holds for a hostname.
 *
 * Null when there is none, which is the ordinary state while DNS is still
 * propagating rather than a fault. The newest match wins, because a renewal
 * leaves the previous certificate on disk until Caddy cleans it up.
 */
export async function findIssuedCertificate(
  caddyDir: string,
  hostname: string,
): Promise<IssuedCertificate | null> {
  const root = path.join(caddyDataDir(caddyDir), 'certificates');

  let issuers: string[];
  try {
    issuers = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !UNTRUSTED_ISSUER.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const found: IssuedCertificate[] = [];

  for (const issuer of issuers) {
    let subjects: string[];
    try {
      subjects = (await fs.readdir(path.join(root, issuer), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const subject of subjects) {
      const folder = path.join(root, issuer, subject);

      try {
        const [certificate, privateKey] = await Promise.all([
          fs.readFile(path.join(folder, `${subject}.crt`), 'utf8'),
          fs.readFile(path.join(folder, `${subject}.key`), 'utf8'),
        ]);

        const parsed = new X509Certificate(certificate);
        if (!parsed.checkHost(hostname, { subject: 'always' })) continue;

        const expiresAt = parsed.validToDate ?? new Date(parsed.validTo);
        if (Number.isNaN(expiresAt.getTime())) continue;

        found.push({
          subject,
          certificate,
          privateKey,
          issuer: issuerNameOf(parsed),
          expiresAt,
        });
      } catch {
        // A half-written or unreadable pair is skipped, not fatal: the next
        // renewal writes it again.
        continue;
      }
    }
  }

  return (
    found.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0] ?? null
  );
}

/**
 * The same, but gives an issue that is already under way time to finish.
 *
 * Caddy obtains certificates in the background after a config load, so a fix
 * button that looked once would report failure on a server that was seconds
 * away from succeeding. Polling the folder is how the result arrives: there is
 * no admin endpoint that reports the state of an individual certificate.
 */
export async function waitForIssuedCertificate(
  caddyDir: string,
  hostname: string,
  timeoutMs = 60_000,
  intervalMs = 2_000,
): Promise<IssuedCertificate | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const issued = await findIssuedCertificate(caddyDir, hostname);
    if (issued) return issued;
    if (Date.now() + intervalMs >= deadline) return null;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
