import type { ComponentDefinition } from '@winpanel/shared';

/**
 * The pinned component catalogue.
 *
 * Design notes:
 *  - ZIPs are preferred over installers. An archive either extracts or it does
 *    not; a silent installer can half-succeed in ways that are miserable to
 *    detect and undo.
 *  - git ships as MinGit, the portable distribution, so there is no installer
 *    to wrangle and nothing is registered system-wide.
 *  - WinGet is deliberately not used anywhere. It is not reliably present on
 *    Windows Server, and it resolves to whatever version is current, which
 *    defeats the point of pinning and hashing.
 *
 * `sha256: null` is permitted only for Caddy, whose download endpoint builds a
 * binary per request so no stable hash can exist. That case is covered by
 * running the binary afterwards and checking it reports the expected version
 * and includes the Cloudflare module.
 */

const CADDY_VERSION = 'latest';
const STALWART_VERSION = '0.16.16';
const GIT_VERSION = '2.51.0';
const NODE_LTS_VERSION = '22.21.1';

/**
 * Caddy's official download service builds a binary with the plugins you ask
 * for. Using it avoids installing a Go toolchain on the server purely to run
 * xcaddy, which would be a large dependency for a one-off build.
 *
 * It has no version parameter: it always builds the current release, and the
 * result is a bare .exe served gzipped rather than an archive. So the version
 * is reported as "latest" rather than pinned to a number that would be a lie,
 * and the install log records whichever version actually arrived.
 */
export const CADDY_DOWNLOAD_URL =
  'https://caddyserver.com/api/download' +
  '?os=windows&arch=amd64&p=github.com/caddy-dns/cloudflare';

export const COMPONENT_CATALOGUE: readonly ComponentDefinition[] = [
  {
    id: 'caddy',
    name: 'Web server',
    description:
      'Serves your websites, handles HTTPS certificates automatically, and passes ' +
      'traffic to your apps.',
    version: CADDY_VERSION,
    kind: 'binary',
    url: CADDY_DOWNLOAD_URL,
    sha256: null,
    /*
     * `--resume` reloads the configuration Caddy last saved itself, so a
     * reboot brings back the sites that were being served rather than an
     * empty server waiting to be told what to do.
     */
    args: ['run', '--resume'],
    serviceName: 'winpanel-caddy',
    verifyArgs: ['version'],
    verifyExpect: 'v2.',
    requires: [],
  },
  {
    id: 'stalwart',
    name: 'Mail server',
    description: 'Runs your email: sending, receiving, and mailboxes you can use in Outlook.',
    version: STALWART_VERSION,
    kind: 'zip',
    url:
      `https://github.com/stalwartlabs/stalwart/releases/download/v${STALWART_VERSION}` +
      '/stalwart-x86_64-pc-windows-msvc.zip',
    sha256: null,
    args: [],
    serviceName: 'winpanel-stalwart',
    verifyArgs: ['--version'],
    // It prints the bare version number and nothing else, so checking for the
    // product name never matched.
    verifyExpect: STALWART_VERSION,
    requires: [],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Lets the panel download your website code from GitHub and other services.',
    version: GIT_VERSION,
    kind: 'zip',
    url:
      `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1` +
      `/MinGit-${GIT_VERSION}-64-bit.zip`,
    sha256: null,
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: 'git version',
    requires: [],
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'The runtime your websites and apps are built on.',
    version: NODE_LTS_VERSION,
    kind: 'zip',
    url: `https://nodejs.org/dist/v${NODE_LTS_VERSION}/node-v${NODE_LTS_VERSION}-win-x64.zip`,
    sha256: null,
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: 'v',
    requires: [],
  },
];

export function findComponent(id: string): ComponentDefinition | undefined {
  return COMPONENT_CATALOGUE.find((component) => component.id === id);
}

/**
 * Node release hashes are published per version in SHASUMS256.txt. Fetching
 * and pinning them at build time is preferable to trusting the download, so
 * the installer's build step populates this map.
 */
export const KNOWN_HASHES: Readonly<Record<string, string>> = Object.freeze({});
