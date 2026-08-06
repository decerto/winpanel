import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import {
  clearCustomCertificate,
  coveredDomains,
  customCertificateFiles,
  parseCertificateBundle,
  readCustomCertificate,
  storeCustomCertificate,
  writeCustomCertificateFiles,
} from '../src/tls/custom-certificates.js';

/**
 * Certificates somebody pasted in themselves.
 *
 * Every check here happens before anything is stored, and that is the whole
 * point of the file: Caddy answers one unusable certificate by rejecting the
 * entire configuration, so a single bad paste on one website would take every
 * other website on the machine offline.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let db: DatabaseHandle;
let vault: SecretVault;

interface Pem {
  cert: string;
  private: string;
}

function issue(
  domains: readonly string[],
  options: { days?: number; commonName?: string } = {},
): Pem {
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: options.commonName ?? domains[0] ?? 'example.com' }],
    {
      keySize: 2048,
      days: options.days ?? 90,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: domains.map((value) => ({ type: 2, value })),
        },
      ],
    },
  );
  return { cert: pems.cert, private: pems.private };
}

function insertSite(id: string): void {
  db.db
    .insert(sites)
    .values({
      id,
      slug: `site-${id.slice(0, 6)}`,
      displayName: 'Example',
      runtime: 'node',
      domains: ['example.com'],
      source: { kind: 'git', url: 'https://example.com/x.git', branch: 'main', subdirectory: '' },
      manifest: { schemaVersion: 1, runtime: 'node' },
      portBlue: 3001,
      portGreen: 3002,
      previewPort: 7001,
    })
    .run();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-custom-cert-'));
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);

  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  vault.lock();
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('checking a pasted certificate', () => {
  it('accepts a certificate with its own key, and reads the names off it', () => {
    const pem = issue(['example.com', 'www.example.com']);
    const bundle = parseCertificateBundle(pem.cert, pem.private);

    expect(bundle.subjects).toEqual(['example.com', 'www.example.com']);
    expect(bundle.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(bundle.originOnly).toBe(false);
  });

  it('refuses a key belonging to a different certificate', () => {
    /*
     * The likeliest mistake of the lot: two certificates downloaded in the
     * same session, and the wrong half of one pasted. Caddy's own message for
     * it is "tls: private key does not match public key", buried in a log.
     */
    const mine = issue(['example.com']);
    const other = issue(['example.com']);

    expect(() => parseCertificateBundle(mine.cert, other.private)).toThrow(/does not belong/i);
  });

  it('refuses a certificate that has already expired', () => {
    const pem = issue(['example.com'], { days: 1 });

    // Generated first, then the clock moved past its end date: an expired
    // certificate cannot be issued on demand, and this is what one becomes.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
      expect(() => parseCertificateBundle(pem.cert, pem.private)).toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a certificate that is not valid yet', () => {
    // Installing one early takes the website offline until it starts, which
    // is a worse outcome than the upload being refused. Same trick as above,
    // with the clock moved back instead of forward.
    const pem = issue(['example.com']);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
      expect(() => parseCertificateBundle(pem.cert, pem.private)).toThrow(/not valid until/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a key that needs a passphrase', () => {
    // The web server starts unattended, so there is nowhere to type one.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'secret',
      },
    });

    const pem = issue(['example.com']);
    expect(() => parseCertificateBundle(pem.cert, privateKey)).toThrow(/passphrase/i);
  });

  it('refuses something that is not a certificate at all', () => {
    const pem = issue(['example.com']);
    expect(() => parseCertificateBundle('hello', pem.private)).toThrow(/does not look like/i);
  });

  it('refuses a certificate whose chain is damaged', () => {
    const pem = issue(['example.com']);
    const damaged = `${pem.cert}\n-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n`;

    expect(() => parseCertificateBundle(damaged, pem.private)).toThrow(/chain/i);
  });

  it('flags a Cloudflare origin certificate, which browsers do not trust', () => {
    /*
     * These are what most people asking for this feature have in hand. They
     * work only behind Cloudflare's proxy, so the page has to be able to say
     * so — grey-clouding the record afterwards gives every visitor a full-page
     * browser warning.
     */
    const pem = issue(['example.com'], {
      commonName: 'CloudFlare Origin Certificate',
    });

    expect(parseCertificateBundle(pem.cert, pem.private).originOnly).toBe(true);
  });
});

