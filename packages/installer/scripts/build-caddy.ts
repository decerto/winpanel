import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Builds the Caddy program the installer ships, with the Cloudflare DNS module.
 *
 * Caddy's official releases have no DNS provider modules, and the build service
 * on caddyserver.com is not always reachable. So the installer carries its own
 * build, made here with xcaddy from pinned versions. This needs a Go toolchain
 * on PATH. Everything xcaddy fetches and installs stays under `.cache/`.
 *
 * The output is picked up by `build-bundle`, which checks it before packaging.
 */

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = path.resolve(HERE, '..');
const CACHE = path.join(INSTALLER_DIR, '.cache');

/** Must match the Caddy version the agent's official fallback uses. */
const CADDY_VERSION = '2.11.7';
const CLOUDFLARE_PLUGIN = 'github.com/caddy-dns/cloudflare@v0.2.4';
const XCADDY_MODULE = 'github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7';

const TOOLS = path.join(CACHE, 'tools');
const OUTPUT_DIR = path.join(CACHE, 'caddy');

async function main(): Promise<void> {
  const env = {
    ...process.env,
    GOPATH: path.join(CACHE, 'gopath'),
    GOBIN: TOOLS,
    GOOS: 'windows',
    GOARCH: 'amd64',
    CGO_ENABLED: '0',
  };
  const xcaddy = path.join(TOOLS, process.platform === 'win32' ? 'xcaddy.exe' : 'xcaddy');

  process.stdout.write(`\nBuilding Caddy ${CADDY_VERSION} with the Cloudflare DNS module\n\n`);

  await run('go', ['install', XCADDY_MODULE], { env });

  const output = path.join(OUTPUT_DIR, 'caddy.exe');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await run(xcaddy, ['build', `v${CADDY_VERSION}`, '--with', CLOUDFLARE_PLUGIN, '--output', output], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });

  process.stdout.write(`\nBuilt ${output}\nPackage it with: pnpm bundle\n\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`\nCaddy build failed: ${(error as Error).message}\n\n`);
  process.exit(1);
});
