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
 * Compiles the staged bundle into the distributable installer.
 *
 * Kept as a script rather than a line in the README because a release step
 * nobody can run twice the same way is a release step that eventually ships
 * something nobody intended. The Inno Setup compiler is fetched and pinned
 * here for the same reason the Node runtime is pinned in build-bundle.ts.
 */

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(INSTALLER_DIR, '..', '..');
const STAGING = path.join(INSTALLER_DIR, 'staging');
const CACHE = path.join(INSTALLER_DIR, '.cache');

/** Pinned so a release is reproducible and cannot drift silently. */
const INNO_VERSION = '6.7.3';
const INNO_URL =
  `https://github.com/jrsoftware/issrc/releases/download/is-${INNO_VERSION.replace(/\./g, '_')}/innosetup-${INNO_VERSION}.exe`;
/**
 * JRSoftware publish no checksum, relying on Authenticode instead, so this is
 * recorded from a verified download. Update it together with INNO_VERSION.
 */
const INNO_SHA256 = '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732';
/** The publisher named on jrsoftware.org's download page. */
const INNO_SIGNER = 'Pyrsys B.V.';

async function log(message: string): Promise<void> {
  process.stdout.write(`  ${message}\n`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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
 * Confirms the download is the signed original rather than something that
 * merely arrived over the same URL. The hash catches a changed file; the
 * signature catches a hash that was updated without anyone checking what it
 * was updated to.
 */
async function verifySignature(file: string): Promise<void> {
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}';` +
      `Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject`,
  ]);

  const [status = '', subject = ''] = stdout.trim().split(/\r?\n/);

  if (status.trim() !== 'Valid') {
    throw new Error(`The Inno Setup download is not validly signed (status: ${status.trim()}).`);
  }
  if (!subject.includes(INNO_SIGNER)) {
    throw new Error(
      `The Inno Setup download is signed by an unexpected publisher.\n` +
        `  expected ${INNO_SIGNER}\n  actual   ${subject.trim()}`,
    );
  }
}

/** Looks for a compiler already on this machine before fetching one. */
async function findInstalledCompiler(): Promise<string | undefined> {
  const candidates = [
    path.join(CACHE, 'inno', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function ensureCompiler(): Promise<string> {
  const installed = await findInstalledCompiler();
  if (installed) {
    await log(`Using the Inno Setup compiler at ${installed}`);
    return installed;
  }

  const target = path.join(CACHE, 'inno');
  const setup = path.join(CACHE, `innosetup-${INNO_VERSION}.exe`);

  await log(`Downloading Inno Setup ${INNO_VERSION}\u2026`);
  const actual = await download(INNO_URL, setup);

  if (actual !== INNO_SHA256) {
    await fs.rm(setup, { force: true });
    throw new Error(
      `Inno Setup download did not match its pinned checksum.\n` +
        `  expected ${INNO_SHA256}\n  actual   ${actual}`,
    );
  }

  await verifySignature(setup);
  await log('Checksum and signature verified.');

  /*
   * Installed for the current user only. A build tool has no business
   * requiring an elevation prompt, and /CURRENTUSER keeps this out of the
   * machine-wide install so it cannot collide with a developer's own copy.
   */
  await run(setup, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/NOICONS',
    '/CURRENTUSER',
    `/DIR=${target}`,
  ]);

  const compiler = path.join(target, 'ISCC.exe');
  if (!(await exists(compiler))) {
    throw new Error('Inno Setup reported success but no compiler was installed.');
  }

  await log('Installed the Inno Setup compiler.');
  return compiler;
}

/**
 * The version stamped into the installer.
 *
 * A release is built from a tag, and the tag is the authority on what version
 * it is; the workspace manifest is only the fallback for local builds. Taking
 * it from the manifest during a release would silently ship v1.2.3 stamped
 * with whatever the repo happened to say.
 */
async function resolveVersion(): Promise<string> {
  const fromEnv = process.env['WINPANEL_VERSION']?.trim();
  if (fromEnv) return fromEnv.replace(/^v/, '');

  const manifest = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };

  return manifest.version;
}

async function main(): Promise<void> {
  process.stdout.write('\nCompiling the WinPanel installer\n\n');

  // The staged agent is what actually gets installed, so an empty or stale
  // staging folder must not quietly produce an installer.
  if (!(await exists(path.join(STAGING, 'agent', 'index.js')))) {
    throw new Error('Nothing is staged. Run "pnpm bundle" first.');
  }
  if (!(await exists(path.join(STAGING, 'agent', 'node_modules')))) {
    throw new Error('The staged agent has no dependencies. Run "pnpm bundle" first.');
  }

  const compiler = await ensureCompiler();
  const version = await resolveVersion();

  await log(`Compiling version ${version}\u2026`);
  const { stdout } = await run(
    compiler,
    [`/DAppVersion=${version}`, path.join(INSTALLER_DIR, 'winpanel.iss')],
    { maxBuffer: 32 * 1024 * 1024 },
  );

  const output = /Resulting Setup program filename is:\s*\r?\n(.+)/.exec(stdout)?.[1]?.trim();
  process.stdout.write(`\nInstaller built:\n  ${output ?? path.join(REPO_ROOT, 'dist')}\n\n`);
}

main().catch((error: unknown) => {
  const detail = (error as { stderr?: string }).stderr?.trim();
  process.stderr.write(
    `\nInstaller build failed: ${(error as Error).message}\n${detail ? `${detail}\n` : ''}\n`,
  );
  process.exit(1);
});
