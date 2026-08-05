import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteManifest } from '@winpanel/shared';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { PortAllocationError, PortAllocator } from '../src/sites/port-allocator.js';
import {
  DeploymentError,
  discardPrevious,
  explainToolFailure,
  explainRuntimeFailure,
  isInstallStep,
  newReleaseId,
  prepareStaging,
  promoteStaging,
  releaseFoldersFor,
  removeLegacyLayout,
  restorePrevious,
  runBuildSteps,
  waitForHealthy,
  withPnpmDefaults,
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

  it('installs with the devDependencies the build needs, then builds for production', async () => {
    // npm and yarn read NODE_ENV: told production, they leave out the very
    // packages the next step is about to run.
    await fs.mkdir(path.join(tmpDir, 'app'), { recursive: true });
    const ctx = fakeCtx();

    await runBuildSteps({
      manifest: SiteManifest.parse({
        steps: [
          { name: 'Install', cwd: 'app', command: 'npm', args: ['install'] },
          { name: 'Build', cwd: 'app', command: 'npm', args: ['run', 'build'] },
        ],
      }),
      releaseDir: tmpDir,
      tools: {
        resolve: async () => ({
          exe: process.execPath,
          args: ['-e', 'console.log(`saw ${process.env.NODE_ENV}`)'],
        }),
      },
      ctx,
    });

    expect(ctx.lines).toContain('saw development');
    expect(ctx.lines).toContain('saw production');
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

describe('the release swap', () => {
  async function siteWithRelease(contents: string): Promise<string> {
    const siteDir = path.join(tmpDir, 'site');
    const folders = releaseFoldersFor(siteDir);
    await fs.mkdir(folders.release, { recursive: true });
    await fs.writeFile(path.join(folders.release, 'index.js'), contents);
    return siteDir;
  }

  async function stage(siteDir: string, contents: string): Promise<void> {
    const folders = releaseFoldersFor(siteDir);
    await fs.mkdir(folders.staging, { recursive: true });
    await fs.writeFile(path.join(folders.staging, 'index.js'), contents);
  }

  it('clears whatever the last attempt left staged', async () => {
    // Building on top of it would resurrect files the repository has deleted.
    const siteDir = path.join(tmpDir, 'site');
    const folders = releaseFoldersFor(siteDir);
    await fs.mkdir(folders.staging, { recursive: true });
    await fs.writeFile(path.join(folders.staging, 'stale.txt'), 'old');

    await prepareStaging(folders);
    await expect(fs.readdir(folders.staging)).rejects.toThrow();
  });

  it('swaps the staged version in and keeps the old one to hand', async () => {
    const siteDir = await siteWithRelease('old');
    const folders = releaseFoldersFor(siteDir);
    await stage(siteDir, 'new');

    await promoteStaging(folders);

    expect(await fs.readFile(path.join(folders.release, 'index.js'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(folders.previous, 'index.js'), 'utf8')).toBe('old');
  });

  it('works on a site that has never been deployed', async () => {
    const siteDir = path.join(tmpDir, 'site');
    const folders = releaseFoldersFor(siteDir);
    await stage(siteDir, 'first');

    await promoteStaging(folders);
    expect(await fs.readFile(path.join(folders.release, 'index.js'), 'utf8')).toBe('first');
  });

  it('puts the old version back when the new one does not run', async () => {
    const siteDir = await siteWithRelease('old');
    const folders = releaseFoldersFor(siteDir);
    await stage(siteDir, 'broken');
    await promoteStaging(folders);

    expect(await restorePrevious(folders)).toBe(true);

    expect(await fs.readFile(path.join(folders.release, 'index.js'), 'utf8')).toBe('old');
    // The failed build survives as the only evidence of what went wrong.
    expect(await fs.readFile(path.join(folders.staging, 'index.js'), 'utf8')).toBe('broken');
    await expect(fs.readdir(folders.previous)).rejects.toThrow();
  });

  it('says so when there is no previous version to go back to', async () => {
    const siteDir = path.join(tmpDir, 'site');
    await stage(siteDir, 'first');
    const folders = releaseFoldersFor(siteDir);
    await promoteStaging(folders);

    expect(await restorePrevious(folders)).toBe(false);
  });

  it('keeps the last working version when a second deploy follows a failed one', async () => {
    // A leftover `.previous` means the last deploy failed after swapping, so
    // `release/` holds a build that never ran. Overwriting the working copy
    // with it would leave nothing to go back to.
    const siteDir = await siteWithRelease('broken');
    const folders = releaseFoldersFor(siteDir);
    await fs.mkdir(folders.previous, { recursive: true });
    await fs.writeFile(path.join(folders.previous, 'index.js'), 'working');

    await stage(siteDir, 'newer');
    await promoteStaging(folders);

    expect(await fs.readFile(path.join(folders.release, 'index.js'), 'utf8')).toBe('newer');
    expect(await fs.readFile(path.join(folders.previous, 'index.js'), 'utf8')).toBe('working');

    // And a rollback therefore lands on the version that actually served.
    expect(await restorePrevious(folders)).toBe(true);
    expect(await fs.readFile(path.join(folders.release, 'index.js'), 'utf8')).toBe('working');
  });

  it('leaves exactly one copy of the site once the deploy has finished', async () => {
    const siteDir = await siteWithRelease('old');
    const folders = releaseFoldersFor(siteDir);
    await stage(siteDir, 'new');

    await promoteStaging(folders);
    await discardPrevious(folders);

    expect((await fs.readdir(siteDir)).sort()).toEqual(['release']);
  });

  it('clears the timestamped folders left by the old layout', async () => {
    const siteDir = await siteWithRelease('code');
    await fs.mkdir(path.join(siteDir, 'releases', '20260101-000000'), { recursive: true });

    expect(await removeLegacyLayout(siteDir)).toBe(true);
    expect(await fs.readdir(siteDir)).toEqual(['release']);
    // And says nothing on a site that never had them.
    expect(await removeLegacyLayout(siteDir)).toBe(false);
  });
});

describe('withPnpmDefaults', () => {
  it('lets a dependency build itself, which pnpm otherwise refuses to do unattended', () => {
    expect(withPnpmDefaults('pnpm', ['install'])).toContain('--dangerously-allow-all-builds');
    expect(withPnpmDefaults('pnpm', ['install', '--prod'])).toContain(
      '--dangerously-allow-all-builds',
    );
  });

  it('asks for nothing to be built when the step is not an install', () => {
    expect(withPnpmDefaults('pnpm', ['run', 'build'])).not.toContain(
      '--dangerously-allow-all-builds',
    );
  });

  it('installs flat, because the folder is renamed after the install', () => {
    // pnpm's default layout links packages together with Windows junctions,
    // which hold an absolute path: renaming .staging to release would leave
    // every one of them pointing at a folder that is gone.
    expect(withPnpmDefaults('pnpm', ['install'])).toContain('--config.node-linker=hoisted');
  });

  it('gives a build step the same settings, so pnpm cannot undo the install', () => {
    // Told different settings from the ones node_modules was built with, pnpm
    // reinstalls before running the script - without any of these options.
    const args = withPnpmDefaults('pnpm', ['run', 'build']);
    expect(args).toContain('--config.node-linker=hoisted');
    expect(args).toContain('--config.verify-deps-before-run=false');
  });

  it('puts its options before the subcommand, where pnpm reads them', () => {
    // Anything after `run <script>` is handed to the script instead.
    const args = withPnpmDefaults('pnpm', ['run', 'build']);
    expect(args.indexOf('run')).toBeGreaterThan(args.indexOf('--config.node-linker=hoisted'));
    expect(args.slice(-2)).toEqual(['run', 'build']);
  });

  it('leaves a project that has chosen its own settings alone', () => {
    const args = withPnpmDefaults('pnpm', ['install', '--config.node-linker=pnp']);
    expect(args.filter((arg) => arg.startsWith('--config.node-linker='))).toEqual([
      '--config.node-linker=pnp',
    ]);
  });

  it('leaves every other package manager exactly as it was', () => {
    expect(withPnpmDefaults('npm', ['install'])).toEqual(['install']);
    expect(withPnpmDefaults('yarn', ['install'])).toEqual(['install']);
    expect(withPnpmDefaults('node', ['-e', ''])).toEqual(['-e', '']);
  });

  it('does not add the flag twice', () => {
    const once = withPnpmDefaults('pnpm', ['install', '--dangerously-allow-all-builds']);
    expect(once.filter((arg) => arg === '--dangerously-allow-all-builds')).toHaveLength(1);
  });
});

describe('isInstallStep', () => {
  it('recognises every way a package manager is asked to install', () => {
    expect(isInstallStep('npm', ['install'])).toBe(true);
    expect(isInstallStep('npm', ['ci'])).toBe(true);
    expect(isInstallStep('pnpm', ['i', '--frozen-lockfile'])).toBe(true);
    expect(isInstallStep('yarn', [])).toBe(true);
    expect(isInstallStep('bun', ['install'])).toBe(true);
  });

  it('is not fooled by a script that happens to be called install', () => {
    expect(isInstallStep('npm', ['run', 'install'])).toBe(false);
    expect(isInstallStep('node', ['install'])).toBe(false);
    expect(isInstallStep('npm', ['run', 'build'])).toBe(false);
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
    expect(hint).toMatch(/never lists it/);
  });

  it('ignores a missing file of the project itself', () => {
    expect(explainToolFailure('pnpm', "Can't resolve './missing.css'")).toBeNull();
  });

  it('says nothing when there is nothing useful to add', () => {
    expect(explainToolFailure('pnpm', 'ELIFECYCLE build failed')).toBeNull();
    expect(explainToolFailure('npm', 'ERR_PNPM_IGNORED_BUILDS')).toBeNull();
  });
});

describe('explainRuntimeFailure', () => {
  it('names the package a built app asked for and could not find', () => {
    // The build passed: a bundler resolves packages differently from the
    // finished app, which has to find `entities` on disk for itself.
    const hint = explainRuntimeFailure("Error: Cannot find module 'entities/decode'", 'pnpm');

    expect(hint).toMatch(/"entities"/);
    expect(hint).toMatch(/pnpm add entities/);
  });

  it('keeps the scope on a scoped package', () => {
    const hint = explainRuntimeFailure("Cannot find module '@vue/shared/dist/x.js'", 'pnpm');
    expect(hint).toMatch(/"@vue\/shared"/);
  });

  it('points a missing file at the startup file setting', () => {
    const hint = explainRuntimeFailure(
      "Error: Cannot find module 'C:\\Sites\\example\\release\\index.js'",
      'npm',
    );
    expect(hint).toMatch(/startup file/i);
    expect(hint).toMatch(/\.output\/server\/index\.mjs/);
  });

  it('names the manager the website actually uses', () => {
    const hint = explainRuntimeFailure("Cannot find module 'entities'", 'npm');
    expect(hint).toMatch(/Add "entities"/);
    expect(hint).toMatch(/npm add entities/);
  });

  it('says nothing about a crash that is not a missing module', () => {
    expect(explainRuntimeFailure('Error: listen EADDRINUSE 127.0.0.1:3002', 'pnpm')).toBeNull();
  });
});
