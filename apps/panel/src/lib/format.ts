/**
 * Human-readable sizes.
 *
 * Kept in one place because a mailbox and a folder should not disagree about
 * what 1.5 GB looks like.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * How long ago something happened, in words.
 *
 * "3 minutes ago" answers "is this happening right now?" at a glance, which a
 * timestamp does not. The exact time still goes in a `title` next to it.
 */
export function timeAgo(value: Date | string | number, now = Date.now()): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';

  const seconds = Math.round((now - then) / 1000);
  const future = seconds < 0;
  const magnitude = Math.abs(seconds);

  const units: Array<[label: string, seconds: number]> = [
    ['second', 1],
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['month', 2592000],
    ['year', 31536000],
  ];

  if (magnitude < 45) return future ? 'in a moment' : 'just now';

  let chosen = units[1]!;
  for (const unit of units) {
    if (magnitude >= unit[1]) chosen = unit;
  }

  const count = Math.round(magnitude / chosen[1]);
  const plural = count === 1 ? '' : 's';
  return future ? `in ${count} ${chosen[0]}${plural}` : `${count} ${chosen[0]}${plural} ago`;
}

/**
 * Turns a user-agent string into something a person recognises.
 *
 * Deliberately crude: the point is only to let the owner tell their own laptop
 * apart from a session they do not recognise, and the raw string is kept in a
 * tooltip for when the guess is wrong.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';

  const browsers: Array<[name: string, pattern: RegExp]> = [
    // Order matters: every one of these also claims to be Chrome or Safari.
    ['Edge', /\bEdg[A-Z]?\//],
    ['Opera', /\bOPR\//],
    ['Samsung Internet', /SamsungBrowser\//],
    ['Firefox', /\bFirefox\//],
    ['Chrome', /\bChrome\//],
    ['Safari', /\bSafari\//],
  ];

  const platforms: Array<[name: string, pattern: RegExp]> = [
    ['Windows', /Windows NT/],
    ['Android', /Android/],
    ['iPhone', /iPhone/],
    ['iPad', /iPad/],
    ['macOS', /Mac OS X|Macintosh/],
    ['Linux', /Linux/],
  ];

  const browser = browsers.find(([, pattern]) => pattern.test(userAgent))?.[0];
  const platform = platforms.find(([, pattern]) => pattern.test(userAgent))?.[0];

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;

  return userAgent.length > 40 ? `${userAgent.slice(0, 40)}\u2026` : userAgent;
}
