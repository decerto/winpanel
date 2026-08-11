import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { caddyDataDir } from './site-certificates.js';

/**
 * Reading a certificate the web server already obtained.
 *
 * Caddy is the only thing on the machine that talks to a certificate
 * authority, and everything else that needs a publicly-trusted certificate —
 * the mail server on 993/995/465, the panel on its own port — takes a copy of
 * one Caddy already holds. There is nothing to obtain here: the file exists on
 * disk under Caddy's storage and only has to be found.
 *
 * For the mail server this is the difference between Outlook signing in and
 * Outlook saying "something went wrong": Stalwart generates its own
 * self-signed certificate on first start, which webmail (loopback, validates
 * nothing) is happy with and no real mail client will accept.
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
 * Skipped: a certificate from it is no more trusted by a browser or by Outlook
 * than a self-signed one, so installing it would replace a useless certificate
 * with a different useless certificate and report success.
 */
const UNTRUSTED_ISSUER = /^local$/i;

function issuerNameOf(certificate: X509Certificate): string {
  const match = /^O=(.+)$/m.exec(certificate.issuer);
  return match?.[1]?.trim() ?? certificate.issuer.split('\n')[0] ?? 'Unknown';
}

export interface FindIssuedOptions {
  /**
   * Only accept the certificate obtained for this exact name.
   *
   * The panel wants this. Its certificate is its own: a wildcard a website
   * holds may well cover `panel.example.com`, but serving a website's
   * certificate on the panel's port ties the two together, so that renewing,
   * replacing or deleting the website silently changes what the panel serves.
   * Off by default, because the mail server genuinely does want whatever
   * covers `mail.<domain>`.
   */
  exactSubject?: boolean;
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
  options: FindIssuedOptions = {},
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
      if (options.exactSubject && subject !== hostname) continue;

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

  return found.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0] ?? null;
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
  options: FindIssuedOptions = {},
): Promise<IssuedCertificate | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const issued = await findIssuedCertificate(caddyDir, hostname, options);
    if (issued) return issued;
    if (Date.now() + intervalMs >= deadline) return null;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
