import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { PortAllocationError, PortAllocator } from '../src/sites/port-allocator.js';
import {
  DeploymentError,
  explainToolFailure,
  newReleaseId,
  pruneFailedReleases,
  pruneOldReleases,
  runBuildSteps,
  waitForHealthy,
  withInstallDefaults,
} from '../src/sites/deploy-pipeline.js';
import type { JobContext } from '../src/jobs/queue.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;

function fakeCtx(): JobContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    jobId: 'job-1',
    lines,
    log: (message) => lines.push(message),
    progress: () => undefined,
    isCancelled: () => false,
    throwIfCancelled: () => undefined,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-deploy-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
});

/**
 * Port allocations reference a real site, and the foreign key is enforced.
 * Tests therefore create the site rather than inventing an id.
 */
async function createSite(id: string): Promise<string> {
  const { sites } = await import('../src/db/schema.js');
  handle.db
    .insert(sites)
    .values({
      id,
      slug: id,
      displayName: id,
      runtime: 'node',
      domains: [],
      source: { kind: 'upload' },
      manifest: SiteManifest.parse({}),
    })
    .run();
  return id;
}

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('PortAllocator', () => {
  it('allocates a distinct pair for a site', async () => {
    const allocator = new PortAllocator(handle);
    const pair = await allocator.allocatePair(await createSite('site-1'));

    expect(pair.blue).toBeGreaterThanOrEqual(3001);
    expect(pair.green).toBeGreaterThan(pair.blue);
  }, 30_000);

  it('never hands out the same port to two sites', async () => {
    const allocator = new PortAllocator(handle);
    const first = await allocator.allocatePair(await createSite('site-1'));
    const second = await allocator.allocatePair(await createSite('site-2'));

    const all = [first.blue, first.green, second.blue, second.green];
    expect(new Set(all).size).toBe(4);
  }, 30_000);

  it('returns the existing pair rather than reallocating', async () => {
    const allocator = new PortAllocator(handle);
    const site = await createSite('site-1');
    const first = await allocator.allocatePair(site);
    const again = await allocator.allocatePair(site);
    expect(again).toEqual(first);
  }, 30_000);

  it('refuses to give a site the control panel port', async () => {
    // The user chose a fixed panel port so it is memorable; the flip side is
    // that a site taking it would make the panel unreachable.
    const allocator = new PortAllocator(handle);
    await expect(
      allocator.assignManual(await createSite('site-1'), 'blue', 8443),
    ).rejects.toThrow(/lock you out/i);
  });

  it('refuses reserved infrastructure ports', async () => {
    const allocator = new PortAllocator(handle);
    const site = await createSite('site-1');

    for (const port of [80, 443, 2019, 8080, 25, 3389]) {
      await expect(
        allocator.assignManual(site, 'blue', port),
        `port ${port}`,
      ).rejects.toBeInstanceOf(PortAllocationError);
    }
  });

  it('refuses a port already held by another site', async () => {
    const allocator = new PortAllocator(handle);
    await allocator.assignManual(await createSite('site-1'), 'blue', 3500);

    await expect(
      allocator.assignManual(await createSite('site-2'), 'blue', 3500),
    ).rejects.toThrow(/already used/i);
  });

  it('allows a site to keep its own port', async () => {
    const allocator = new PortAllocator(handle);
    const site = await createSite('site-1');

    await allocator.assignManual(site, 'blue', 3500);
    await expect(allocator.assignManual(site, 'blue', 3500)).resolves.toBeUndefined();
  });

  it('frees ports when a site is removed', async () => {
    const allocator = new PortAllocator(handle);
    const site = await createSite('site-1');

    await allocator.assignManual(site, 'blue', 3500);
    expect(allocator.takenPorts().has(3500)).toBe(true);

    allocator.release(site);
    expect(allocator.takenPorts().has(3500)).toBe(false);
  });
});

describe('newReleaseId', () => {
  it('produces a sortable timestamp', () => {
    const early = newReleaseId(new Date('2026-01-02T03:04:05Z'));
    const later = newReleaseId(new Date('2026-01-02T03:04:06Z'));

    expect(early).toBe('20260102-030405');
    expect([later, early].sort()).toEqual([early, later]);
  });
});

