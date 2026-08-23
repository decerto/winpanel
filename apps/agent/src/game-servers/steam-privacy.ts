/**
 * Keeps the operator's Steam account out of a customer's job log.
 *
 * The panel signs in to Steam with the account the person running the server
 * owns, and it does that on behalf of customers who have no Steam account of
 * their own. Those customers can read the job log for their own server — they
 * should, it is how they find out why a download failed — and SteamCMD names
 * the account it is signing in as in its very first line of output.
 *
 * So every line from SteamCMD is passed through here before it reaches a log
 * or an error message. The username is replaced with a phrase, the password is
 * masked in case it is ever echoed, and Steam Guard's "code sent to
 * j****@example.com" is stripped too: an email address identifies the operator
 * just as well as a username does.
 *
 * Over-redacting is the safe failure here. A log line that reads a little
 * oddly costs nothing; a leaked account name is somebody else's problem for a
 * long time.
 */

/** What the operator's account is called when a customer is reading. */
export const STEAM_ACCOUNT_LABEL = 'the server Steam account';

const MASK = '********';

/**
 * Steam's own output names the account, whether or not the panel configured one.
 *
 * Every pattern captures the same three things — the phrase leading up to the
 * name, the quote around it if there is one, and the name — so one replacement
 * handles them all.
 */
const NAMED_ACCOUNT_PATTERNS: RegExp[] = [
  /(logging in user\s+)(['"]?)([^\s'"]+)\2/gi,
  /(Steam>\s*login\s+)()(\S+)/gi,
  /(account\s*name\s*[:=]\s*)()(\S+)/gi,
];

const EMAIL = /[A-Za-z0-9._%+*-]+@[A-Za-z0-9.*-]+\.[A-Za-z*]{2,}/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anonymous is the one account name worth showing: it means no account at all. */
function replaceName(prefix: string, quote: string, name: string): string {
  if (name.toLowerCase() === 'anonymous') return `${prefix}${quote}${name}${quote}`;
  return `${prefix}${STEAM_ACCOUNT_LABEL}`;
}

/**
 * Builds a scrubber for one SteamCMD run.
 *
 * Returned as a closure rather than a plain function so the credential
 * patterns are compiled once per run instead of once per line of a download
 * that can print thousands.
 */
export function createSteamRedactor(
  credentials: { username: string; password: string } | null,
): (text: string) => string {
  const literals: Array<[RegExp, string]> = [];

  if (credentials) {
    // Longest first, so a password that contains the username is masked whole.
    const pairs: Array<[string, string]> = [
      [credentials.password, MASK],
      [credentials.username, STEAM_ACCOUNT_LABEL],
    ];
    for (const [value, replacement] of pairs.sort((a, b) => b[0].length - a[0].length)) {
      if (value.length === 0) continue;
      literals.push([new RegExp(escapeRegex(value), 'gi'), replacement]);
    }
  }

  return (text: string): string => {
    let result = text;
    for (const [pattern, replacement] of literals) result = result.replace(pattern, replacement);

    for (const pattern of NAMED_ACCOUNT_PATTERNS) {
      result = result.replace(pattern, (_match, prefix: string, quote: string, name: string) =>
        replaceName(prefix, quote, name),
      );
    }

    return result.replace(EMAIL, '<redacted>');
  };
}
