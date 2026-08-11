import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { settings } from '../db/schema.js';

/**
 * The domain name the panel itself answers to.
 *
 * Without one the panel is reached at `https://<server-ip>:8443` and can only
 * ever serve a self-signed certificate: a certificate authority will not issue
 * for a bare IP address, so every sign-in starts with a full-page browser
 * warning. Giving the panel a name of its own — `panel.example.com` — lets the
 * web server obtain an ordinary publicly-trusted certificate for it, which the
 * panel then serves on its own listener.
 *
 * Stored rather than configured in a file because it has to be changeable from
 * the panel, and because the web server's configuration is rebuilt from the
 * database on every reconcile.
 */

const PANEL_HOSTNAME_KEY = 'panel.hostname';

/**
 * A dotted, non-wildcard host name.
 *
 * A subdomain (`panel.example.com`) and a root domain (`example.com`) are both
 * fine — the panel does not care which, and a root domain nobody is hosting a
 * website on is a perfectly reasonable thing to point at it.
 *
 * A single label (`server`) and an IP address are both refused: neither can be
 * issued a certificate, so accepting one would take the panel off its
 * self-signed certificate and give it nothing in return.
 */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export class PanelHostnameError extends Error {}

/**
 * @throws PanelHostnameError with a message meant for the user.
 */
export function normalisePanelHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');

  if (hostname.length === 0) {
    throw new PanelHostnameError('Enter a domain name for the panel.');
  }

  if (hostname.length > 253) {
    throw new PanelHostnameError('That domain name is too long.');
  }

  if (hostname.includes('*')) {
    throw new PanelHostnameError(
      'Give one exact name, such as panel.example.com or example.com — not a wildcard.',
    );
  }

  if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
    throw new PanelHostnameError(
      'That is an IP address. No certificate authority will issue a certificate for one, ' +
        'which is exactly the problem a panel domain solves — use a name such as ' +
        'panel.example.com, or a root domain no website is using.',
    );
  }

  if (!HOSTNAME.test(hostname)) {
    throw new PanelHostnameError(
      'That is not a domain name. Use something like panel.example.com or example.com.',
    );
  }

  return hostname;
}

export function readPanelHostname(db: DatabaseHandle): string | null {
  const row = db.db.select().from(settings).where(eq(settings.key, PANEL_HOSTNAME_KEY)).get();
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @returns true when the value changed, so the caller knows to reconcile. */
export function storePanelHostname(db: DatabaseHandle, hostname: string | null): boolean {
  const next = hostname === null ? '' : normalisePanelHostname(hostname);
  if ((readPanelHostname(db) ?? '') === next) return false;

  db.db
    .insert(settings)
    .values({ key: PANEL_HOSTNAME_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
    .run();

  return true;
}

/**
 * The panel's own name, if it is among these domains.
 *
 * Two things answering for one host is a configuration the web server accepts
 * and then resolves unpredictably, which is why websites are already stopped
 * from sharing a name with each other. The panel is the same problem with a
 * worse outcome — losing the address every administrator signs in at — and it
 * became a likely one the moment a root domain was a reasonable thing to give
 * the panel.
 */
export function panelHostnameAmong(
  db: DatabaseHandle,
  domains: readonly string[],
): string | null {
  const hostname = readPanelHostname(db);
  if (!hostname) return null;

  return domains.some((domain) => domain.trim().toLowerCase() === hostname) ? hostname : null;
}
