import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChecksumMismatchError,
  DownloadError,
  downloadVerified,
  hashFile,
} from '../src/components/download.js';
import { COMPONENT_CATALOGUE, findComponent } from '../src/components/catalogue.js';

let tmpDir: string;
let server: { url: string; close: () => Promise<void> };

/** Minimal local HTTP server so the tests never touch the internet. */
async function startServer(routes: Record<string, Buffer | number>): Promise<typeof server> {
  const http = await import('node:http');
  const instance = http.createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (route === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (typeof route === 'number') {
      res.statusCode = route;
      res.end('error');
      return;
    }
    res.setHeader('content-length', String(route.length));
    res.end(route);
  });

  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address() as { port: number };

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => instance.close(() => resolve())),
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-dl-'));
});

afterEach(async () => {
  await server?.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('downloadVerified', () => {
  const payload = Buffer.from('pretend this is caddy.exe');
  const goodHash = crypto.createHash('sha256').update(payload).digest('hex');

  it('downloads and verifies a correct file', async () => {
    server = await startServer({ '/caddy.zip': payload });
    const destination = path.join(tmpDir, 'caddy.zip');

    const result = await downloadVerified({
      url: `${server.url}/caddy.zip`,
      destination,
      sha256: goodHash,
    });

    expect(result.verified).toBe(true);
    expect(result.sha256).toBe(goodHash);
    expect(await fs.readFile(destination)).toEqual(payload);
  });

  it('refuses a file whose hash does not match, and leaves nothing behind', async () => {
    // The critical property: a tampered binary must never reach disk in a
    // place the installer would later execute.
    server = await startServer({ '/evil.zip': Buffer.from('malicious payload') });
    const destination = path.join(tmpDir, 'evil.zip');

    await expect(
      downloadVerified({ url: `${server.url}/evil.zip`, destination, sha256: goodHash }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);

    await expect(fs.access(destination)).rejects.toThrow();

    const leftovers = await fs.readdir(tmpDir);
    expect(leftovers.filter((f) => f.includes('.part-'))).toHaveLength(0);
  });

  it('explains a hash mismatch in plain English', async () => {
    server = await startServer({ '/x.zip': Buffer.from('different') });

    await expect(
      downloadVerified({
        url: `${server.url}/x.zip`,
        destination: path.join(tmpDir, 'x.zip'),
        sha256: goodHash,
      }),
    ).rejects.toThrow(/fingerprint|tampered/i);
  });

  it('allows an unverified download when no hash is pinned', async () => {
    // Only legitimate for Caddy, whose binary is built per request.
    server = await startServer({ '/dyn.zip': payload });
    const destination = path.join(tmpDir, 'dyn.zip');

    const result = await downloadVerified({
      url: `${server.url}/dyn.zip`,
      destination,
      sha256: null,
    });

    expect(result.verified).toBe(false);
    expect(result.sha256).toBe(goodHash);
  });

  it('reports progress as bytes arrive', async () => {
    server = await startServer({ '/big.zip': Buffer.alloc(64 * 1024, 7) });
    const seen: number[] = [];

    await downloadVerified({
      url: `${server.url}/big.zip`,
      destination: path.join(tmpDir, 'big.zip'),
      sha256: null,
      onProgress: (received) => seen.push(received),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(64 * 1024);
  });

  it('fails clearly on an HTTP error', async () => {
    server = await startServer({ '/missing.zip': 500 });

    await expect(
      downloadVerified({
        url: `${server.url}/missing.zip`,
        destination: path.join(tmpDir, 'missing.zip'),
        sha256: null,
      }),
    ).rejects.toBeInstanceOf(DownloadError);
  });

  it('fails clearly when the host is unreachable', async () => {
    server = await startServer({});

    await expect(
      downloadVerified({
        // Reserved for documentation, so it will never resolve.
        url: 'http://127.0.0.1:1/nope.zip',
        destination: path.join(tmpDir, 'nope.zip'),
        sha256: null,
      }),
    ).rejects.toThrow(/internet connection|could not download/i);
  });

  it('does not overwrite a good file when a later download fails', async () => {
    server = await startServer({ '/good.zip': payload, '/bad.zip': 500 });
    const destination = path.join(tmpDir, 'component.zip');

    await downloadVerified({
      url: `${server.url}/good.zip`,
      destination,
      sha256: goodHash,
    });

    await expect(
      downloadVerified({ url: `${server.url}/bad.zip`, destination, sha256: null }),
    ).rejects.toThrow();

    expect(await fs.readFile(destination)).toEqual(payload);
  });
});

describe('hashFile', () => {
  it('matches the hash computed during download', async () => {
    const file = path.join(tmpDir, 'sample.bin');
    const content = Buffer.from('some content here');
    await fs.writeFile(file, content);

    expect(await hashFile(file)).toBe(
      crypto.createHash('sha256').update(content).digest('hex'),
    );
  });
});

describe('component catalogue', () => {
  it('pins a version for everything that can be pinned', () => {
    for (const component of COMPONENT_CATALOGUE) {
      // Caddy's download service has no version parameter: it always builds
      // the current release, so a number here would be a lie. The same reason
      // it cannot have a fixed hash.
      if (component.id === 'caddy') {
        expect(component.version).toBe('latest');
        continue;
      }

      expect(component.version, component.id).toMatch(/^\d+\.\d+/);
    }
  });

  it('uses HTTPS for every download', () => {
    for (const component of COMPONENT_CATALOGUE) {
      expect(component.url, component.id).toMatch(/^https:\/\//);
    }
  });

  it('only allows an unpinned hash for Caddy, which is built per request', () => {
    for (const component of COMPONENT_CATALOGUE) {
      if (component.id === 'caddy') continue;

      // Everything here runs with high privilege once installed, so an
      // unverified download is a route onto the server. Caddy is the sole
      // exception because its endpoint compiles a binary per request.
      expect(component.sha256, `${component.id} must pin a hash`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(findComponent('caddy')?.sha256).toBeNull();
  });

  it('requests the Cloudflare DNS plugin in the Caddy build', () => {
    // Without this module Caddy cannot answer the DNS challenge, and every
    // certificate request fails once a domain is behind Cloudflare's proxy.
    expect(findComponent('caddy')?.url).toContain('caddy-dns/cloudflare');
  });

  it('describes each component in plain English, without jargon', () => {
    for (const component of COMPONENT_CATALOGUE) {
      expect(component.description.length).toBeGreaterThan(20);
      expect(component.description, component.id).not.toMatch(
        /reverse proxy|ACME|DNS-01|daemon|binary/i,
      );
    }
  });

  it('uses the portable git build rather than an installer', () => {
    const git = findComponent('git');
    expect(git?.kind).toBe('zip');
    expect(git?.url).toContain('MinGit');
  });

  it('offers every package manager a project might ask for', () => {
    // npm is deliberately absent: it comes inside the Node install, so a
    // separate copy would only be a second npm to keep up to date.
    for (const id of ['pnpm', 'yarn', 'bun']) {
      expect(findComponent(id), id).toBeDefined();
    }
    expect(findComponent('npm')).toBeUndefined();
  });

  it('installs Yarn as the JavaScript file it is published as', () => {
    // Yarn 1 ships no program for Windows: only a .js file and a system-wide
    // installer the panel has no business running.
    const yarn = findComponent('yarn');
    expect(yarn?.kind).toBe('node-script');
    expect(yarn?.url).toMatch(/\.js$/);
    expect(yarn?.sha256).not.toBeNull();
  });

  it('installs the Windows build of Bun', () => {
    const bun = findComponent('bun');
    expect(bun?.kind).toBe('zip');
    expect(bun?.url).toContain('bun-windows-x64.zip');
  });
});
