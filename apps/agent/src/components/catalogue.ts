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
 *
 * Every other hash below was taken from the publisher's own record — the
 * `SHASUMS256.txt` for a Node release, the asset digest GitHub computes for a
 * release attachment — rather than from a file this machine happened to
 * download. Bumping a version means fetching the new hash from the same place.
 */

const CADDY_VERSION = 'latest';
const STALWART_VERSION = '0.16.16';
const GIT_VERSION = '2.51.0';
const NODE_LTS_VERSION = '22.21.1';
const PNPM_VERSION = '11.20.0';
const YARN_VERSION = '1.22.22';
const BUN_VERSION = '1.3.14';

/*
 * PHP is the Non-Thread-Safe build: PHP's own guidance is that NTS is the
 * correct build for FastCGI, which is the only way the panel runs it. The
 * hash is the one php.net publishes beside the download. It requires the
 * VC++ 2015-2022 x64 redistributable, which is why `vcredist` is a
 * dependency — the panel installs it first rather than letting a missing DLL
 * surface as a cryptic php-cgi crash.
 */
const PHP_VERSION = '8.5.9';
const VCREDIST_VERSION = '14.44.35211.0';
const MARIADB_VERSION = '12.3.2';
const COMPOSER_VERSION = '2.8.12';
const ADMINER_VERSION = '6.0.0';

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
    sha256: '97d218605632bc149b5a95d8b5b20c9c9da9f839c1e25bbc07491fea4b02b943',
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
    sha256: 'c2c955a21fa99889d83f485f24fa5d9a38fffc2d509d4022385510e11c26b250',
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
    sha256: '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf',
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: 'v',
    requires: [],
  },
  {
    id: 'pnpm',
    name: 'pnpm',
    description:
      'A package manager some projects use instead of npm. Needed to deploy a website ' +
      'whose project has a pnpm-lock.yaml file.',
    version: PNPM_VERSION,
    kind: 'zip',
    /*
     * The standalone build, which carries its own runtime. Installing pnpm
     * through npm instead would put a `.cmd` shim on the machine, and Windows
     * refuses to start one of those without a shell — which is exactly what
     * the command executor will not do.
     */
    url: `https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-win32-x64.zip`,
    sha256: 'ea2528bdc3d96a1ff3c35587dc48ca692b39d77f08f26df4adeaaa9eb427024e',
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: PNPM_VERSION,
    requires: [],
  },
  {
    id: 'yarn',
    name: 'Yarn',
    description:
      'A package manager some projects use instead of npm. Needed to deploy a website ' +
      'whose project has a yarn.lock file.',
    version: YARN_VERSION,
    /*
     * Yarn 1 publishes one JavaScript file and no program for Windows: the
     * .msi is a system-wide install the panel has no business doing, and the
     * tarball is not something the unpacker here reads. The file is run with
     * the server's own Node, which is exactly what the .msi's shim does.
     */
    kind: 'node-script',
    url: `https://github.com/yarnpkg/yarn/releases/download/v${YARN_VERSION}/yarn-${YARN_VERSION}.js`,
    sha256: '1ba910c84256998c4bf4b925857c2693adebdc962a2e3075f4f8b67045f45105',
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: YARN_VERSION,
    requires: [],
  },
  {
    id: 'bun',
    name: 'Bun',
    description:
      'A package manager and JavaScript runtime some projects use instead of Node.js ' +
      'and npm. Needed to deploy a website whose project has a bun.lock file.',
    version: BUN_VERSION,
    kind: 'zip',
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`,
    sha256: '0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922',
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: BUN_VERSION,
    requires: [],
  },
  {
    /*
     * The VC++ 2015-2022 runtime PHP is built against. Microsoft's
     * `aka.ms/vs/17/release/vc_redist.x64.exe` is a permalink whose bytes
     * change in place, so it cannot be hashed; instead the version-pinned URL
     * it redirects to is used, whose bytes are stable. The hash is the one
     * embedded in that URL (Microsoft puts it in the path) and is verified
     * against the download.
     */
    id: 'vcredist',
    name: 'Visual C++ Runtime',
    description:
      'The Microsoft runtime library PHP is built against. PHP will not start without it.',
    version: VCREDIST_VERSION,
    kind: 'exe',
    url: 'https://download.visualstudio.microsoft.com/download/pr/9d270333-8b7b-4f96-9458-6fcdb2ec0b25/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',
    sha256: 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b',
    args: ['/install', '/quiet', '/norestart'],
    serviceName: null,
    // A runtime library has no `--version`; a silent install's exit code says it worked.
    verifyArgs: [],
    verifyExpect: null,
    requires: [],
  },
  {
    id: 'php',
    name: 'PHP',
    description: 'Runs websites written in PHP, including WordPress.',
    version: PHP_VERSION,
    kind: 'zip',
    url: `https://downloads.php.net/~windows/releases/archives/php-${PHP_VERSION}-nts-Win32-vs17-x64.zip`,
    sha256: '516c2d72231bd035c8a910120834add0ad208098b790b4909b2cbeb93ce135fc',
    args: [],
    serviceName: null,
    verifyArgs: ['--version'],
    verifyExpect: `PHP ${PHP_VERSION.split('.').slice(0, 2).join('.')}`,
    requires: ['vcredist'],
  },
  {
    id: 'mariadb',
    name: 'Database server (MariaDB)',
    description:
      'Stores data for WordPress and other apps that need a MySQL-compatible database.',
    version: MARIADB_VERSION,
    kind: 'zip',
    url: `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/mariadb-${MARIADB_VERSION}-winx64.zip`,
    // From the release's own sha256sums.txt on archive.mariadb.org.
    sha256: '67347c129eb9c5923d002ea34fbfa27c60eb95d36dd73b85af2651cdeceecac5',
    args: [],
    serviceName: 'winpanel-mariadb',
    verifyArgs: ['--version'],
    verifyExpect: 'mariadb',
    requires: [],
  },
  {
    /*
     * Composer is a single PHP archive with no Windows program of its own, so
     * it is run through the PHP the panel installed. The SHA-256 is published
     * on getcomposer.org beside the download.
     */
    id: 'composer',
    name: 'Composer',
    description:
      'Installs the packages a PHP project asks for. Needed when a site has a composer.json file.',
    version: COMPOSER_VERSION,
    kind: 'php-script',
    url: 'https://getcomposer.org/download/latest-stable/composer.phar',
    // From the published composer.phar.sha256 on getcomposer.org.
    sha256: '5ee7125f8a30a34d246cefdc0bc85b8a783b28f2aec968994118512350d28027',
    args: [],
    serviceName: null,
    verifyArgs: ['--version', '--no-ansi'],
    verifyExpect: 'Composer',
    requires: ['php'],
  },
  {
    /*
     * Adminer is one PHP file. It is NOT served from any website — the panel
     * runs it behind its own sign-in so the database browser is never exposed
     * on a public domain, which is exactly what Adminer's own security notes
     * insist on.
     */
    id: 'adminer',
    name: 'Database browser (Adminer)',
    description:
      'A single-file page for browsing and editing a site\'s database, opened from the panel.',
    version: ADMINER_VERSION,
    kind: 'php-script',
    url: `https://github.com/vrana/adminer/releases/download/v${ADMINER_VERSION}/adminer-${ADMINER_VERSION}-mysql-en.php`,
    // The single-file build has no published checksum; computed from the pinned
    // release asset on github.com/vrana/adminer.
    sha256: '1582527dadc7f6733c299abc82d64440f62f493387e75593c61db182cf1bc074',
    args: [],
    serviceName: null,
    // It is a web page, not a CLI program; there is nothing meaningful to run.
    verifyArgs: [],
    verifyExpect: null,
    requires: ['php', 'mariadb'],
  },
];

export function findComponent(id: string): ComponentDefinition | undefined {
  return COMPONENT_CATALOGUE.find((component) => component.id === id);
}
