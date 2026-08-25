import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import superjson from 'superjson';
import { createAppContext, type AppContext } from '../src/app-context.js';
import { createServer } from '../src/server.js';

/**
 * End-to-end exercise of the websites API over real HTTP, including the
 * authorisation boundary.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let app: AppContext;
let server: FastifyInstance;
let cookie: string;

async function call(
  method: 'GET' | 'POST',
  procedure: string,
  body?: unknown,
  withCookie = true,
): Promise<{ status: number; body: any }> {
  // A query takes its input in the URL; only a mutation has a body.
  const query =
    method === 'GET' && body !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(body)))}`
      : '';

  const response = await server.inject({
    method,
    url: `/api/trpc/${procedure}${query}`,
    ...(method === 'POST' && body !== undefined
      ? { payload: superjson.serialize(body) as object }
      : {}),
    headers: {
      'content-type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
  });

  const raw = response.body ? JSON.parse(response.body) : null;

  let unwrapped = raw;
  if (raw?.result?.data !== undefined) {
    unwrapped = { result: { data: superjson.deserialize(raw.result.data) } };
  } else if (raw?.error !== undefined) {
    unwrapped = { error: superjson.deserialize(raw.error) };
  }

  return { status: response.statusCode, body: unwrapped };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-sitesapi-'));
  process.env['WINPANEL_HTTPS'] = 'false';
  process.env['WINPANEL_SITES_ROOT'] = path.join(tmpDir, 'sites');

  app = await createAppContext({
    databasePath: path.join(tmpDir, 'panel.db'),
    vaultKeyPath: path.join(tmpDir, 'vault.key'),
    setupTokenPath: path.join(tmpDir, 'setup-token.txt'),
    migrationsFolder: MIGRATIONS,
    registerJobHandlers: false,
  });

  const setupToken = await app.auth.ensureSetupToken();
  server = await createServer(app);
  await server.ready();

  // Get through setup so the protected routes are reachable. Two-factor is
  // optional, so there is nothing further to enrol in first.
  const setup = await server.inject({
    method: 'POST',
    url: '/api/trpc/auth.completeSetup',
    headers: { 'content-type': 'application/json' },
    payload: superjson.serialize({
      setupToken,
      username: 'owner',
      password: 'a-sufficiently-long-password',
    }) as object,
  });

  cookie = `winpanel_session=${setup.cookies.find((c: any) => c.name === 'winpanel_session')!.value}`;
});

afterEach(async () => {
  await server.close();
  await app.shutdown();
  await fs.rm(tmpDir, { recursive: true, force: true });

  /*
   * The site folders too, not just the database.
   *
   * `config` reads its environment once when the module is first imported,
   * which is before any `beforeEach` runs — so WINPANEL_SITES_ROOT set above
   * does not apply and every test in the suite shares one real folder. Left
   * behind, those folders make a test that checks a file was created pass on
   * a clean machine and fail on the second run, which is the least useful
   * kind of failure there is.
   */
  await fs.rm(app.config.sitesRoot, { recursive: true, force: true });

  delete process.env['WINPANEL_HTTPS'];
  delete process.env['WINPANEL_SITES_ROOT'];
});

describe('authorisation', () => {
  it('refuses every website endpoint without a session', async () => {
    // The client-side route guard is a convenience; this is the real boundary.
    for (const procedure of ['sites.list', 'sites.get']) {
      const result = await call('GET', procedure, undefined, false);
      expect(result.body.error, procedure).toBeDefined();
    }

    const create = await call(
      'POST',
      'sites.create',
      { displayName: 'x', domains: ['x.com'], source: { kind: 'upload' }, manifest: {} },
      false,
    );
    expect(create.body.error).toBeDefined();
  });
});

