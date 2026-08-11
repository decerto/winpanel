import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { resolvePanelTls } from '../src/tls/panel-certificate.js';
import {
  PanelHostnameError,
  normalisePanelHostname,
  panelHostnameAmong,
  readPanelHostname,
  storePanelHostname,
} from '../src/tls/panel-hostname.js';

/**
 * Giving the panel a certificate of its own.
 *
 * The rule this file exists to hold: the panel's certificate is the panel's.
 * A website's certificate is never served on the panel's port, however well it
 * covers the name, because a website's certificate is renewed, replaced and
 * deleted by whoever owns that website — and the address every administrator
 * signs in at must not change when they do.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let caddyDir: string;
let db: DatabaseHandle;

/** Writes a certificate where Caddy would have filed it. */
async function fileCertificate(
  issuer: string,
  subject: string,
  altNames: readonly string[],
): Promise<void> {
  const pems = selfsigned.generate([{ name: 'commonName', value: subject }], {
    keySize: 2048,
    days: 90,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: altNames.map((value) => ({ type: 2, value })) },
    ],
  });

  const folder = path.join(caddyDir, 'caddy', 'certificates', issuer, subject);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `${subject}.crt`), pems.cert);
  await fs.writeFile(path.join(folder, `${subject}.key`), pems.private);
}

function resolve(): Promise<Awaited<ReturnType<typeof resolvePanelTls>>> {
  return resolvePanelTls(
    db,
    caddyDir,
    path.join(tmpDir, 'panel-cert.pem'),
    path.join(tmpDir, 'panel-key.pem'),
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-panel-domain-'));
  caddyDir = path.join(tmpDir, 'caddy-root');
  db = createDatabase(path.join(tmpDir, 'panel.db'));
  migrateDatabase(db, MIGRATIONS);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the name the panel is given', () => {
  it('accepts an ordinary subdomain and lower-cases it', () => {
    expect(normalisePanelHostname('  Panel.Example.COM. ')).toBe('panel.example.com');
  });

  it('accepts a root domain, for anyone who would rather use one', () => {
    // Nothing about the panel needs a subdomain. A root domain not being
    // hosted as a website is a perfectly reasonable thing to point at it.
    expect(normalisePanelHostname('example.com')).toBe('example.com');
    expect(normalisePanelHostname('example.co.uk')).toBe('example.co.uk');
  });

  it('refuses an IP address, which is the problem it exists to solve', () => {
    // Accepting one would take the panel off its self-signed certificate and
    // give it nothing: no authority will issue for an address.
    expect(() => normalisePanelHostname('57.129.70.162')).toThrow(PanelHostnameError);
  });

  it('refuses a single label and a wildcard', () => {
    expect(() => normalisePanelHostname('winserver')).toThrow(PanelHostnameError);
    expect(() => normalisePanelHostname('*.example.com')).toThrow(PanelHostnameError);
  });

  it('stores and clears', () => {
    expect(readPanelHostname(db)).toBeNull();

    expect(storePanelHostname(db, 'panel.example.com')).toBe(true);
    expect(readPanelHostname(db)).toBe('panel.example.com');

    // Reported as unchanged so the caller does not reload the web server for
    // nothing.
    expect(storePanelHostname(db, 'panel.example.com')).toBe(false);

    expect(storePanelHostname(db, null)).toBe(true);
    expect(readPanelHostname(db)).toBeNull();
  });

  it('spots a website trying to take the panel\u2019s address', () => {
    storePanelHostname(db, 'example.com');

    // The reason this matters more now: a root domain is a name somebody may
    // well later want to put a website on, and the panel losing the address
    // everyone signs in at is not an acceptable way to find that out.
    expect(panelHostnameAmong(db, ['www.example.com'])).toBeNull();
    expect(panelHostnameAmong(db, ['other.com', 'Example.com'])).toBe('example.com');
  });

  it('has nothing to clash with while the panel is reached by IP', () => {
    expect(panelHostnameAmong(db, ['example.com'])).toBeNull();
  });
});

describe('which certificate the panel serves', () => {
  it('signs its own while it is reached by IP address', async () => {
    const tls = await resolve();

    expect(tls.source).toBe('self-signed');
    expect(tls.hostname).toBeNull();
    expect(tls.certPem).toContain('BEGIN CERTIFICATE');
  });

  it('keeps signing its own until the certificate for its name arrives', async () => {
    storePanelHostname(db, 'panel.example.com');

    // The gap between naming the panel and the certificate being issued is
    // ordinary. The panel must stay reachable throughout it.
    const tls = await resolve();
    expect(tls.source).toBe('self-signed');
    expect(tls.hostname).toBe('panel.example.com');
  });

  it('serves the certificate obtained for its own name', async () => {
    storePanelHostname(db, 'panel.example.com');
    await fileCertificate("Let's Encrypt", 'panel.example.com', ['panel.example.com']);

    const tls = await resolve();

    expect(tls.source).toBe('issued');
    expect(tls.hostname).toBe('panel.example.com');
    expect(tls.expiresAt).toBeInstanceOf(Date);
  });

  it('never borrows a website\u2019s certificate, even one that covers the name', async () => {
    storePanelHostname(db, 'panel.example.com');

    // A wildcard a website holds. It would validate perfectly — and tie the
    // panel's address to a website's certificate, so that renewing or deleting
    // the website silently changes what the panel serves.
    await fileCertificate("Let's Encrypt", 'wildcard_.example.com', ['*.example.com']);

    const tls = await resolve();
    expect(tls.source).toBe('self-signed');
  });

  it('ignores the web server\u2019s internal authority', async () => {
    storePanelHostname(db, 'panel.example.com');
    // Caddy's own CA. No browser trusts it, so serving it would replace one
    // warning with an identical one and report success.
    await fileCertificate('local', 'panel.example.com', ['panel.example.com']);

    const tls = await resolve();
    expect(tls.source).toBe('self-signed');
  });
});
