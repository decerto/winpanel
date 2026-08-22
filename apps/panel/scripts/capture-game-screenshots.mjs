import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Captures the Game Servers pages for the README and docs.
 *
 * The images are rendered from the real built panel against a seeded demo
 * instance, so they show the actual UI rather than a mockup. The demo data is
 * invented on purpose: no real domain, customer, or game account appears in
 * them.
 *
 * Run from the panel package with `node scripts/capture-game-screenshots.mjs`.
 * The agent must be running on the demo port with a seeded database that has game
 * servers enabled and a few demo servers in it — `node ../agent/scripts/demo-seed.mjs`
 * from the repo root, then start the agent with the environment it prints.
 */

const PANEL_URL = process.env.PANEL_URL ?? 'http://127.0.0.1:18443';
const OUT_DIR = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'screenshots');

const DEMO_SERVERS = [
  {
    slug: 'nomad',
    displayName: 'Nomad',
    catalogId: 'nomad-dedicated',
    state: 'running',
    version: '1.0.0',
    ports: [
      { name: 'game', protocol: 'tcp', purpose: 'game', visibility: 'public', port: 25565 },
    ],
  },
  {
    slug: 'palworld',
    displayName: 'Palworld',
    catalogId: 'palworld-dedicated',
    state: 'running',
    version: 'latest',
    ports: [
      { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 8211 },
      { name: 'query', protocol: 'udp', purpose: 'query', visibility: 'public', port: 27015 },
    ],
  },
  {
    slug: 'zomboid',
    displayName: 'Project Zomboid',
    catalogId: 'zomboid-dedicated',
    state: 'stopped',
    version: '42.20.0',
    ports: [
      { name: 'game', protocol: 'udp', purpose: 'game', visibility: 'public', port: 16261 },
      { name: 'direct', protocol: 'udp', purpose: 'query', visibility: 'public', port: 16262 },
    ],
  },
];

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('console', (msg) => console.log('BROWSER:', msg.text()));
  page.on('pageerror', (err) => console.error('BROWSER ERROR:', err.message));

  // Sign in as the demo account the seed created.
  await page.goto(`${PANEL_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'demo');
  await page.fill('#password', 'a-password-long-enough');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/sites', { timeout: 10_000 });

  // The library page is the one that sells the feature: the catalog grid,
  // the ready/planned split, and the selected-game panel.
  await page.goto(`${PANEL_URL}/game-servers/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.grid', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(OUT_DIR, 'game-servers-library.png'),
    fullPage: false,
  });

  // The detail page shows the lifecycle controls, console, and connection
  // panel — the things a server owner actually uses after install.
  await page.goto(`${PANEL_URL}/game-servers/nomad`, { waitUntil: 'networkidle' });
  // Wait for the server to load by looking for the StatusBadge with the state,
  // which only appears when the server data has been fetched successfully.
  await page.waitForSelector('.badge', { timeout: 10_000 });
  // Wait for the error state to clear — the page shows "not found" while loading.
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('Nomad') && !text.includes('not found');
  }, { timeout: 10_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(OUT_DIR, 'game-server-detail.png'),
    fullPage: false,
  });

  // The People page shows the game-access picker, which is the multi-user
  // story: one account can create one server of any supported game, or be
  // restricted to a catalog.
  await page.goto(`${PANEL_URL}/people`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Add someone', { timeout: 10_000 });
  await page.click('text=Add someone');
  await page.waitForSelector('text=Game access', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(OUT_DIR, 'people-game-access.png'),
    fullPage: false,
  });

  await browser.close();
  process.stdout.write(`Captured screenshots to ${OUT_DIR}\n`);
}

main().catch((error) => {
  process.stderr.write(`Screenshot capture failed: ${error.message}\n`);
  process.exit(1);
});