describe('runBuildSteps', () => {
  const tools = {
    resolve: async () => ({
      exe: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      args: [],
    }),
  };

  it('skips the build for a project uploaded already built', async () => {
    const ctx = fakeCtx();
    await runBuildSteps({
      manifest: SiteManifest.parse({ buildLocation: 'prebuilt' }),
      releaseDir: tmpDir,
      tools,
      ctx,
    });

    expect(ctx.lines.join(' ')).toMatch(/already built/i);
  });

  it('fails clearly when a step targets a folder that does not exist', async () => {
    // The manifest comes from the user's repository, so a typo in `cwd` must
    // produce a helpful message rather than an opaque spawn error.
    const ctx = fakeCtx();

    await expect(
      runBuildSteps({
        manifest: SiteManifest.parse({
          steps: [{ name: 'Install', cwd: 'frontend', command: 'npm', args: ['install'] }],
        }),
        releaseDir: tmpDir,
        tools,
        ctx,
      }),
    ).rejects.toThrow(/folder "frontend" does not exist/i);
  });

  it('runs each step in its own folder', async () => {
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    const seen: string[] = [];
    const ctx = fakeCtx();

    await runBuildSteps({
      manifest: SiteManifest.parse({
        steps: [
          { name: 'Build frontend', cwd: 'frontend', command: 'node', args: ['-e', ''] },
          { name: 'Install backend', cwd: 'backend', command: 'node', args: ['-e', ''] },
        ],
      }),
      releaseDir: tmpDir,
      tools: {
        resolve: async () => ({ exe: process.execPath, args: [] }),
      },
      ctx,
    });

    // Both steps completed, in order, without error.
    expect(ctx.lines.some((l) => l.includes('Build frontend'))).toBe(true);
    expect(ctx.lines.some((l) => l.includes('Install backend'))).toBe(true);
    void seen;
  }, 30_000);

  it('fails the deploy when a required step fails', async () => {
    await fs.mkdir(path.join(tmpDir, 'app'), { recursive: true });
    const ctx = fakeCtx();

    await expect(
      runBuildSteps({
        manifest: SiteManifest.parse({
          steps: [
            { name: 'Build', cwd: 'app', command: 'node', args: ['-e', 'process.exit(1)'] },
          ],
        }),
        releaseDir: tmpDir,
        tools: { resolve: async () => ({ exe: process.execPath, args: [] }) },
        ctx,
      }),
    ).rejects.toBeInstanceOf(DeploymentError);
  }, 30_000);

  it('continues past an optional step that fails', async () => {
    await fs.mkdir(path.join(tmpDir, 'app'), { recursive: true });
    const ctx = fakeCtx();

    await runBuildSteps({
      manifest: SiteManifest.parse({
        steps: [
          {
            name: 'Optional lint',
            cwd: 'app',
            command: 'node',
            args: ['-e', 'process.exit(1)'],
            optional: true,
          },
        ],
      }),
      releaseDir: tmpDir,
      tools: { resolve: async () => ({ exe: process.execPath, args: [] }) },
      ctx,
    });

    expect(ctx.lines.join(' ')).toMatch(/optional/i);
  }, 30_000);
});