describe('creating a website', () => {
  const validInput = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: { runtime: 'node' as const },
    envVars: {},
    deployNow: false,
  };

  it('starts with no websites', async () => {
    const result = await call('GET', 'sites.list');
    expect(result.body.result.data).toEqual([]);
  });

  it('creates a website and returns its folder name', async () => {
    const result = await call('POST', 'sites.create', validInput);

    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.slug).toBe('kitora-io');
  }, 30_000);

  it('lists the website afterwards', async () => {
    await call('POST', 'sites.create', validInput);
    const list = await call('GET', 'sites.list');

    expect(list.body.result.data).toHaveLength(1);
    expect(list.body.result.data[0].displayName).toBe('Kitora');
    expect(list.body.result.data[0].domains).toEqual(['kitora.io']);
  }, 30_000);

  it('assigns a port automatically', async () => {
    await call('POST', 'sites.create', validInput);
    const list = await call('GET', 'sites.list');

    expect(list.body.result.data[0].activePort).toBeGreaterThanOrEqual(3001);
  }, 30_000);

  it('rejects an invalid web address', async () => {
    const result = await call('POST', 'sites.create', {
      ...validInput,
      domains: ['not a domain'],
    });
    expect(result.body.error).toBeDefined();
  });

  it('creates a website with no web address at all', async () => {
    /*
     * A site being set up has no DNS yet, and a site being used as a staging
     * copy may never get any. Refusing to create one was what forced every
     * website through a domain it did not have.
     */
    const result = await call('POST', 'sites.create', {
      ...validInput,
      displayName: 'No Domain Yet',
      domains: [],
    });

    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.slug).toBe('no-domain-yet');
  }, 30_000);

  it('creates a subdomain as its own Git-backed website', async () => {
    const parent = await call('POST', 'sites.create', {
      displayName: 'Main site',
      domains: ['example.com'],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });

    const child = await call('POST', 'sites.create', {
      displayName: 'Blog',
      // The server derives this from the parent and label.
      domains: ['ignored.example'],
      parentSiteSlug: parent.body.result.data.slug,
      subdomain: 'blog',
      source: {
        kind: 'git',
        url: 'https://github.com/example/blog.git',
        branch: 'main',
        subdirectory: '',
      },
      manifest: { runtime: 'static' },
      deployNow: false,
    });

    expect(child.body.error).toBeUndefined();
    expect(child.body.result.data.slug).toBe('blog-example-com');

    const detail = await call('GET', 'sites.get', {
      slug: child.body.result.data.slug,
    });
    expect(detail.body.result.data.domains).toEqual(['blog.example.com']);
    expect(detail.body.result.data.isSubdomain).toBe(true);
    expect(detail.body.result.data.parentSlug).toBe('example-com');
    expect(detail.body.result.data.source.kind).toBe('git');
  }, 30_000);

  it('does not allow a parent website to be removed before its subdomains', async () => {
    const parent = await call('POST', 'sites.create', {
      displayName: 'Main site',
      domains: ['example.com'],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });
    await call('POST', 'sites.create', {
      displayName: 'Blog',
      domains: [],
      parentSiteSlug: parent.body.result.data.slug,
      subdomain: 'blog',
      source: { kind: 'upload' },
      runtime: 'static',
      deployNow: false,
    });

    const removed = await call('POST', 'sites.remove', {
      slug: parent.body.result.data.slug,
      confirmSlug: parent.body.result.data.slug,
      password: 'a-sufficiently-long-password',
      deleteFiles: true,
    });

    expect(removed.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(removed.body.error.message).toMatch(/subdomain/i);
  }, 30_000);

  it('keeps a parent primary domain stable while it has subdomains', async () => {
    const parent = await call('POST', 'sites.create', {
      displayName: 'Main site',
      domains: ['example.com'],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });
    await call('POST', 'sites.create', {
      displayName: 'Blog',
      domains: [],
      parentSiteSlug: parent.body.result.data.slug,
      subdomain: 'blog',
      source: { kind: 'upload' },
      runtime: 'static',
      deployNow: false,
    });

    const changed = await call('POST', 'sites.setDomains', {
      slug: parent.body.result.data.slug,
      domains: ['new-example.com'],
    });

    expect(changed.body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(changed.body.error.message).toMatch(/subdomains/i);
  }, 30_000);

  it('gives every website a preview address that works without a domain', async () => {
    const result = await call('POST', 'sites.create', { ...validInput, domains: [] });

    const { previewPort, previewUrl } = result.body.result.data;
    expect(previewPort).toBeGreaterThanOrEqual(7000);
    expect(previewPort).toBeLessThanOrEqual(7999);
    expect(previewUrl).toMatch(/^http:\/\/.+:\d+$/);
  }, 30_000);

  it('reports every website\u2019s liveness to an administrator', async () => {
    await call('POST', 'sites.create', validInput);

    const result = await call('GET', 'sites.websiteHealth');

    expect(result.body.error).toBeUndefined();
    const rows = result.body.result.data;
    expect(rows).toHaveLength(1);
    // Nothing is listening in a test, so the app reads as down — the shape of
    // the answer is what proves the endpoint is wired up.
    expect(rows[0].slug).toBe('kitora-io');
    expect(rows[0].displayName).toBe('Kitora');
    expect(rows[0].status).toBe('down');
    expect(rows[0].canRestart).toBe(true);
    expect(typeof rows[0].previewUrl).toBe('string');
  }, 30_000);

  it('keeps website health away from customers', async () => {
    // The page is admin-only in the UI; this is the real boundary. A customer
    // account gets the same facts about their own site from its Overview page.
    await app.auth.createUser({
      username: 'alice',
      password: 'a-sufficiently-long-password',
      role: 'user',
    });
    const { token } = await app.auth.login({
      username: 'alice',
      password: 'a-sufficiently-long-password',
      ip: '203.0.113.1',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/trpc/sites.websiteHealth',
      headers: { cookie: `winpanel_session=${token}` },
    });
    const body = JSON.parse(response.body);
    expect(body.error ?? body[0]?.error).toBeDefined();
  }, 30_000);

  it('reads a static site as up when its preview listener answers', async () => {
    // A static site has no app process — the web server serves its files. Its
    // "is it up" is read from the preview listener, which serves the same
    // files. Stand a throwaway listener on the preview port to be that.
    const created = await call('POST', 'sites.create', {
      displayName: 'Just HTML',
      domains: [],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });
    expect(created.body.error).toBeUndefined();
    const previewPort = created.body.result.data.previewPort as number;

    const standIn = net.createServer();
    await new Promise<void>((resolve) => standIn.listen(previewPort, '127.0.0.1', resolve));

    try {
      const result = await call('GET', 'sites.websiteHealth');
      const row = result.body.result.data.find((r: any) => r.slug === 'just-html');

      // Not N/A: a static site that is being served reads as up, on both
      // halves, and offers no restart because there is no process to restart.
      expect(row.app).toBe(true);
      expect(row.preview).toBe(true);
      expect(row.status).toBe('ok');
      expect(row.canRestart).toBe(false);
    } finally {
      await new Promise((resolve) => standIn.close(resolve));
    }
  }, 30_000);

  it('creates a blank static website with a starter page', async () => {
    // The case that was impossible before: a website that is just HTML files.
    const result = await call('POST', 'sites.create', {
      displayName: 'Just HTML',
      domains: [],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });

    expect(result.body.error).toBeUndefined();
    expect(result.body.result.data.scaffolded).toContain('index.html');

    const page = await fs.readFile(
      path.join(app.config.sitesRoot, result.body.result.data.slug, 'public', 'index.html'),
      'utf8',
    );
    expect(page).toContain('Just HTML');
  }, 30_000);

  it('refuses a git website that has not been inspected', async () => {
    // Without a manifest the panel has no idea how to build it, and would
    // fail much later with something far less obvious.
    const result = await call('POST', 'sites.create', {
      displayName: 'From Git',
      domains: [],
      source: { kind: 'git', url: 'https://github.com/example/x.git', branch: 'main' },
      deployNow: false,
    });

    expect(result.body.error).toBeDefined();
  });

  it('rejects a manifest that would escape the project folder', async () => {
    // The manifest is user-supplied, so the API must enforce the same limits
    // as the file that ships in the repository.
    const result = await call('POST', 'sites.create', {
      ...validInput,
      manifest: { runtime: 'node', app: { cwd: '../../Windows' } },
    });
    expect(result.body.error).toBeDefined();
  });

  it('rejects a build step that is not an allowed tool', async () => {
    const result = await call('POST', 'sites.create', {
      ...validInput,
      manifest: {
        runtime: 'node',
        steps: [{ name: 'evil', command: 'powershell', args: ['-c', 'whoami'] }],
      },
    });
    expect(result.body.error).toBeDefined();
  });
});

