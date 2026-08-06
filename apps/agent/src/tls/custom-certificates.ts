import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { siteCertificates } from '../db/schema.js';
import { deleteSecret, readSecret, writeSecret } from '../security/secret-store.js';
import type { SecretVault } from '../security/vault.js';

/**
 * Certificates the user supplied instead of ones the panel obtained.
 *
 * Caddy gets a publicly-trusted certificate for nothing and renews it forever,
 * so this is not the path anyone should take by default. It exists because two
 * situations cannot be served by automation at all:
 *
 *  - A Cloudflare Origin certificate, which is what most people asking for
 *    this actually want. It lasts fifteen years and needs no port 80, but it
 *    is trusted *only* by Cloudflare's edge. On a domain that is not proxied
 *    it produces a browser warning on every visit, so `originOnly` is carried
 *    all the way to the screen rather than being an implementation detail.
 *  - A certificate from an employer's or a customer's own authority, which
 *    the panel has no way to ask for.
 *
 * The private key never goes in this table. It is encrypted in the vault, the
 * same as a Cloudflare token, and is written to disk only because Caddy has to
 * read a file — into the panel's data folder, which the installer strips of
 * inherited permissions and grants to SYSTEM and administrators alone.
 */

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/** Cloudflare's origin authority, whose certificates only their edge trusts. */
const ORIGIN_ONLY_ISSUER = /cloudflare origin/i;

export function siteCertificateKeyName(siteId: string): string {
  return `site.certificateKey:${siteId}`;
}

export interface CustomCertificate {
  /** Every name the certificate is valid for, wildcards included. */
  subjects: string[];
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** Trusted only behind Cloudflare's proxy, never by a browser directly. */
  originOnly: boolean;
}

export interface StoredCustomCertificate extends CustomCertificate {
  uploadedAt: Date;
  /** PEM chain, leaf first. Public material, safe to hand back. */
  certificate: string;
}

interface ParsedBundle extends CustomCertificate {
  certificate: string;
  privateKey: string;
}

function blocksOf(pem: string, label: string): string[] {
  return (pem.match(PEM_BLOCK) ?? []).filter((block) => block.startsWith(`-----BEGIN ${label}`));
}

/**
 * A readable issuer name.
 *
 * The issuer is a full distinguished name; the organisation within it is the
 * only part anyone recognises. Falls back to the common name, because a
 * private authority run inside a company often sets nothing else.
 */
function issuerNameOf(certificate: X509Certificate): string {
  const organisation = /^O=(.+)$/m.exec(certificate.issuer)?.[1]?.trim();
  const common = /^CN=(.+)$/m.exec(certificate.issuer)?.[1]?.trim();
  return organisation || common || 'Unknown';
}

/** The names on the certificate: its subject alternative names, or its CN. */
function subjectsOf(certificate: X509Certificate): string[] {
  const alternatives = (certificate.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.toUpperCase().startsWith('DNS:'))
    .map((entry) => entry.slice(4).trim().toLowerCase());

  if (alternatives.length > 0) return [...new Set(alternatives)];

  const common = /^CN=(.+)$/m.exec(certificate.subject)?.[1]?.trim().toLowerCase();
  return common ? [common] : [];
}

/**
 * Checks a pasted certificate and key before anything is stored.
 *
 * Everything here fails at upload rather than at reload. Caddy rejects a bad
 * certificate by refusing the *entire* configuration, which would take every
 * other website on the machine offline over one bad paste.
 */
export function parseCertificateBundle(certificatePem: string, privateKeyPem: string): ParsedBundle {
  const chain = blocksOf(certificatePem, 'CERTIFICATE');

  if (chain.length === 0) {
    throw new Error(
      'That does not look like a certificate. Paste the whole block, including the ' +
        '"-----BEGIN CERTIFICATE-----" and "-----END CERTIFICATE-----" lines.',
    );
  }

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(chain[0]!);
  } catch {
    throw new Error('The certificate could not be read. It may be damaged or only partly copied.');
  }

  // Anything after the first block is the chain up to the authority. It is not
  // used here, but a truncated one is worth catching now rather than as a
  // handshake failure in somebody's browser.
  for (const block of chain.slice(1)) {
    try {
      new X509Certificate(block);
    } catch {
      throw new Error(
        'The certificate itself is fine, but one of the chain certificates below it could ' +
          'not be read. Paste the full chain the authority gave you, or just the certificate.',
      );
    }
  }

  if (blocksOf(privateKeyPem, 'ENCRYPTED PRIVATE KEY').length > 0) {
    throw new Error(
      'That private key is protected by a passphrase. The web server has nowhere to type ' +
        'one, so it needs the key with the passphrase removed.',
    );
  }

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error(
      'That does not look like a private key. It is a separate block from the certificate, ' +
        'beginning "-----BEGIN PRIVATE KEY-----".',
    );
  }

  if (!leaf.checkPrivateKey(key)) {
    throw new Error(
      'The private key does not belong to this certificate. They are always issued as a ' +
        'pair \u2014 check you have not mixed up two of them.',
    );
  }

  const notBefore = leaf.validFromDate ?? new Date(leaf.validFrom);
  const notAfter = leaf.validToDate ?? new Date(leaf.validTo);

  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    throw new Error('The certificate does not say when it is valid, so it cannot be used.');
  }

  const now = Date.now();
  if (notAfter.getTime() <= now) {
    throw new Error(
      `That certificate expired on ${notAfter.toDateString()}. Browsers refuse an expired ` +
        'certificate outright, so it cannot be installed.',
    );
  }
  if (notBefore.getTime() > now) {
    throw new Error(
      `That certificate is not valid until ${notBefore.toDateString()}, so installing it now ` +
        'would take the website offline.',
    );
  }

  const subjects = subjectsOf(leaf);
  if (subjects.length === 0) {
    throw new Error('That certificate carries no domain names, so nothing could be served with it.');
  }

  return {
    certificate: `${chain.join('\n')}\n`,
    privateKey: `${blocksOf(privateKeyPem, 'PRIVATE KEY')[0] ?? privateKeyPem.trim()}\n`,
    subjects,
    issuer: issuerNameOf(leaf),
    notBefore,
    notAfter,
    originOnly: ORIGIN_ONLY_ISSUER.test(leaf.issuer),
  };
}