describe('waitForHealthy', () => {
  it('accepts any response, including a 404', async () => {
    // The question is "did the process start and bind its port", not "is the
    // home page correct" — plenty of APIs legitimately 404 at the root.
    const ctx = fakeCtx();
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));

    await waitForHealthy({
      port: 3001,
      path: '/',
      timeoutSeconds: 5,
      ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps waiting while the app is still starting', async () => {
    const ctx = fakeCtx();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new Response('ok', { status: 200 });
    });

    await waitForHealthy({
      port: 3001,
      path: '/',
      timeoutSeconds: 10,
      ctx,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(calls).toBe(3);
  });

  it('treats a server error as not yet healthy', async () => {
    const ctx = fakeCtx();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      waitForHealthy({
        port: 3001,
        path: '/',
        timeoutSeconds: 1,
        ctx,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned an error \(500\)/i);
  });

  it('explains a timeout and points at the log', async () => {
    const ctx = fakeCtx();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      waitForHealthy({
        port: 3001,
        path: '/',
        timeoutSeconds: 1,
        ctx,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/nothing is listening|deployment log/i);
  });
});

describe('pruneOldReleases', () => {
  it('keeps the newest releases and the current one', async () => {
    const releases = path.join(tmpDir, 'releases');
    for (const id of ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000']) {
      await fs.mkdir(path.join(releases, id), { recursive: true });
    }

    const removed = await pruneOldReleases(releases, 3, '20260104-000000');
    const left = (await fs.readdir(releases)).sort();

    expect(left).toContain('20260104-000000');
    expect(left).toContain('20260103-000000');
    expect(removed).toContain('20260101-000000');
  });

  it('never removes the release that is currently live', async () => {
    const releases = path.join(tmpDir, 'releases');
    for (const id of ['20260101-000000', '20260102-000000']) {
      await fs.mkdir(path.join(releases, id), { recursive: true });
    }

    await pruneOldReleases(releases, 1, '20260101-000000');
    expect(await fs.readdir(releases)).toContain('20260101-000000');
  });

  it('copes with a site that has never been deployed', async () => {
    await expect(pruneOldReleases(path.join(tmpDir, 'nope'), 3, 'x')).resolves.toEqual([]);
  });
});

describe('pruneFailedReleases', () => {
  const failures = ['20260101-000000', '20260102-000000', '20260103-000000'];

  async function makeReleases(): Promise<string> {
    const releases = path.join(tmpDir, 'releases');
    for (const id of [...failures, '20260104-000000']) {
      await fs.mkdir(path.join(releases, id), { recursive: true });
    }
    return releases;
  }

  it('keeps the most recent failure and discards the rest', async () => {
    // The newest failure is the one whose folder anybody would look inside.
    const releases = await makeReleases();

    const removed = await pruneFailedReleases(releases, failures);
    const left = await fs.readdir(releases);

    expect(removed.sort()).toEqual(['20260101-000000', '20260102-000000']);
    expect(left).toContain('20260103-000000');
  });

  it('never touches a release it was not told had failed', async () => {
    const releases = await makeReleases();

    await pruneFailedReleases(releases, failures);
    expect(await fs.readdir(releases)).toContain('20260104-000000');
  });

  it('refuses to remove the release that is live, whatever it was told', async () => {
    const releases = await makeReleases();

    await pruneFailedReleases(releases, failures, { keep: 0, protect: ['20260101-000000'] });
    expect(await fs.readdir(releases)).toEqual(['20260101-000000', '20260104-000000']);
  });

  it('copes with a site that has never been deployed', async () => {
    await expect(pruneFailedReleases(path.join(tmpDir, 'nope'), ['x'])).resolves.toEqual([]);
  });

  it('does not count a folder an earlier deploy already removed', async () => {
    // Failures stay in the database forever, so the same ids come back on
    // every deploy. Counting them reported a cleanup that never happened, and
    // the number grew by one each time.
    const releases = await makeReleases();
    await fs.rm(path.join(releases, '20260101-000000'), { recursive: true });

    const removed = await pruneFailedReleases(releases, failures);
    expect(removed).toEqual(['20260102-000000']);
  });
});

describe('withInstallDefaults', () => {
  it('lets a dependency build itself, which pnpm otherwise refuses to do unattended', async () => {
    expect(withInstallDefaults('pnpm', ['install'])).toEqual([
      'install',
      '--dangerously-allow-all-builds',
    ]);
    expect(withInstallDefaults('pnpm', ['install', '--prod'])).toContain(
      '--dangerously-allow-all-builds',
    );
  });

  it('leaves every other command exactly as it was', () => {
    expect(withInstallDefaults('pnpm', ['run', 'build'])).toEqual(['run', 'build']);
    expect(withInstallDefaults('npm', ['install'])).toEqual(['install']);
    expect(withInstallDefaults('yarn', ['install'])).toEqual(['install']);
  });

  it('does not add the flag twice', () => {
    const once = withInstallDefaults('pnpm', ['install', '--dangerously-allow-all-builds']);
    expect(once.filter((arg) => arg === '--dangerously-allow-all-builds')).toHaveLength(1);
  });
});

describe('explainToolFailure', () => {
  it('names the fix when pnpm is too old to be told about build scripts', () => {
    const hint = explainToolFailure('pnpm', 'ERR_PNPM_BAD_OPTION Unknown option: allow-all-builds');
    expect(hint).toMatch(/too old/i);
  });

  it('explains an unresolved package as a missing direct dependency', () => {
    const hint = explainToolFailure(
      'pnpm',
      "Nuxt build error: Error: [@tailwindcss/vite:generate:build] Can't resolve 'tailwindcss' in " +
        "'C:\\Sites\\example\\releases\\1\\app\\assets\\css'",
    );
    expect(hint).toMatch(/tailwindcss/);
    expect(hint).toMatch(/switch this website to npm/);
  });

  it('ignores a missing file of the project itself', () => {
    expect(explainToolFailure('pnpm', "Can't resolve './missing.css'")).toBeNull();
  });

  it('says nothing when there is nothing useful to add', () => {
    expect(explainToolFailure('pnpm', 'ELIFECYCLE build failed')).toBeNull();
    expect(explainToolFailure('npm', 'ERR_PNPM_IGNORED_BUILDS')).toBeNull();
  });
});