describe('matching a certificate to a website', () => {
  it('reports only the domains the certificate is valid for', () => {
    const pem = issue(['example.com']);

    expect(coveredDomains(pem.cert, ['example.com', 'other.com'])).toEqual(['example.com']);
  });

  it('counts a wildcard as covering a subdomain', () => {
    const pem = issue(['*.example.com']);

    expect(coveredDomains(pem.cert, ['shop.example.com'])).toEqual(['shop.example.com']);
    // One label only: a wildcard does not stretch across a dot.
    expect(coveredDomains(pem.cert, ['a.b.example.com'])).toEqual([]);
  });

  it('reports nothing rather than throwing when handed rubbish', () => {
    expect(coveredDomains('not a certificate', ['example.com'])).toEqual([]);
  });
});

describe('storing a certificate', () => {
  it('keeps the private key out of the table it stores the certificate in', () => {
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));

    const stored = readCustomCertificate(db, siteId);
    expect(stored?.certificate).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(stored)).not.toContain('PRIVATE KEY');
  });

  it('replaces the previous certificate rather than adding a second', () => {
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const first = issue(['example.com']);
    const second = issue(['example.com', 'www.example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(first.cert, first.private));
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(second.cert, second.private));

    expect(readCustomCertificate(db, siteId)?.subjects).toEqual([
      'example.com',
      'www.example.com',
    ]);
  });

  it('forgets the key as well as the certificate when it is removed', async () => {
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));
    clearCustomCertificate(db, siteId);

    expect(readCustomCertificate(db, siteId)).toBeNull();

    const dir = path.join(tmpDir, 'certificates');
    expect(await writeCustomCertificateFiles(db, vault, dir)).toEqual([]);
  });
});

describe('putting certificates where Caddy can read them', () => {
  it('writes the pair of files for each website', async () => {
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));

    const dir = path.join(tmpDir, 'certificates');
    const written = await writeCustomCertificateFiles(db, vault, dir);

    expect(written).toHaveLength(1);
    expect(await fs.readFile(written[0]!.certificateFile, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(await fs.readFile(written[0]!.keyFile, 'utf8')).toContain('PRIVATE KEY');
  });

  it('rewrites a file somebody deleted, instead of failing the reload', async () => {
    /*
     * Written from the database on every reload rather than once at upload.
     * A restored backup or a half-finished write would otherwise leave Caddy
     * pointed at a file that is not there, and it refuses the whole
     * configuration when a certificate is missing.
     */
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));

    const dir = path.join(tmpDir, 'certificates');
    await writeCustomCertificateFiles(db, vault, dir);
    await fs.rm(customCertificateFiles(dir, siteId).keyFile);
    await writeCustomCertificateFiles(db, vault, dir);

    expect(await fs.readFile(customCertificateFiles(dir, siteId).keyFile, 'utf8')).toContain(
      'PRIVATE KEY',
    );
  });

  it('deletes the key of a website that no longer has a certificate', async () => {
    // A private key nobody uses is still a private key sitting on the disk.
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));

    const dir = path.join(tmpDir, 'certificates');
    await writeCustomCertificateFiles(db, vault, dir);
    clearCustomCertificate(db, siteId);
    await writeCustomCertificateFiles(db, vault, dir);

    await expect(fs.access(customCertificateFiles(dir, siteId).keyFile)).rejects.toThrow();
    await expect(fs.access(customCertificateFiles(dir, siteId).certificateFile)).rejects.toThrow();
  });

  it('leaves a website alone when its key has gone missing from the vault', async () => {
    /*
     * Half a pair fails the entire configuration load. Skipping the row leaves
     * that one website on automatic certificates and every other website up.
     */
    const siteId = crypto.randomUUID();
    insertSite(siteId);

    const pem = issue(['example.com']);
    storeCustomCertificate(db, vault, siteId, parseCertificateBundle(pem.cert, pem.private));
    db.sqlite.prepare('DELETE FROM secrets').run();

    const dir = path.join(tmpDir, 'certificates');
    expect(await writeCustomCertificateFiles(db, vault, dir)).toEqual([]);
  });
});
