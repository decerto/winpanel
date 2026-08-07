import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
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
const WINSW_LICENSE_URL =
  `https://raw.githubusercontent.com/winsw/winsw/v${WINSW_VERSION}/LICENSE.txt`;

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

  // WinSW is MIT, which requires its notice to travel with the binary. Only
  // the .exe is published on the release, so the notice is fetched from the
  // tag it was built from.
  await download(WINSW_LICENSE_URL, path.join(STAGING, 'bin', 'WinSW.LICENSE.txt'));

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
  const target = path.join(STAGING, 'agent');

  /*
   * `pnpm deploy` resolves the workspace's symlinked node_modules into a real,
   * self-contained folder. That matters twice over: Inno Setup cannot follow
   * symlinks, and the workspace links point at paths that do not exist on the
   * target machine.
   *
   * It is staged to a scratch folder first because deploy insists on an empty
   * destination and lays the package out as it exists in the repo — dist/ and
   * all — whereas the service expects the compiled entry point at the root of
   * the agent folder.
   */
  const scratch = path.join(INSTALLER_DIR, '.cache', 'agent-deploy');
  await fs.rm(scratch, { recursive: true, force: true });

  await log('Resolving production dependencies\u2026');
  try {
    /*
     * The hoisted linker is not a preference, it is a requirement. pnpm's
     * default layout is a farm of symlinks into a virtual store, and Inno
     * Setup cannot follow those. Copying through the links instead produces
     * package folders detached from the store they resolve their own
     * dependencies through, which fails at the second level down. Hoisted
     * gives a flat tree of real directories that can simply be copied.
     *
     * pnpm is a shell script on Windows, so this has to go through a shell,
     * and a shell concatenates the arguments rather than passing them
     * separately. The destination is therefore quoted here: an install path
     * containing a space would otherwise be split into several arguments and
     * the deploy would fail with a message that points nowhere near the cause.
     */
    await run(
      'pnpm',
      [
        '--filter',
        '@winpanel/agent',
        'deploy',
        '--prod',
        '--legacy',
        '--config.node-linker=hoisted',
        `"${scratch}"`,
      ],
      { cwd: REPO_ROOT, shell: true },
    );
  } catch (error) {
    // Previously this was swallowed, which produced an installer that looked
    // fine and shipped an agent with no dependencies at all. The service then
    // died on its first import, before it could log anything useful.
    const detail = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new Error(`Could not resolve the agent's production dependencies.\n${detail}`);
  }

  const agentDist = path.join(scratch, 'dist');
  try {
    await fs.access(path.join(agentDist, 'index.js'));
  } catch {
    throw new Error('The agent has not been built yet. Run "pnpm build" first.');
  }

  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });

  /*
   * Only what runs is copied, and dist/ keeps its place in the tree.
   *
   * Flattening dist/ into the root of the agent folder was tried and broke the
   * database migrations: the agent locates them relative to its own module
   * directory, which is right in the repo and in dist/ but pointed one level
   * too high once the files moved. One layout everywhere means a path that
   * works in development also works once installed.
   *
   * Copying deploy's output wholesale is equally wrong: it carries src/,
   * test/ and tsconfig.json, which bloats the installer with source nobody
   * installs and leaves stray test files where other tools find them.
   *
   * package.json comes from deploy, and already declares "type": "module".
   * Without it Node parses the ESM build as CommonJS.
   */
  for (const entry of ['dist', 'node_modules', 'package.json']) {
    await fs.cp(path.join(scratch, entry), path.join(target, entry), { recursive: true });
  }

  // Migrations are read at runtime and live outside dist. Copied explicitly
  // rather than assumed, since what deploy carries depends on how the package
  // is packed.
  await fs.cp(
    path.join(REPO_ROOT, 'apps', 'agent', 'drizzle'),
    path.join(target, 'drizzle'),
    { recursive: true },
  );

  await fs.rm(scratch, { recursive: true, force: true });
  await ensureNativeAbi(target);
  await log('Staged the agent and its dependencies.');
}

/**
 * Replaces native binaries built against the wrong Node.
 *
 * Dependencies are resolved by whichever Node runs this build, but the
 * installer ships its own. Building on Node 24 while bundling Node 22 produces
 * an agent that installs perfectly and then dies the moment it opens its
 * database, with a NODE_MODULE_VERSION mismatch — on the user's server, not
 * here.
 *
 * Only better-sqlite3 is affected. @node-rs/argon2 is a napi-rs build, and
 * napi binaries are ABI-stable across Node versions by design.
 */
async function ensureNativeAbi(target: string): Promise<void> {
  const node = path.join(STAGING, 'bin', 'node', 'node.exe');
  const { stdout } = await run(node, ['-p', 'process.versions.modules']);
  const abi = stdout.trim();

  if (abi === process.versions.modules) return;

  await log(
    `Bundled runtime needs ABI ${abi}, this build produced ${process.versions.modules}.`,
  );

  const packageDir = path.join(target, 'node_modules', 'better-sqlite3');
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'),
  ) as { version: string };

  const name = `better-sqlite3-v${manifest.version}-node-v${abi}-win32-x64.tar.gz`;
  const archive = path.join(INSTALLER_DIR, '.cache', name);

  await log(`Fetching ${name}\u2026`);
  await download(
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${manifest.version}/${name}`,
    archive,
  );

  // The archive holds build/Release/better_sqlite3.node, so unpacking it over
  // the package directory replaces precisely the binary that is wrong.
  await run('tar', ['-xzf', archive, '-C', packageDir]);
  await log('Replaced the native binary to match the bundled runtime.');
}

/**
 * Starts the staged agent for real and waits for it to serve.
 *
 * Importing the dependencies was not enough. better-sqlite3 binds its native
 * addon lazily, on the first database call, so an import check passed happily
 * while the shipped binary was built for a different Node ABI. The migrations
 * folder had the same shape of problem: nothing resolves it until the database
 * is opened.
 *
 * The only check that catches this class of fault is running the thing. It is
 * pointed at a throwaway root and an unused port, so it cannot touch a real
 * installation on the build machine.
 */
async function verifyAgent(): Promise<void> {
  const target = path.join(STAGING, 'agent');
  const node = path.join(STAGING, 'bin', 'node', 'node.exe');
  const scratch = path.join(INSTALLER_DIR, '.cache', 'verify');
  const port = 18_443;

  await log('Starting the staged agent\u2026');
  await fs.rm(scratch, { recursive: true, force: true });

  const agent = spawn(node, [path.join(target, 'dist', 'index.js')], {
    cwd: target,
    env: {
      ...process.env,
      WINPANEL_ROOT: scratch,
      WINPANEL_SITES_ROOT: path.join(scratch, 'sites'),
      WINPANEL_PORT: String(port),
      WINPANEL_HOST: '127.0.0.1',
      WINPANEL_LOG_LEVEL: 'error',
    },
  });

  let output = '';
  agent.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  agent.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<number>((resolve) => {
    agent.on('exit', (code) => resolve(code ?? 0));
  });

  try {
    const listening = await waitForPort(port, exited);
    if (!listening) {
      throw new Error(
        `The staged agent did not start.\n${output.trim() || '(it produced no output)'}`,
      );
    }
  } finally {
    agent.kill();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  await log('Agent starts and serves.');
}

/** Resolves true once the port accepts a connection, false if the agent dies. */
async function waitForPort(port: number, exited: Promise<number>): Promise<boolean> {
  let dead = false;
  void exited.then(() => (dead = true));

  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (dead) return false;

    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
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

  await verifyAgent();

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
