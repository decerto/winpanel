import path from 'node:path';
import { PANEL_PORT } from '@winpanel/shared';

/**
 * Every filesystem location and tunable the agent uses.
 *
 * Defaults match what the installer creates on a real server. They can be
 * overridden by environment variables so the test suite and local development
 * never touch the real directories.
 */

function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? path.resolve(value) : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

const DEFAULT_ROOT = process.platform === 'win32' ? 'C:\\WinPanel' : path.join(process.cwd(), '.winpanel-dev');
const DEFAULT_SITES_ROOT = process.platform === 'win32' ? 'C:\\Sites' : path.join(process.cwd(), '.winpanel-sites');

const root = envPath('WINPANEL_ROOT', DEFAULT_ROOT);

export const config = {
  /** Installation root. Everything the panel owns lives under here. */
  root,
  /** Downloaded component binaries (caddy.exe, stalwart.exe, WinSW.exe). */
  binDir: envPath('WINPANEL_BIN_DIR', path.join(root, 'bin')),
  /** SQLite database, vault key, panel certificate. */
  dataDir: envPath('WINPANEL_DATA_DIR', path.join(root, 'data')),
  /** Caddy's own storage: autosave.json and issued certificates. */
  caddyDir: envPath('WINPANEL_CADDY_DIR', path.join(root, 'caddy')),
  /** Built panel SPA, served by the agent. */
  panelDir: envPath('WINPANEL_PANEL_DIR', path.join(root, 'panel')),
  logDir: envPath('WINPANEL_LOG_DIR', path.join(root, 'logs')),
  /**
   * Caddy's per-website access logs, which the traffic figures are counted
   * from. Separate from the panel's own logs because these are rolled and
   * consumed by the panel rather than read by a person.
   */
  accessLogDir: envPath('WINPANEL_ACCESS_LOG_DIR', path.join(root, 'logs', 'access')),

  /**
   * Root of all hosted sites. This is the containment boundary the file
   * manager enforces: nothing outside it is reachable, ever.
   */
  sitesRoot: envPath('WINPANEL_SITES_ROOT', DEFAULT_SITES_ROOT),

  /**
   * The panel listens here. Fixed rather than random so it is easy to
   * remember, and permanently excluded from site port allocation.
   */
  port: envInt('WINPANEL_PORT', PANEL_PORT),
  /**
   * Bound to all interfaces because the panel is reached at
   * https://<server-ip>:8443 — there is no panel domain.
   */
  host: process.env['WINPANEL_HOST'] ?? '0.0.0.0',

  /**
   * HTTPS uses a self-signed certificate generated at install time. It costs
   * the user nothing beyond one browser warning and keeps the login, session
   * cookie and TOTP code off the wire in plaintext. Can be turned off, but the
   * UI then shows a permanent warning and forces the IP allowlist on.
   */
  httpsEnabled: envBool('WINPANEL_HTTPS', true),

  logLevel: process.env['WINPANEL_LOG_LEVEL'] ?? 'info',
  /** Set by the test suite so nothing touches the real machine. */
  isTest: process.env['NODE_ENV'] === 'test' || envBool('WINPANEL_TEST', false),
} as const;

export const paths = {
  database: () => path.join(config.dataDir, 'panel.db'),
  vaultKey: () => path.join(config.dataDir, 'vault.key'),
  panelCert: () => path.join(config.dataDir, 'panel-cert.pem'),
  panelKey: () => path.join(config.dataDir, 'panel-key.pem'),
  setupToken: () => path.join(config.dataDir, 'setup-token.txt'),
  componentManifest: () => path.join(config.dataDir, 'components.json'),
  siteRoot: (slug: string) => path.join(config.sitesRoot, slug),
} as const;

export type Config = typeof config;
