import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient } from '../src/dns/cloudflare.js';
import { caddyDataDir, certificatesForDomains } from '../src/tls/site-certificates.js';

/**
 * The SSL tab answers two questions: what certificate this server holds, and
 * what Cloudflare does in front of it. Both are exercised without touching a
 * real certificate authority or anybody's live zone.
 */

let caddyDir: string;

beforeEach(async () => {
  caddyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-ssl-'));
});

afterEach(async () => {
  await fs.rm(caddyDir, { recursive: true, force: true });
});

/** Writes a certificate where Caddy would have stored it. */
async function storeCertificate(
  subject: string,
  altNames: readonly string[],
  days: number,
): Promise<void> {
  const pems = selfsigned.generate([{ name: 'commonName', value: altNames[0] ?? subject }], {
    keySize: 2048,
    days,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: altNames.map((value) => ({ type: 2, value })),
      },
    ],
  });

  const dir = path.join(
    caddyDataDir(caddyDir),
    'certificates',
    'acme-v02.api.letsencrypt.org-directory',
    subject,
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${subject}.crt`), pems.cert);
}

describe('certificates on disk', () => {
  it('reports a domain with no storage at all as absent rather than failing', async () => {
    const [entry] = await certificatesForDomains(caddyDir, ['example.com']);
    expect(entry).toMatchObject({ domain: 'example.com', state: 'absent', issuer: null });
  });

  it('finds the certificate covering a domain', async () => {
    await storeCertificate('example.com', ['example.com', 'www.example.com'], 90);

    const found = await certificatesForDomains(caddyDir, ['example.com', 'www.example.com']);
    expect(found.map((entry) => entry.state)).toEqual(['valid', 'valid']);
    expect(found[0]?.daysRemaining).toBeGreaterThan(60);
  });

  it('counts a wildcard as covering its subdomains, and says so', async () => {
    await storeCertificate('wildcard_.example.com', ['*.example.com'], 90);

    const [entry] = await certificatesForDomains(caddyDir, ['shop.example.com']);
    expect(entry?.state).toBe('valid');
    expect(entry?.wildcard).toBe(true);
  });

  it('does not claim an unrelated certificate covers a domain', async () => {
    await storeCertificate('other.test', ['other.test'], 90);

    const [entry] = await certificatesForDomains(caddyDir, ['example.com']);
    expect(entry?.state).toBe('absent');
  });

  it('separates renewing-soon from expired, because they need different actions', async () => {
    await storeCertificate('soon.test', ['soon.test'], 90);
    await storeCertificate('gone.test', ['gone.test'], 90);

    const soon = new Date(Date.now() + 83 * 86_400_000);
    const later = new Date(Date.now() + 200 * 86_400_000);

    expect((await certificatesForDomains(caddyDir, ['soon.test'], soon))[0]?.state).toBe(
      'expiring',
    );
    expect((await certificatesForDomains(caddyDir, ['gone.test'], later))[0]?.state).toBe(
      'expired',
    );
  });

  it('ignores a file it cannot parse instead of taking the page down', async () => {
    const dir = path.join(caddyDataDir(caddyDir), 'certificates', 'issuer', 'broken.test');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'broken.test.crt'), 'not a certificate');

    const [entry] = await certificatesForDomains(caddyDir, ['broken.test']);
    expect(entry?.state).toBe('absent');
  });
});

interface StubRoute {
  status?: number;
  success?: boolean;
  result?: unknown;
  errors?: Array<{ code: number; message: string }>;
}

function stubFetch(routes: Record<string, StubRoute>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const requestPath = String(url).replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: requestPath,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    const route = routes[`${method} ${requestPath}`] ?? routes[requestPath];
    if (!route) {
      return new Response(JSON.stringify({ success: false, errors: [], result: null }), {
        status: 404,
      });
    }

    return new Response(
      JSON.stringify({
        success: route.success ?? true,
        errors: route.errors ?? [],
        result: route.result ?? null,
      }),
      { status: route.status ?? 200 },
    );
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

describe('Cloudflare SSL settings', () => {
  const SETTINGS = [
    { id: 'ssl', value: 'flexible', editable: true },
    { id: 'ssl_automatic_mode', value: 'auto', editable: true },
    { id: 'always_use_https', value: 'off', editable: true },
    { id: 'automatic_https_rewrites', value: 'on', editable: true },
    { id: 'min_tls_version', value: '1.2', editable: true },
    { id: 'tls_1_3', value: 'zrt', editable: true },
  ];

  it('reads the whole SSL panel in one request', async () => {
    const { impl, calls } = stubFetch({ '/zones/zone1/settings': { result: SETTINGS } });

    const settings = await new CloudflareClient('token', impl).getSslSettings('zone1');

    expect(settings).toEqual({
      readable: true,
      editable: true,
      sslMode: 'flexible',
      sslAutomaticMode: 'auto',
      alwaysUseHttps: false,
      automaticHttpsRewrites: true,
      minTlsVersion: '1.2',
      // Cloudflare's `zrt` is TLS 1.3 with zero round-trip resumption on top.
      tls13: true,
    });
    expect(calls).toHaveLength(1);
  });

  it('asks for the automatic mode separately when the settings list omits it', async () => {
    const { impl, calls } = stubFetch({
      '/zones/zone1/settings': {
        result: SETTINGS.filter((entry) => entry.id !== 'ssl_automatic_mode'),
      },
      '/zones/zone1/settings/ssl_automatic_mode': { result: { value: 'custom' } },
    });

    const settings = await new CloudflareClient('token', impl).getSslSettings('zone1');

    expect(settings.sslAutomaticMode).toBe('custom');
    expect(calls).toHaveLength(2);
  });

  it('reports no automatic mode for a zone Cloudflare has not given it', async () => {
    // The zone simply has no such setting, which is not an error: the panel
    // offers the four manual modes and nothing else.
    const { impl } = stubFetch({
      '/zones/zone1/settings': {
        result: SETTINGS.filter((entry) => entry.id !== 'ssl_automatic_mode'),
      },
    });

    const settings = await new CloudflareClient('token', impl).getSslSettings('zone1');
    expect(settings.sslAutomaticMode).toBeNull();
  });

  it('reports a token without permission as unreadable, not as an error', async () => {
    // A token made for DNS alone still manages DNS. Failing the whole page
    // would hide the certificate status, which is the half more likely to be
    // broken.
    const { impl } = stubFetch({
      '/zones/zone1/settings': {
        status: 403,
        success: false,
        errors: [{ code: 9109, message: 'no' }],
      },
    });

    const settings = await new CloudflareClient('token', impl).getSslSettings('zone1');
    expect(settings.readable).toBe(false);
  });

  it('marks settings the plan will not allow as uneditable', async () => {
    const { impl } = stubFetch({
      '/zones/zone1/settings': {
        result: [{ id: 'ssl', value: 'full', editable: false }],
      },
    });

    const settings = await new CloudflareClient('token', impl).getSslSettings('zone1');
    expect(settings).toMatchObject({ readable: true, editable: false, sslMode: 'full' });
  });

  it('writes a setting as Cloudflare expects it', async () => {
    const { impl, calls } = stubFetch({
      'PATCH /zones/zone1/settings/always_use_https': { result: { id: 'always_use_https' } },
    });

    await new CloudflareClient('token', impl).setSslSetting('zone1', 'always_use_https', 'on');

    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/zones/zone1/settings/always_use_https',
      body: { value: 'on' },
    });
  });
});
