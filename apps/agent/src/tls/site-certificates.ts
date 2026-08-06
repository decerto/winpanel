import { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What certificate a website actually has right now.
 *
 * Read off disk rather than asked for, because Caddy has no admin endpoint
 * that lists managed certificates — and because the file on disk is the thing
 * that will be served, whatever any API says. Caddy stores them under its data
 * directory, which the panel sets with XDG_DATA_HOME when it installs the
 * service, so we know exactly where to look.
 *
 * This is read-only and never throws for a missing file. "No certificate yet"
 * is the ordinary state of a domain whose DNS has not propagated, not a fault.
 */

export interface DomainCertificate {
  domain: string;
  state: 'valid' | 'expiring' | 'expired' | 'absent';
  /** Who issued it, e.g. "Let's Encrypt". Null when there is no certificate. */
  issuer: string | null;
  expiresAt: Date | null;
  daysRemaining: number | null;
  /** True when the certificate covers the domain through a wildcard. */
  wildcard: boolean;
  /** Whether the panel obtained this, or the user supplied it. */
  source: 'automatic' | 'custom';
}

/** Below this, a renewal has had several chances and something is wrong. */
const EXPIRING_SOON_DAYS = 14;

/** Caddy's data directory, given the folder the panel points it at. */
export function caddyDataDir(caddyDir: string): string {
  return path.join(caddyDir, 'caddy');
}

interface LoadedCertificate {
  certificate: X509Certificate;
  source: DomainCertificate['source'];
}

/** Certificates never live more than three levels down, so the walk is bounded. */
async function loadCertificates(caddyDir: string): Promise<LoadedCertificate[]> {
  const root = path.join(caddyDataDir(caddyDir), 'certificates');
  const loaded: LoadedCertificate[] = [];

  let issuers: string[];
  try {
    issuers = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No storage folder at all: the web server has never issued anything.
    return loaded;
  }

  for (const issuer of issuers) {
    let subjects: string[];
    try {
      subjects = (await fs.readdir(path.join(root, issuer), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const subject of subjects) {
      try {
        const pem = await fs.readFile(path.join(root, issuer, subject, `${subject}.crt`));
        loaded.push({ certificate: new X509Certificate(pem), source: 'automatic' });
      } catch {
        // A half-written or unreadable file is not worth failing the page for.
      }
    }
  }

  return loaded;
}

function expiryOf(certificate: X509Certificate): Date | null {
  const parsed = certificate.validToDate ?? new Date(certificate.validTo);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A readable issuer name.
 *
 * The issuer string is a full distinguished name; the organisation within it
 * is the only part anyone recognises.
 */
function issuerNameOf(certificate: X509Certificate): string {
  const match = /^O=(.+)$/m.exec(certificate.issuer);
  return match?.[1]?.trim() ?? certificate.issuer.split('\n')[0] ?? 'Unknown';
}

const ABSENT = {
  state: 'absent',
  issuer: null,
  expiresAt: null,
  daysRemaining: null,
  wildcard: false,
  source: 'automatic',
} as const;

/** The certificate the web server holds for each domain, if any. */
export async function certificatesForDomains(
  caddyDir: string,
  domains: readonly string[],
  now: Date = new Date(),
  /** PEM of a certificate the user supplied for this website, if there is one. */
  customCertificate?: string | null,
): Promise<DomainCertificate[]> {
  if (domains.length === 0) return [];

  const loaded = await loadCertificates(caddyDir);

  /*
   * Listed first so it wins a tie. A domain can have both — an automatic
   * certificate obtained before the user supplied their own — and the one
   * Caddy is actually serving is theirs, so that is the one to report.
   */
  if (customCertificate) {
    try {
      loaded.unshift({
        certificate: new X509Certificate(customCertificate),
        source: 'custom',
      });
    } catch {
      // Unreadable here means unreadable at upload, which cannot happen.
    }
  }

  return domains.map((domain) => {
    /*
     * checkHost applies the certificate's own name matching, wildcards
     * included, so a site behind *.example.com is reported as covered rather
     * than as having nothing. It answers with the name that matched, which is
     * how a wildcard is told from an exact one. The newest match wins: a
     * renewal leaves the old certificate on disk until it is cleaned up.
     */
    const matches = loaded
      .map((entry) => ({
        ...entry,
        matched: entry.certificate.checkHost(domain, { subject: 'always' }),
      }))
      .filter((entry): entry is typeof entry & { matched: string } => entry.matched !== undefined)
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
        return (expiryOf(b.certificate)?.getTime() ?? 0) - (expiryOf(a.certificate)?.getTime() ?? 0);
      });

    const match = matches[0];
    if (!match) return { domain, ...ABSENT };

    const expiresAt = expiryOf(match.certificate);
    if (!expiresAt) return { domain, ...ABSENT };

    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);

    return {
      domain,
      state:
        daysRemaining < 0 ? 'expired' : daysRemaining <= EXPIRING_SOON_DAYS ? 'expiring' : 'valid',
      issuer: issuerNameOf(match.certificate),
      expiresAt,
      daysRemaining,
      wildcard: match.matched.startsWith('*.'),
      source: match.source,
    };
  });
}
