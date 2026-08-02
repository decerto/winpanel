import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the rule that the panel never reaches out to the internet.
 *
 * Two reasons this matters. The panel has to render correctly on a firewalled
 * server with no outbound access, which is exactly the situation you are in
 * when something has gone wrong. And an admin panel that fetches fonts from a
 * CDN tells that CDN the address of every server it is installed on.
 *
 * Skips when the bundle has not been built, so it never blocks a plain
 * `vitest run` during development.
 */

const DIST = path.join(import.meta.dirname, '..', 'dist');

/**
 * Origins that appear as literal strings but are never *fetched*.
 *
 * Two categories, deliberately kept separate in intent:
 *  - namespaces and library error-message links, which are inert
 *  - deep links the user clicks on purpose, such as "create an access token"
 *
 * The rule being enforced is that the panel loads no external assets. A link
 * the user chooses to follow is not the same thing as the page reaching out on
 * its own, and conflating the two makes this test cry wolf.
 */
const ALLOWED_ORIGINS = [
  // XML/SVG namespaces
  'http://www.w3.org',
  // Library error messages
  'https://vuejs.org',
  'https://github.com',
  // User-initiated help links (create an access token)
  'https://gitlab.com',
  'https://bitbucket.org',
  // User-initiated link to the hosting control panel, where outbound mail is
  // unblocked and reverse DNS is set — neither of which this panel can do.
  'https://www.ovh.com',
  // Certificate authority, referenced by the connectivity check only
  'https://acme-v02.api.letsencrypt.org',
];

/** Patterns that mean the browser would actually fetch something. */
const ASSET_FETCH_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /@import\s+(?:url\()?['"]?https?:\/\//i, description: 'CSS @import' },
  { pattern: /url\(\s*['"]?https?:\/\//i, description: 'CSS url()' },
  { pattern: /<link[^>]+href\s*=\s*['"]https?:\/\//i, description: '<link href>' },
  { pattern: /<script[^>]+src\s*=\s*['"]https?:\/\//i, description: '<script src>' },
  { pattern: /fonts\.(?:googleapis|gstatic)\.com/i, description: 'Google Fonts' },
  { pattern: /cdnjs\.cloudflare\.com|unpkg\.com|jsdelivr\.net/i, description: 'a CDN' },
];

async function bundleFiles(): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(js|css|html)$/.test(entry.name)) found.push(full);
    }
  };

  await walk(DIST);
  return found;
}

async function distExists(): Promise<boolean> {
  try {
    await fs.access(DIST);
    return true;
  } catch {
    return false;
  }
}

describe('built panel bundle', () => {
  it('never fetches an asset from an external origin', async () => {
    // The rule that matters: the panel has to render correctly on a
    // firewalled server with no outbound access, which is exactly the
    // situation you are in when something has gone wrong.
    if (!(await distExists())) return;

    const files = await bundleFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');

      for (const { pattern, description } of ASSET_FETCH_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${path.basename(file)} loads ${description}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('references no undocumented external origins', async () => {
    // A softer net than the asset check: catches a new outbound link slipping
    // in unnoticed, without failing simply because the user can click it.
    if (!(await distExists())) return;

    const unexpected = new Set<string>();

    for (const file of await bundleFiles()) {
      const content = await fs.readFile(file, 'utf8');

      for (const match of content.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []) {
        if (match.includes('localhost') || match.includes('127.0.0.1')) continue;
        if (ALLOWED_ORIGINS.some((allowed) => match.startsWith(allowed))) continue;
        unexpected.add(match);
      }
    }

    expect([...unexpected]).toEqual([]);
  });

  it('does not load fonts from a CDN', async () => {
    if (!(await distExists())) return;

    for (const file of await bundleFiles()) {
      const content = await fs.readFile(file, 'utf8');
      expect(content, path.basename(file)).not.toMatch(
        /fonts\.googleapis|fonts\.gstatic|use\.typekit|cdnjs\.cloudflare/i,
      );
    }
  });

  it('tells search engines not to index the panel', async () => {
    if (!(await distExists())) return;

    const html = await fs.readFile(path.join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('noindex');
  });
});
