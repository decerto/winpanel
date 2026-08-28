import { describe, expect, it } from 'vitest';
import { parseCertificateError } from '../src/caddy/certificate-log.js';

/**
 * The panel used to guess why a certificate had not arrived, and the guess
 * named port 80 and a missing Cloudflare token. On a server that has both,
 * that is worse than saying nothing: it sends somebody to check the two
 * things that were already correct. Caddy says exactly what happened, once,
 * in its log — these are the shapes it says it in.
 */

const OBTAIN_FAILED = JSON.stringify({
  level: 'error',
  logger: 'tls.obtain',
  msg: 'could not get certificate from issuer',
  identifier: 'mail.onyshare.com',
  issuer: 'acme-v02.api.letsencrypt.org-directory',
  error:
    '[mail.onyshare.com] solving challenges: presenting for challenge: adding temporary ' +
    'record for zone "onyshare.com.": got error status: HTTP 403: Unauthorized to access ' +
    'requested resource',
});

describe('why a certificate did not arrive', () => {
  it('quotes the refusal Caddy recorded for that hostname', () => {
    expect(parseCertificateError(OBTAIN_FAILED, 'mail.onyshare.com')).toContain(
      'Unauthorized to access requested resource',
    );
  });

  it('says nothing when the log holds no complaint about it', () => {
    // Silence must stay silence: inventing a reason is how the misleading
    // message got there in the first place.
    const log = JSON.stringify({
      level: 'info',
      logger: 'tls.obtain',
      msg: 'certificate obtained successfully',
      identifier: 'mail.onyshare.com',
    });

    expect(parseCertificateError(log, 'mail.onyshare.com')).toBeNull();
  });

  it('ignores a failure that belongs to a different name', () => {
    expect(parseCertificateError(OBTAIN_FAILED, 'mail.example.com')).toBeNull();
  });

  it('prefers the newest failure over an older one', () => {
    const older = JSON.stringify({
      level: 'error',
      logger: 'tls.obtain',
      identifier: 'mail.onyshare.com',
      error: 'an earlier rate limit',
    });

    const log = [older, OBTAIN_FAILED].join('\n');

    expect(parseCertificateError(log, 'mail.onyshare.com')).toContain('HTTP 403');
  });

  it('reads a name out of the identifier list Caddy uses for an order', () => {
    const log = JSON.stringify({
      level: 'error',
      logger: 'tls.obtain',
      msg: 'validating authorization',
      identifiers: ['mail.onyshare.com'],
      error: 'authorization failed',
    });

    expect(parseCertificateError(log, 'mail.onyshare.com')).toBe('authorization failed');
  });

  it('falls back to the message when there is no error field', () => {
    const log = JSON.stringify({
      level: 'error',
      logger: 'tls',
      msg: 'no certificate for mail.onyshare.com and no issuer configured',
    });

    expect(parseCertificateError(log, 'mail.onyshare.com')).toContain('no issuer configured');
  });

  it('survives the plain-text lines a wrapper writes around the JSON', () => {
    const log = ['Caddy is starting', 'not json at all', OBTAIN_FAILED].join('\r\n');

    expect(parseCertificateError(log, 'mail.onyshare.com')).toContain('HTTP 403');
  });
});