/** Which of a website's domains this certificate is actually valid for. */
export function coveredDomains(
  certificatePem: string,
  domains: readonly string[],
): string[] {
  const block = blocksOf(certificatePem, 'CERTIFICATE')[0];
  if (!block) return [];

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(block);
  } catch {
    return [];
  }

  return domains.filter((domain) => leaf.checkHost(domain, { subject: 'always' }) !== undefined);
}

export function storeCustomCertificate(
  db: DatabaseHandle,
  vault: SecretVault,
  siteId: string,
  bundle: ParsedBundle,
): void {
  writeSecret(db, vault, siteCertificateKeyName(siteId), bundle.privateKey);

  const row = {
    siteId,
    certificate: bundle.certificate,
    subjects: bundle.subjects,
    issuer: bundle.issuer,
    notBefore: bundle.notBefore,
    notAfter: bundle.notAfter,
    uploadedAt: new Date(),
  };

  db.db
    .insert(siteCertificates)
    .values(row)
    .onConflictDoUpdate({ target: siteCertificates.siteId, set: row })
    .run();
}

export function readCustomCertificate(
  db: DatabaseHandle,
  siteId: string,
): StoredCustomCertificate | null {
  const row = db.db
    .select()
    .from(siteCertificates)
    .where(eq(siteCertificates.siteId, siteId))
    .get();

  if (!row) return null;

  return {
    certificate: row.certificate,
    subjects: (row.subjects as string[]) ?? [],
    issuer: row.issuer,
    notBefore: row.notBefore,
    notAfter: row.notAfter,
    uploadedAt: row.uploadedAt,
    originOnly: ORIGIN_ONLY_ISSUER.test(row.issuer),
  };
}

export function clearCustomCertificate(db: DatabaseHandle, siteId: string): void {
  db.db.delete(siteCertificates).where(eq(siteCertificates.siteId, siteId)).run();
  deleteSecret(db, siteCertificateKeyName(siteId));
}

export interface CustomCertificateFiles {
  siteId: string;
  certificateFile: string;
  keyFile: string;
}

export function customCertificateFiles(dir: string, siteId: string): CustomCertificateFiles {
  return {
    siteId,
    certificateFile: path.join(dir, `${siteId}.crt`),
    keyFile: path.join(dir, `${siteId}.key`),
  };
}

/**
 * Puts every stored certificate on disk where Caddy can read it.
 *
 * Written from the database on every reload rather than once at upload, so a
 * restored backup, a hand-deleted file or a half-finished write repairs itself
 * instead of failing the next configuration load. Files belonging to a site
 * that no longer has a certificate are removed in the same pass, because a
 * private key nobody uses is still a private key sitting on the disk.
 */
export async function writeCustomCertificateFiles(
  db: DatabaseHandle,
  vault: SecretVault,
  dir: string,
): Promise<CustomCertificateFiles[]> {
  const rows = db.db.select().from(siteCertificates).all();
  const written: CustomCertificateFiles[] = [];

  if (rows.length > 0) await fs.mkdir(dir, { recursive: true });

  for (const row of rows) {
    const privateKey = readSecret(db, vault, siteCertificateKeyName(row.siteId));

    // The certificate without its key is unusable, and pointing Caddy at half
    // a pair fails the whole load. Skipping leaves the site on automation.
    if (!privateKey) continue;

    const files = customCertificateFiles(dir, row.siteId);
    await fs.writeFile(files.certificateFile, row.certificate, { mode: 0o600 });
    await fs.writeFile(files.keyFile, privateKey, { mode: 0o600 });
    written.push(files);
  }

  const keep = new Set(written.flatMap((files) => [files.certificateFile, files.keyFile]));

  let existing: string[];
  try {
    existing = await fs.readdir(dir);
  } catch {
    return written;
  }

  for (const name of existing) {
    if (!/\.(crt|key)$/.test(name)) continue;
    const full = path.join(dir, name);
    if (!keep.has(full)) await fs.rm(full, { force: true });
  }

  return written;
}