describe('deleting a website', () => {
  const input = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: { runtime: 'node' as const },
    envVars: {},
    deployNow: false,
  };

  it('requires the name to be typed back', async () => {
    // Deleting a website removes ports, secrets and optionally every file.
    // A mis-click must not be able to do that.
    await call('POST', 'sites.create', input);

    const wrong = await call('POST', 'sites.remove', {
      slug: 'kitora-io',
      confirmSlug: 'something-else',
      password: 'a-sufficiently-long-password',
      deleteFiles: true,
    });

    expect(wrong.body.error).toBeDefined();
    expect(wrong.body.error.message).toMatch(/does not match/i);

    // Still there.
    const list = await call('GET', 'sites.list');
    expect(list.body.result.data).toHaveLength(1);
  }, 30_000);

  it('requires the current password', async () => {
    await call('POST', 'sites.create', input);

    const wrong = await call('POST', 'sites.remove', {
      slug: 'kitora-io',
      confirmSlug: 'kitora-io',
      password: 'not-the-password',
      deleteFiles: true,
    });

    expect(wrong.body.error.data.code).toBe('UNAUTHORIZED');
    expect(wrong.body.error.message).toMatch(/password/i);
    expect((await call('GET', 'sites.list')).body.result.data).toHaveLength(1);
  }, 30_000);

  it('removes the website when the name and password match', async () => {
    await call('POST', 'sites.create', input);

    const removed = await call('POST', 'sites.remove', {
      slug: 'kitora-io',
      confirmSlug: 'kitora-io',
      password: 'a-sufficiently-long-password',
      deleteFiles: true,
    });

    expect(removed.body.error).toBeUndefined();
    expect((await call('GET', 'sites.list')).body.result.data).toHaveLength(0);
  }, 30_000);
});

