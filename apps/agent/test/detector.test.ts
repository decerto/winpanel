import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectApp, entryFromStartScript, extractOutputDir } from '../src/detect/detector.js';

/**
 * Fixture suite for project detection.
 *
 * Detection is the most user-visible thing in the product: get it wrong and
 * the first deploy fails with an error about someone else's project layout.
 * Each fixture is a miniature repository written to a temp folder.
 */

let tmpDir: string;

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(tmpDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-detect-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('frontend builds into backend (the primary layout)', () => {
  beforeEach(async () => {
    // frontend/ builds into backend/public; only backend/ runs, and it serves
    // the built files itself.
    await write(
      'frontend/package.json',
      JSON.stringify({
        name: 'frontend',
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^7.0.0', vue: '^3.5.0' },
      }),
    );
    await write(
      'frontend/vite.config.ts',
      `import { defineConfig } from 'vite';
       export default defineConfig({
         build: { outDir: '../backend/public', emptyOutDir: true },
       });`,
    );
    await write('frontend/pnpm-lock.yaml', 'lockfileVersion: 9.0');

    await write(
      'backend/package.json',
      JSON.stringify({
        name: 'backend',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^5.0.0' },
      }),
    );
    await write('backend/pnpm-lock.yaml', 'lockfileVersion: 9.0');
    await write('backend/server.js', 'require("express")()');
  });

  it('recognises the layout with high confidence', async () => {
    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('frontend-builds-into-backend');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('runs the app from the backend folder, not the repository root', async () => {
    const result = await detectApp(tmpDir);
    expect(result.manifest.app.cwd).toBe('backend');
  });

  it('names the backend entry file rather than leaving it to guesswork', async () => {
    const result = await detectApp(tmpDir);
    expect(result.manifest.app.entry).toBe('server.js');
  });

  it('produces the three build steps in the right order and folders', async () => {
    const result = await detectApp(tmpDir);
    const steps = result.manifest.steps;

    expect(steps).toHaveLength(3);
    expect(steps[0]?.cwd).toBe('frontend');
    expect(steps[0]?.args).toContain('install');
    expect(steps[1]?.cwd).toBe('frontend');
    expect(steps[1]?.args).toEqual(['run', 'build']);
    expect(steps[2]?.cwd).toBe('backend');
  });

  it('installs only production packages for the backend', async () => {
    const result = await detectApp(tmpDir);
    expect(result.manifest.steps[2]?.args).toContain('--prod');
  });

  it('does NOT add a single-page-app fallback', async () => {
    // The backend already has a catch-all route. A second fallback at the web
    // server would double-handle requests and hide genuine API 404s.
    const result = await detectApp(tmpDir);
    expect(result.manifest.spaFallback).toBe(false);
  });

  it('picks up the package manager per folder from the lockfiles', async () => {
    const result = await detectApp(tmpDir);
    expect(result.manifest.packageManager).toBe('pnpm');
    expect(result.manifest.steps[0]?.command).toBe('pnpm');
  });

  it('explains the layout in plain English', async () => {
    const result = await detectApp(tmpDir);
    expect(result.summary).toMatch(/frontend/i);
    expect(result.summary).toMatch(/backend/i);
    expect(result.summary).not.toMatch(/manifest|cwd|outDir|schema/i);
  });

  it('notes when the built output is not stored in the repository', async () => {
    await write('.gitignore', 'node_modules\nbackend/public\n');
    const result = await detectApp(tmpDir);

    // Otherwise a "prebuilt" deploy would ship an empty folder and serve a
    // blank page with no obvious cause.
    expect(result.notes.join(' ')).toMatch(/built here on the server/i);
    expect(result.manifest.buildLocation).toBe('server');
  });

  it('detects websockets in the backend', async () => {
    await write(
      'backend/package.json',
      JSON.stringify({
        name: 'backend',
        dependencies: { express: '^5.0.0', 'socket.io': '^4.8.0' },
      }),
    );

    const result = await detectApp(tmpDir);
    // Forces blue/green rather than load balancing, because socket.io needs
    // sticky sessions.
    expect(result.manifest.websockets).toBe(true);
  });
});

describe('workspace monorepo with a Vue frontend and an Express backend', () => {
  beforeEach(async () => {
    await write(
      'package.json',
      JSON.stringify({ name: 'kitora', private: true, workspaces: ['frontend', 'backend'] }),
    );
    await write(
      'frontend/package.json',
      JSON.stringify({ name: 'frontend', scripts: { build: 'vite build' }, devDependencies: { vite: '^7.0.0' } }),
    );
    await write('frontend/vite.config.js', 'export default {};');
    await write(
      'backend/package.json',
      JSON.stringify({
        name: 'backend',
        scripts: { start: 'node src/index.js', dev: 'nodemon src/index.js' },
        dependencies: { express: '^5.0.0' },
      }),
    );
    await write('backend/src/index.js', 'require("express")()');
  });

  it('runs the backend from the file its start script names', async () => {
    // With no entry the service falls back to index.js in the application
    // folder, which crashes with "Cannot find module .../backend/index.js"
    // naming a file the user never chose.
    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('workspace-monorepo');
    expect(result.manifest.app.cwd).toBe('backend');
    expect(result.manifest.app.entry).toBe('src/index.js');
  });

  it('falls back to a file that exists when nothing names one', async () => {
    await write(
      'backend/package.json',
      JSON.stringify({ name: 'backend', dependencies: { express: '^5.0.0' } }),
    );
    const result = await detectApp(tmpDir);
    expect(result.manifest.app.entry).toBe('src/index.js');
  });

  it('says so when it cannot work out the startup file', async () => {
    await fs.rm(path.join(tmpDir, 'backend', 'src'), { recursive: true, force: true });
    await write(
      'backend/package.json',
      JSON.stringify({ name: 'backend', dependencies: { express: '^5.0.0' } }),
    );

    const result = await detectApp(tmpDir);
    expect(result.manifest.app.entry).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/could not tell which file starts/i);
  });
});

describe('entryFromStartScript', () => {
  it('takes the first plain script argument', () => {
    expect(entryFromStartScript('node src/index.js')).toBe('src/index.js');
    expect(entryFromStartScript('nodemon server.js')).toBe('server.js');
    expect(entryFromStartScript('cross-env NODE_ENV=production node dist/main.js')).toBe('dist/main.js');
    expect(entryFromStartScript('node --env-file=.env -r ./hook src/app.mjs')).toBe('src/app.mjs');
  });

  it('answers nothing when the script names no file', () => {
    expect(entryFromStartScript('node .')).toBeNull();
    expect(entryFromStartScript('ts-node src/index.ts')).toBeNull();
  });
});

describe('single Express app at the repository root', () => {
  it('detects a Node app and its entry point', async () => {
    await write(
      'package.json',
      JSON.stringify({
        name: 'api',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^5.0.0' },
      }),
    );
    await write('package-lock.json', '{}');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('single-app');
    expect(result.manifest.runtime).toBe('node');
    expect(result.manifest.app.cwd).toBe('');
    expect(result.manifest.packageManager).toBe('npm');
  });
});

describe('Nuxt app', () => {
  it('uses the Nuxt server entry point and its port variable', async () => {
    await write(
      'package.json',
      JSON.stringify({
        name: 'kitora',
        scripts: { build: 'nuxt build' },
        dependencies: { nuxt: '^4.0.0' },
      }),
    );
    await write('nuxt.config.ts', 'export default defineNuxtConfig({});');
    await write('pnpm-lock.yaml', 'lockfileVersion: 9.0');

    const result = await detectApp(tmpDir);
    expect(result.manifest.runtime).toBe('node');
    expect(result.manifest.app.entry).toBe('.output/server/index.mjs');
    // Nuxt's server reads NITRO_PORT, not PORT.
    expect(result.manifest.app.portEnvVar).toBe('NITRO_PORT');
  });
});

describe('front-end only project', () => {
  it('serves it as files and adds the page-refresh fallback', async () => {
    await write(
      'package.json',
      JSON.stringify({
        name: 'spa',
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^7.0.0' },
      }),
    );
    await write('vite.config.ts', "export default { build: { outDir: 'dist' } };");

    const result = await detectApp(tmpDir);
    expect(result.manifest.runtime).toBe('static');
    // Here the fallback IS wanted: without it, refreshing on /about returns a
    // 404 because no such file exists.
    expect(result.manifest.spaFallback).toBe(true);
    expect(result.manifest.staticRoot).toBe('dist');
  });
});

describe('plain static site', () => {
  it('detects it with no build step', async () => {
    await write('index.html', '<!doctype html><title>Hi</title>');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('static');
    expect(result.manifest.runtime).toBe('static');
    expect(result.manifest.steps).toHaveLength(0);
  });
});

describe('committed winpanel.json', () => {
  it('takes precedence over detection', async () => {
    // The payoff for committing the file: later deploys need no decisions.
    await write(
      'package.json',
      JSON.stringify({ dependencies: { express: '^5.0.0' } }),
    );
    await write(
      'winpanel.json',
      JSON.stringify({
        runtime: 'node',
        app: { cwd: 'custom-folder', portEnvVar: 'MY_PORT' },
        steps: [{ name: 'Custom build', cwd: '', command: 'npm', args: ['run', 'ci'] }],
      }),
    );

    const result = await detectApp(tmpDir);
    expect(result.fromManifestFile).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.manifest.app.cwd).toBe('custom-folder');
    expect(result.manifest.app.portEnvVar).toBe('MY_PORT');
    expect(result.manifest.steps[0]?.name).toBe('Custom build');
  });

  it('falls back to detection when the file is invalid, and says so', async () => {
    await write(
      'package.json',
      JSON.stringify({ main: 'index.js', dependencies: { express: '^5.0.0' } }),
    );
    await write('winpanel.json', JSON.stringify({ app: { cwd: '../../etc' } }));

    const result = await detectApp(tmpDir);
    expect(result.fromManifestFile).toBe(false);
    expect(result.notes.join(' ')).toMatch(/could not be read/i);
  });
});

describe('a repository whose only Node app is a sub-folder', () => {
  // No package.json at the root, and a Vite config whose output folder is
  // built with fileURLToPath rather than written as a plain string.
  beforeEach(async () => {
    await write('TaskbarQuest.sln', '# a solution file, not a Node project');
    await write(
      'web/package.json',
      JSON.stringify({ name: 'web', scripts: { build: 'vite build' }, devDependencies: { vite: '^7.0.0' } }),
    );
    await write(
      'web/vite.config.ts',
      `import { fileURLToPath, URL } from 'node:url';
       export default defineConfig({
         build: {
           outDir: fileURLToPath(new URL('../server/web-dist', import.meta.url)),
           emptyOutDir: true,
         },
       });`,
    );
    await write(
      'server/package.json',
      JSON.stringify({
        name: 'server',
        main: 'app.js',
        scripts: { start: 'node app.js' },
        dependencies: { express: '^5.0.0' },
      }),
    );
    await write('server/app.js', 'require("express")()');
  });

  it('follows an outDir wrapped in a call, so it is the primary layout', async () => {
    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('frontend-builds-into-backend');
    expect(result.manifest.app.cwd).toBe('server');
    expect(result.manifest.app.entry).toBe('app.js');
  });

  it('still finds the app when the output folder cannot be read at all', async () => {
    await write('web/vite.config.ts', 'export default defineConfig({ plugins: [vue()] });');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('multi-folder');
    expect(result.manifest.app.cwd).toBe('server');
    expect(result.manifest.app.entry).toBe('app.js');
    // Without steps the deploy installs nothing and the app cannot start.
    expect(result.manifest.steps.length).toBeGreaterThan(0);
  });
});

describe('other layouts that must not fall through to unrecognised', () => {
  it('picks one of two runnable folders and says the other exists', async () => {
    await write(
      'api/package.json',
      JSON.stringify({ name: 'api', scripts: { start: 'node index.js' } }),
    );
    await write('api/index.js', '');
    await write(
      'server/package.json',
      JSON.stringify({ name: 'server', dependencies: { express: '^5.0.0' } }),
    );
    await write('server/app.js', '');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('multi-folder');
    // CANDIDATE_FOLDERS is ordered, so "server" is preferred over "api".
    expect(result.manifest.app.cwd).toBe('server');
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.notes.join(' ')).toMatch(/api could also run this site/i);
  });

  it('treats a backend folder with no start script and no framework as the app', async () => {
    await write('backend/package.json', JSON.stringify({ name: 'backend' }));
    await write('backend/index.js', '');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('multi-folder');
    expect(result.manifest.app.cwd).toBe('backend');
    expect(result.manifest.app.entry).toBe('index.js');
  });

  it('builds and serves a project that is only a frontend in a sub-folder', async () => {
    await write(
      'client/package.json',
      JSON.stringify({ name: 'client', scripts: { build: 'vite build' } }),
    );
    await write('client/vite.config.ts', `export default defineConfig({ build: { outDir: 'out' } });`);

    const result = await detectApp(tmpDir);
    expect(result.manifest.runtime).toBe('static');
    expect(result.manifest.staticRoot).toBe('client/out');
    // Refreshing on a sub-page of a built single-page app must not 404.
    expect(result.manifest.spaFallback).toBe(true);
    expect(result.manifest.steps.map((step) => step.cwd)).toEqual(['client', 'client']);
  });

  it('assumes dist, and says so, when the frontend output cannot be read', async () => {
    await write(
      'client/package.json',
      JSON.stringify({ name: 'client', scripts: { build: 'vite build' } }),
    );
    await write('client/vite.config.ts', 'export default defineConfig({ plugins: [] });');

    const result = await detectApp(tmpDir);
    expect(result.manifest.staticRoot).toBe('client/dist');
    expect(result.notes.join(' ')).toMatch(/could not be read/i);
  });
});

describe('unrecognised project', () => {
  it('says so honestly rather than guessing', async () => {
    await write('README.md', '# Just some docs');

    const result = await detectApp(tmpDir);
    expect(result.shape).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.notes.join(' ')).toMatch(/fill in the details yourself/i);
  });
});

describe('extractOutputDir', () => {
  it('reads the output folder from various config styles', () => {
    expect(extractOutputDir("build: { outDir: '../backend/public' }")).toBe('../backend/public');
    expect(extractOutputDir('outputDir: "dist"')).toBe('dist');
    expect(extractOutputDir('"outputPath": "dist/app"')).toBe('dist/app');
    expect(
      extractOutputDir("outDir: fileURLToPath(new URL('../server/web-dist', import.meta.url))"),
    ).toBe('../server/web-dist');
  });

  it('returns null when there is nothing to find', () => {
    expect(extractOutputDir('export default {};')).toBeNull();
  });

  it('never evaluates the config file', () => {
    // These files come from an untrusted repository, so they are matched with
    // a regex and never executed.
    const hostile = "outDir: '../x'; process.exit(1);";
    expect(extractOutputDir(hostile)).toBe('../x');
  });
});
