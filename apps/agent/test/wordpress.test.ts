import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWpConfig,
  generateSalts,
  rewriteWpConfigPassword,
  wordpressDatabaseName,
} from '../src/sites/wordpress.js';

/**
 * The one file WordPress cannot start without.
 *
 * Written out as a string, so the test reads it the way WordPress would:
 * the database details present, the salts in place, and a table prefix that
 * is not the `wp_` every automated attack tries first.
 */
describe('buildWpConfig', () => {
  const salts = "define('AUTH_KEY', 'a-secret');\ndefine('SECURE_AUTH_KEY', 'another');";

  it('writes the database details WordPress connects with', () => {
    const config = buildWpConfig({
      database: 'wp_abc123',
      username: 'wp_abc123',
      password: 's3cret',
      tablePrefix: 'wp_x1y2z3_',
      salts,
    });

    expect(config).toContain("define('DB_NAME', 'wp_abc123');");
    expect(config).toContain("define('DB_USER', 'wp_abc123');");
    expect(config).toContain("define('DB_PASSWORD', 's3cret');");
    expect(config).toContain("define('DB_HOST', '127.0.0.1:3306');");
    expect(config).toContain("$table_prefix = 'wp_x1y2z3_';");
    expect(config).toContain(salts);
  });

  it('escapes a single quote in the password so the file still parses', () => {
    const config = buildWpConfig({
      database: 'wp_abc123',
      username: 'wp_abc123',
      password: "it's-a-secret",
      tablePrefix: 'wp_x_',
      salts,
    });

    // An unescaped quote would end the string early and break the whole file.
    expect(config).toContain("define('DB_PASSWORD', 'it\\'s-a-secret');");
  });
});

describe('wordpressDatabaseName', () => {
  it('is derived from the site id, so a renamed site keeps its database', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const name = wordpressDatabaseName(id);

    expect(name).toMatch(/^wp_[a-z0-9]+$/);
    expect(name).toContain('f47ac10b');
    // No hyphens: a database name with one would be a syntax error in SQL.
    expect(name).not.toContain('-');
  });

  it('is stable for the same site', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(wordpressDatabaseName(id)).toBe(wordpressDatabaseName(id));
  });
});

/**
 * Salts are generated locally, never fetched. Fetching them would paste text
 * from the network into a PHP file that then runs, so the test that matters
 * is that the output is eight valid, unique, self-contained define lines.
 */
describe('generateSalts', () => {
  it('produces the eight keys WordPress expects, each a define', () => {
    const salts = generateSalts();
    for (const key of [
      'AUTH_KEY',
      'SECURE_AUTH_KEY',
      'LOGGED_IN_KEY',
      'NONCE_KEY',
      'AUTH_SALT',
      'SECURE_AUTH_SALT',
      'LOGGED_IN_SALT',
      'NONCE_SALT',
    ]) {
      expect(salts).toContain(`define('${key}', '`);
    }
  });

  it('never produces the same set twice', () => {
    expect(generateSalts()).not.toBe(generateSalts());
  });
});

/**
 * Changing a database password must reach wp-config.php, or the site goes
 * offline the moment the old password stops working. Written to a real file,
 * so the test sees exactly what WordPress would read back.
 */
describe('rewriteWpConfigPassword', () => {
  async function withSite(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-wp-'));
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('replaces the password and leaves the rest of the file alone', async () => {
    await withSite(async (dir) => {
      const original = buildWpConfig({
        database: 'wp_abc123',
        username: 'wp_abc123',
        password: 'old-secret',
        tablePrefix: 'wp_x_',
        salts: "define('AUTH_KEY', 'keep-me');",
      });
      await fs.writeFile(path.join(dir, 'wp-config.php'), original);

      const changed = await rewriteWpConfigPassword(dir, 'new-secret');

      expect(changed).toBe(true);
      const updated = await fs.readFile(path.join(dir, 'wp-config.php'), 'utf8');
      expect(updated).toContain("define('DB_PASSWORD', 'new-secret');");
      expect(updated).not.toContain('old-secret');
      // Salts and the table prefix are WordPress' session and schema: untouched.
      expect(updated).toContain("define('AUTH_KEY', 'keep-me');");
      expect(updated).toContain("$table_prefix = 'wp_x_';");
    });
  });

  it('escapes a quote in the new password so the file still parses', async () => {
    await withSite(async (dir) => {
      const original = buildWpConfig({
        database: 'wp_abc123',
        username: 'wp_abc123',
        password: 'old-secret',
        tablePrefix: 'wp_x_',
        salts: "define('AUTH_KEY', 'keep-me');",
      });
      await fs.writeFile(path.join(dir, 'wp-config.php'), original);

      await rewriteWpConfigPassword(dir, "it's-new");

      const updated = await fs.readFile(path.join(dir, 'wp-config.php'), 'utf8');
      expect(updated).toContain("define('DB_PASSWORD', 'it\\'s-new');");
    });
  });

  it('leaves a file it did not write — one without the line — untouched', async () => {
    await withSite(async (dir) => {
      const handwritten = '<?php\n// Hand-edited; no DB_PASSWORD line here.\n';
      await fs.writeFile(path.join(dir, 'wp-config.php'), handwritten);

      const changed = await rewriteWpConfigPassword(dir, 'new-secret');

      expect(changed).toBe(false);
      expect(await fs.readFile(path.join(dir, 'wp-config.php'), 'utf8')).toBe(handwritten);
    });
  });

  it('reports false when there is no configuration to change', async () => {
    await withSite(async (dir) => {
      expect(await rewriteWpConfigPassword(dir, 'new-secret')).toBe(false);
    });
  });
});
