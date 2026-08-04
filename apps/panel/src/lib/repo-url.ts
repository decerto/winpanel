/**
 * Repository addresses, from the user's point of view.
 *
 * People paste whatever their code host's copy button gave them, which is
 * sometimes the https address and sometimes the SSH one. Which of the two is
 * needed depends on how the site signs in — a deploy key only ever works over
 * SSH — so the panel converts rather than complains.
 */

export function isSshUrl(url: string): boolean {
  return /^(ssh:\/\/|[a-z0-9._-]+@[a-z0-9.-]+:)/i.test(url.trim());
}

export function toSshUrl(url: string): string {
  const trimmed = url.trim();
  if (isSshUrl(trimmed)) return trimmed;

  const match = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (!match) return trimmed;

  const repo = (match[2] ?? '').replace(/\/+$/, '');
  return `git@${match[1]}:${repo.endsWith('.git') ? repo : `${repo}.git`}`;
}

export function toHttpsUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const scp = /^[a-z0-9._-]+@([a-z0-9.-]+):(.+)$/i.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  return trimmed;
}

/** Host and `owner/repo`, from either spelling. Null when unreadable. */
export function parseRepository(url: string): { host: string; path: string } | null {
  const trimmed = url.trim();

  const scp = /^[a-z0-9._-]+@([a-z0-9.-]+):(.+)$/i.exec(trimmed);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([a-z0-9.-]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const https = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const match = scp ?? ssh ?? https;
  if (!match?.[1] || !match[2]) return null;

  return {
    host: match[1].toLowerCase(),
    path: match[2].replace(/\.git$/i, '').replace(/\/+$/, ''),
  };
}

/**
 * The exact page the deploy key has to be pasted into.
 *
 * Deep-linked because "Settings → Deploy keys" is four clicks away and named
 * differently on every host, and a wrong turn lands you on account-level keys,
 * which do not work.
 */
export function deployKeyPageFor(url: string): string | null {
  const repo = parseRepository(url);
  if (!repo) return null;

  if (repo.host.includes('github')) return `https://${repo.host}/${repo.path}/settings/keys/new`;
  if (repo.host.includes('gitlab')) {
    return `https://${repo.host}/${repo.path}/-/settings/repository`;
  }
  if (repo.host.includes('bitbucket')) {
    return `https://${repo.host}/${repo.path}/admin/access-keys/`;
  }
  return null;
}

/** Where the same host hides personal access tokens. */
export function tokenPageFor(url: string): string | null {
  const repo = parseRepository(url);
  const host = repo?.host ?? '';

  if (host.includes('github')) return `https://${host}/settings/tokens`;
  if (host.includes('gitlab')) return `https://${host}/-/user_settings/personal_access_tokens`;
  if (host.includes('bitbucket')) return `https://${host}/account/settings/app-passwords/`;
  return null;
}

/** What to call the host in a sentence: "GitHub", "GitLab", or "your code host". */
export function hostLabelFor(url: string): string {
  const host = parseRepository(url)?.host ?? '';

  if (host.includes('github')) return 'GitHub';
  if (host.includes('gitlab')) return 'GitLab';
  if (host.includes('bitbucket')) return 'Bitbucket';
  if (host.includes('dev.azure.com') || host.includes('visualstudio.com')) return 'Azure DevOps';
  return 'your code host';
}
