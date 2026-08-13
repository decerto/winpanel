import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectApp, detectPhp } from '../src/detect/detector.js';

/**
 * PHP detection.
 *
 * A wrong call here is worse than no call: a Node repo misread as PHP would
 * never build. So the fixtures are the layouts a PHP project actually has,
 * plus the Node project that happens to ship a PHP file and must not match.
 */

let tmpDir: string;

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(tmpDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-php-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PHP detection', () => {
  it('uses public/ as the web root when it has the index.php', async () => {
    await write('public/index.php', '<?php echo "hi";');
    await write('composer.json', JSON.stringify({ require: { php: '>=8.2' } }));

    const result = await detectPhp(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.documentRoot).toBe('public');
    // A framework's config and vendor files live above public/ and must not
    // be served, which is exactly why the web root is public/.
  });

  it('uses the repository root when index.php is there', async () => {
    await write('index.php', '<?php echo "hi";');

    const result = await detectPhp(tmpDir);

    expect(result!.documentRoot).toBe('');
    expect(result!.confidence).toBeGreaterThan(0.8);
  });

  it('installs Composer packages on deploy when the project asks for them', async () => {
    await write('index.php', '<?php');
    await write('composer.json', JSON.stringify({ require: { 'laravel/framework': '^11.0' } }));

    const result = await detectPhp(tmpDir);

    expect(result!.steps).toHaveLength(1);
    expect(result!.steps[0]!.command).toBe('composer');
  });

  it('recognises WordPress and says so', async () => {
    await write('index.php', '<?php');
    await write('wp-config-sample.php', '<?php');
    await write('wp-content/themes/.gitkeep', '');

    const result = await detectPhp(tmpDir);

    expect(result!.summary).toMatch(/WordPress/i);
    expect(result!.notes.some((note) => /WordPress/.test(note))).toBe(true);
  });

  it('returns null for a Node project with no PHP entry point', async () => {
    await write('package.json', JSON.stringify({ name: 'app', main: 'server.js' }));
    await write('server.js', 'require("http").createServer().listen(3000);');

    expect(await detectPhp(tmpDir)).toBeNull();
  });

  it('detectApp routes a PHP repo to the php runtime', async () => {
    await write('public/index.php', '<?php phpinfo();');

    const result = await detectApp(tmpDir);

    expect(result.manifest.runtime).toBe('php');
    expect(result.manifest.app.cwd).toBe('public');
  });

  it('still detects PHP when a package.json is present for the theme build', async () => {
    // The common real-world shape: a PHP app whose frontend is built with a
    // Node toolchain. The package.json must not pull it into the Node flow.
    await write('index.php', '<?php require "app.php";');
    await write(
      'package.json',
      JSON.stringify({ name: 'theme', scripts: { build: 'vite build' } }),
    );

    const result = await detectApp(tmpDir);

    expect(result.manifest.runtime).toBe('php');
  });
});
