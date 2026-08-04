import crypto from 'node:crypto';

/**
 * Deploy keys.
 *
 * A deploy key is the way GitHub, GitLab and Bitbucket all intend a server to
 * read one private repository: the panel keeps the private half, the user
 * pastes the public half into that repository's settings, and nothing else on
 * the account is exposed. An access token, by contrast, is a key to everything
 * the person who made it can reach, has to be remade when it expires, and is
 * the thing people get wrong.
 *
 * The keypair is generated here rather than by shelling out to ssh-keygen so
 * the private half never touches disk outside the vault, and so this works
 * before Git has finished installing.
 *
 * The output is the OpenSSH private key format ("BEGIN OPENSSH PRIVATE KEY"),
 * unencrypted, which is what ssh reads with `-i`.
 */

export interface DeployKeyPair {
  /** OpenSSH private key, PEM-wrapped. Stored in the vault, never shown. */
  privateKey: string;
  /** The single `ssh-ed25519 AAAA... comment` line the user pastes. */
  publicKey: string;
  /** `SHA256:...`, so two keys can be told apart without reading them. */
  fingerprint: string;
}

/** Length-prefixed field, the only primitive the SSH wire format has. */
function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** PEM bodies are wrapped at 70 characters by ssh-keygen; ssh accepts any. */
function wrap(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 70) lines.push(base64.slice(i, i + 70));
  return lines.join('\n');
}

export function generateDeployKey(comment = 'winpanel'): DeployKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Both DER encodings are fixed-length for ed25519, so the raw 32-byte seed
  // and public point are simply the tail of each.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const point = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);

  const keyBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(point)]);

  // The "encrypted" section, with no cipher: two matching check integers
  // prove a correct passphrase, and there is no passphrase here.
  const check = crypto.randomBytes(4);
  const secret = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(point),
    // OpenSSH stores seed and public point together as the "private" field.
    sshString(Buffer.concat([seed, point])),
    sshString(comment),
  ]);

  // Padded to the cipher block size, which is 8 even for "none".
  const padding: number[] = [];
  while ((secret.length + padding.length) % 8 !== 0) padding.push(padding.length + 1);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(keyBlob),
    sshString(Buffer.concat([secret, Buffer.from(padding)])),
  ]);

  return {
    privateKey:
      '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      `${wrap(body.toString('base64'))}\n` +
      '-----END OPENSSH PRIVATE KEY-----\n',
    publicKey: `ssh-ed25519 ${keyBlob.toString('base64')} ${comment}`,
    fingerprint: `SHA256:${crypto
      .createHash('sha256')
      .update(keyBlob)
      .digest('base64')
      .replace(/=+$/, '')}`,
  };
}

/**
 * Whether git will reach this repository over SSH.
 *
 * Both spellings are in circulation: GitHub's "SSH" button gives the scp-like
 * `git@host:owner/repo.git`, while tooling tends to produce `ssh://`.
 */
export function isSshUrl(url: string): boolean {
  return /^(ssh:\/\/|[a-z0-9._-]+@[a-z0-9.-]+:)/i.test(url.trim());
}

/**
 * Converts a repository address to the SSH form a deploy key needs.
 *
 * Deploy keys only authenticate SSH connections — pasting one into a
 * repository and then cloning over https produces "repository not found",
 * which is the single most confusing way this can fail. So the address is
 * converted rather than rejected.
 */
export function toSshUrl(url: string): string {
  const trimmed = url.trim();
  if (isSshUrl(trimmed)) return trimmed;

  const match = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (!match) return trimmed;

  const [, host = '', pathPart = ''] = match;
  const repo = pathPart.replace(/\/+$/, '');
  return `git@${host}:${repo.endsWith('.git') ? repo : `${repo}.git`}`;
}

/** Converts back, for when the user switches to a token or a public repo. */
export function toHttpsUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const scp = /^[a-z0-9._-]+@([a-z0-9.-]+):(.+)$/i.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  return trimmed;
}

/** The host git will connect to, for either spelling. Null if unreadable. */
export function sshHostOf(url: string): string | null {
  const trimmed = url.trim();

  const scp = /^[a-z0-9._-]+@([a-z0-9.-]+):/i.exec(trimmed);
  if (scp?.[1]) return scp[1].toLowerCase();

  const ssh = /^ssh:\/\/(?:[^@/]+@)?([a-z0-9.-]+)/i.exec(trimmed);
  if (ssh?.[1]) return ssh[1].toLowerCase();

  return null;
}
