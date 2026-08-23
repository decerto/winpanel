import { describe, expect, it } from 'vitest';
import { createSteamRedactor, STEAM_ACCOUNT_LABEL } from '../src/game-servers/steam-privacy.js';

/**
 * Whose Steam account is doing the downloading is the operator's business.
 *
 * A customer renting a game server can read that server's job log — they have
 * to, it is where a failed download explains itself — and SteamCMD announces
 * the account it signs in as in its first line of output. These tests hold the
 * line between "here is why your mod would not download" and "here is the
 * hosting company's Steam login".
 */

const credentials = { username: 'winpanel_host', password: 'Tr0ub4dor&3' };

describe('Steam log redaction', () => {
  const redact = createSteamRedactor(credentials);

  it('never lets the configured account name through', () => {
    expect(redact("Logging in user 'winpanel_host' to Steam Public...")).not.toContain('winpanel_host');
    expect(redact('Logging in user winpanel_host to Steam Public...')).toContain(STEAM_ACCOUNT_LABEL);
    expect(redact('WINPANEL_HOST logged in OK')).not.toMatch(/winpanel_host/i);
  });

  it('masks the password, in case anything ever echoes it', () => {
    expect(redact('login winpanel_host Tr0ub4dor&3')).not.toContain('Tr0ub4dor&3');
    expect(redact('password=Tr0ub4dor&3')).toContain('********');
  });

  /*
   * SteamCMD can name an account the panel was never told about, from a
   * session cached by whoever signed in on the machine itself.
   */
  it('hides an account name even when the panel has no credentials of its own', () => {
    const blind = createSteamRedactor(null);

    expect(blind("Logging in user 'someone_else' to Steam Public...")).toBe(
      `Logging in user ${STEAM_ACCOUNT_LABEL} to Steam Public...`,
    );
    expect(blind('Steam>login someone_else')).not.toContain('someone_else');
    expect(blind('Account name: someone_else')).not.toContain('someone_else');
  });

  it('leaves anonymous visible, because it means no account at all', () => {
    expect(createSteamRedactor(null)('Logging in user anonymous to Steam Public...')).toContain(
      'anonymous',
    );
  });

  it('strips the email address Steam Guard reports the code was sent to', () => {
    const line = redact('Steam Guard code sent to o****r@winpanel-hosting.com');

    expect(line).not.toContain('winpanel-hosting.com');
    expect(line).toContain('<redacted>');
  });

  it('keeps the part of the message the customer actually needs', () => {
    const line = redact(
      "ERROR! Failed to install app '380870' (Disk write failure) for user 'winpanel_host'",
    );

    expect(line).toContain('Disk write failure');
    expect(line).toContain('380870');
    expect(line).not.toContain('winpanel_host');
  });

  it('leaves ordinary progress output alone', () => {
    const line = 'Update state (0x61) downloading, progress: 42.13 (3221225472 / 7644119040)';

    expect(redact(line)).toBe(line);
  });
});