describe('repository validation at the API boundary', () => {
  it('rejects an address that git would treat as an option', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: '--upload-pack=calc.exe',
      branch: 'main',
    });

    expect(result.body.result.data.ok).toBe(false);
  });

  it('rejects the ext:: transport', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: 'ext::sh -c "calc.exe"',
      branch: 'main',
    });

    expect(result.body.result.data.ok).toBe(false);
  });

  it('rejects a branch name that git would treat as an option', async () => {
    const result = await call('POST', 'sites.testRepository', {
      url: 'https://github.com/example/example.git',
      branch: '--upload-pack=x',
    });

    expect(result.body.result.data.ok).toBe(false);
  });
});

describe('the application behind a website', () => {
  const nodeSite = {
    displayName: 'Kitora',
    domains: ['kitora.io'],
    source: { kind: 'upload' as const },
    manifest: { runtime: 'node' as const },
    deployNow: false,
  };

  it('describes how the app runs', async () => {
    await call('POST', 'sites.create', nodeSite);
    const info = await call('GET', 'sites.app.info', { slug: 'kitora-io' });

    expect(info.body.error).toBeUndefined();
    expect(info.body.result.data.runtime).toBe('node');
    // Nothing has been deployed, so there is no package.json to read yet.
    expect(info.body.result.data.scripts).toEqual([]);
    expect(info.body.result.data.applicationUrl).toBe('https://kitora.io');
  }, 30_000);

  it('refuses to run a script the deployed project does not declare', async () => {
    // The script name reaches a spawn, so it has to be a value we have seen
    // rather than whatever was typed.
    await call('POST', 'sites.create', nodeSite);
    const result = await call('POST', 'sites.app.runScript', {
      slug: 'kitora-io',
      script: 'definitely-not-a-script',
    });

    expect(result.body.error).toBeDefined();
  }, 30_000);

  it('only accepts commands from the allowlist', async () => {
    await call('POST', 'sites.create', nodeSite);
    const result = await call('POST', 'sites.app.runCommand', {
      slug: 'kitora-io',
      command: 'powershell',
      args: [],
    });

    expect(result.body.error).toBeDefined();
  }, 30_000);

  it('refuses to control the process of a website that has none', async () => {
    await call('POST', 'sites.create', {
      displayName: 'Just HTML',
      domains: [],
      source: { kind: 'blank' },
      runtime: 'static',
      deployNow: false,
    });

    const result = await call('POST', 'sites.app.restart', { slug: 'just-html' });
    expect(result.body.error.message).toMatch(/served as files/i);
  }, 30_000);

  it('reports disk usage against the website quota', async () => {
    await call('POST', 'sites.create', nodeSite);
    const usage = await call('GET', 'sites.usage', { slug: 'kitora-io' });

    expect(usage.body.error).toBeUndefined();
    expect(usage.body.result.data.usedBytes).toBeGreaterThanOrEqual(0);
    expect(usage.body.result.data.quotaBytes).toBeGreaterThan(0);
  }, 30_000);
});

describe('the repository behind a website', () => {
  it('says a website has no repository rather than failing obscurely', async () => {
    await call('POST', 'sites.create', {
      displayName: 'Uploaded',
      domains: [],
      source: { kind: 'upload' },
      manifest: { runtime: 'node' },
      deployNow: false,
    });

    const result = await call('GET', 'sites.git.info', { slug: 'uploaded' });
    expect(result.body.error.message).toMatch(/not connected to a repository/i);
  }, 30_000);
});
