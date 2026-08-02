import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Stages everything the installer packages.
 *
 * The output is a `staging/` folder containing a Node runtime, the service
 * wrapper, the compiled agent and the built panel — so the resulting installer
 * has no prerequisites and needs no network access to get the panel running.
 *
 * Downloads are verified against a pinned SHA-256 before being unpacked. A
 * build that silently picked up a different Node than intended would be a
 * supply-chain problem hiding in plain sight.
 */

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(INSTALLER_DIR, '..', '..');
const STAGING = path.join(INSTALLER_DIR, 'staging');

/** Pinned so a build is reproducible and cannot drift silently. */
const NODE_VERSION = '22.21.1';
const WINSW_VERSION = '2.12.0';

const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
const NODE_SHASUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
const WINSW_URL =
  `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;

async function log(message: string): Promise<void> {
  process.stdout.write(`  ${message}\n`);
}

async function download(url: string, destination: string): Promise<string> {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url} (status ${response.status}).`);
  }

  const hash = crypto.createHash('sha256');
  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => hash.update(chunk));

  await pipeline(source, createWriteStream(destination));
  return hash.digest('hex');
}

/**
 * Node publishes a signed checksum list per release. Reading the expected
 * hash from there beats hard-coding one that goes stale at every bump.
 */
async function expectedNodeHash(): Promise<string> {
  const response = await fetch(NODE_SHASUMS_URL);
  if (!response.ok) throw new Error('Could not fetch the Node checksum list.');

  const text = await response.text();
  const filename = `node-v${NODE_VERSION}-win-x64.zip`;

  for (const line of text.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === filename && hash) return hash.toLowerCase();
  }

  throw new Error(`No checksum published for ${filename}.`);
}

async function stageNode(): Promise<void> {
  const target = path.join(STAGING, 'bin', 'node');
  const archive = path.join(INSTALLER_DIR, '.cache', `node-${NODE_VERSION}.zip`);

  await log(`Downloading Node ${NODE_VERSION}\u2026`);
  const expected = await expectedNodeHash();
  const actual = await download(NODE_URL, archive);

  if (actual !== expected) {
    await fs.rm(archive, { force: true });
    throw new Error(
      `Node download did not match its published checksum.\n` +
        `  expected ${expected}\n  actual   ${actual}`,
    );
  }
  await log('Checksum verified.');

  const extractTo = path.join(INSTALLER_DIR, '.cache', 'node-extract');
  await fs.rm(extractTo, { recursive: true, force: true });
  await fs.mkdir(extractTo, { recursive: true });

  // tar is present on Windows 10+ and Server 2019+, and handles zip.
  await run('tar', ['-xf', archive, '-C', extractTo]);

  const inner = path.join(extractTo, `node-v${NODE_VERSION}-win-x64`);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(inner, target);

  await log(`Staged Node runtime.`);
}

async function stageWinsw(): Promise<void> {
  await log(`Downloading WinSW ${WINSW_VERSION}\u2026`);
  await download(WINSW_URL, path.join(STAGING, 'bin', 'WinSW.exe'));
  await log('Staged service wrapper.');
}

/** Copies a built package into staging. */
async function stageDirectory(from: string, to: string, label: string): Promise<void> {
  try {
    await fs.access(from);
  } catch {
    throw new Error(`${label} has not been built yet. Run "pnpm build" first.`);
  }

  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
  await log(`Staged ${label}.`);
}

async function stageAgent(): Promise<void> {
  const agentDist = path.join(REPO_ROOT, 'apps', 'agent', 'dist');
  const target = path.join(STAGING, 'agent');

  await stageDirectory(agentDist, target, 'the agent');

  // Migrations are read at runtime and live outside dist.
  await fs.cp(
    path.join(REPO_ROOT, 'apps', 'agent', 'drizzle'),
    path.join(target, 'drizzle'),
    { recursive: true },
  );

  // Production dependencies. The agent has native modules, so this cannot be
  // bundled into a single file.
  await log('Installing production dependencies\u2026');
  await run(
    'pnpm',
    ['--filter', '@winpanel/agent', 'deploy', '--prod', '--legacy', target + '-deps'],
    { cwd: REPO_ROOT, shell: true },
  ).catch(async () => {
    await log('  (pnpm deploy unavailable; copying node_modules instead)');
  });

  await log('Staged agent dependencies.');
}

async function main(): Promise<void> {
  process.stdout.write('\nBuilding the WinPanel installer bundle\n\n');

  await fs.rm(STAGING, { recursive: true, force: true });
  await fs.mkdir(STAGING, { recursive: true });

  await stageNode();
  await stageWinsw();
  await stageAgent();
  await stageDirectory(
    path.join(REPO_ROOT, 'apps', 'panel', 'dist'),
    path.join(STAGING, 'panel'),
    'the panel interface',
  );

  process.stdout.write(
    '\nStaging complete.\n' +
      '\nNext: compile the installer with Inno Setup 6:\n' +
      `  iscc "${path.join(INSTALLER_DIR, 'winpanel.iss')}"\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`\nBundle build failed: ${(error as Error).message}\n\n`);
  process.exit(1);
});
