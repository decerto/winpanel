import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand } from '../process/run-command.js';
import { isSshUrl } from './ssh-keys.js';

/**
 * Git operations for deployments.
 *
 * Runs the git binary directly through the safe executor rather than via a
 * wrapper library: every argument is passed as an array element, so a branch
 * name or URL containing shell metacharacters is inert.
 *
 * Credentials are never placed on the command line. On Windows any account can
 * read another process's arguments through WMI, so a token embedded in a clone
 * URL would be readable by anything running on the box for the duration of the
 * clone. Instead the token is written to a short-lived credential file that
 * git is told to read, and the repository URL stays clean — which also means
 * nothing lands in `.git/config`.
 *
 * A deploy key works the same way: the private key is written to a file for
 * the life of one command and ssh is pointed at it, so it exists on disk for
 * seconds rather than for the life of the server.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  /** Absolute path to git.exe. */
  gitPath: string;
  /** Personal access token, when the repository is private. */
  token?: string;
  /** OpenSSH private key for a deploy key, when the address is an SSH one. */
  sshPrivateKey?: string;
  /**
   * Where host keys learned on first connection are pinned. Without one every
   * connection is trust-on-first-use with nothing remembered, so a host that
   * changes its key mid-way is never noticed.
   */
  knownHostsPath?: string;
  onOutput?: (line: string) => void;
}

/** One line of history, as shown next to the deploy button. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO 8601, author date. */
  at: string;
  subject: string;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejects URLs git would treat as something other than a remote fetch.
 *
 * SSH addresses are only allowed alongside a deploy key: without one there is
 * no identity to offer, and the failure arrives minutes later as a password
 * prompt that a service can never answer.
 */
export function validateRepositoryUrl(
  url: string,
  options: { allowSsh?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const trimmed = url.trim();

  if (trimmed.length === 0) return { ok: false, reason: 'Enter the address of your repository.' };
  if (trimmed.includes('\u0000')) return { ok: false, reason: 'That address is not valid.' };

  // `--upload-pack=...` and friends would otherwise be read as git options.
  if (trimmed.startsWith('-')) {
    return { ok: false, reason: 'That address is not valid.' };
  }

  // `ext::` lets git run an arbitrary command as its transport.
  if (/^ext::/i.test(trimmed)) {
    return { ok: false, reason: 'That kind of repository address is not allowed.' };
  }

  if (isSshUrl(trimmed)) {
    if (!options.allowSsh) {
      return {
        ok: false,
        reason:
          'An SSH address like this one needs a deploy key. Choose "Use a deploy key" ' +
          'above, or paste the https:// address instead.',
      };
    }

    // A password in an SSH address cannot work: the panel never types one.
    if (/^ssh:\/\/[^/]*:[^/@]*@/i.test(trimmed)) {
      return { ok: false, reason: 'Remove the password from the address. The deploy key signs in.' };
    }

    return { ok: true };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      reason: 'Use an https:// address, for example https://github.com/you/your-project.git',
    };
  }

  return { ok: true };
}

/**
 * The username git should send alongside a token.
 *
 * Every host wants something different here, and getting it wrong produces a
 * plain "authentication failed" that gives no hint as to why. GitHub accepts
 * almost anything, but GitLab and Bitbucket are strict.
 */
export function credentialUsernameFor(host: string): string {
  const lower = host.toLowerCase();

  if (lower.includes('gitlab')) return 'oauth2';
  if (lower.includes('bitbucket')) return 'x-token-auth';
  if (lower.includes('dev.azure.com') || lower.includes('visualstudio.com')) return 'pat';
  // GitHub and GitHub Enterprise, and a reasonable default elsewhere.
  return 'x-access-token';
}

/** Rejects branch or tag names git would treat as an option. */
export function validateGitRef(ref: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = ref.trim();

  if (trimmed.length === 0) return { ok: false, reason: 'Enter a branch name.' };
  if (trimmed.startsWith('-')) return { ok: false, reason: 'That branch name is not valid.' };
  if (/[\s~^:?*[\\\u0000]/.test(trimmed)) {
    return { ok: false, reason: 'That branch name contains characters git does not allow.' };
  }
  if (trimmed.includes('..')) {
    return { ok: false, reason: 'That branch name is not valid.' };
  }

  return { ok: true };
}

/**
 * Builds the git arguments that supply a token, without putting it in argv.
 *
 * Exported so the guarantee can be tested directly: on Windows any account
 * can read another process's arguments through WMI, so a token embedded in a
 * clone URL would be readable by anything on the box while the clone runs.
 * Here it goes into a private, short-lived file instead and the URL stays
 * clean, which also keeps it out of `.git/config`.
 *
 * `credential.helper=` is reset to empty first so Windows Credential Manager
 * cannot answer instead and silently use the wrong account.
 */
export async function createCredentialArgs(
  url: string,
  token?: string,
): Promise<{ args: string[]; cleanup: () => Promise<void>; file: string | null }> {
  if (!token) {
    return {
      args: ['-c', 'credential.helper='],
      cleanup: async () => undefined,
      file: null,
    };
  }

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new GitError('That repository address is not valid.');
  }

  const username = credentialUsernameFor(host);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-git-'));
  const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.cred`);

  // git's store format: one full URL per line, credentials included.
  const line = `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${host}\n`;
  await fs.writeFile(file, line, { mode: 0o600 });

  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${file}`],
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
    file,
  };
}

/**
 * Everything inside GIT_SSH_COMMAND is re-parsed by a shell, and a Windows
 * path is full of backslashes that shell would eat. Forward slashes mean the
 * same thing to every Windows API and survive the round trip.
 */
function shellPath(value: string): string {
  return `"${value.replace(/\\/g, '/')}"`;
}

/**
 * Writes the deploy key out for the life of one git command.
 *
 * ssh has no way to be handed a key in memory, so it has to be a file. It is
 * created inside a private temporary folder and removed the moment the command
 * finishes, rather than living permanently beside the site where a build
 * script could read it.
 *
 * Host keys are pinned on first use into a file the panel owns: strict
 * checking against an empty file would refuse every first connection, and
 * turning checking off entirely would accept an impostor on every one.
 */
export async function createSshEnvironment(options: {
  gitPath: string;
  privateKey: string;
  knownHostsPath?: string;
}): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-ssh-'));
  const keyFile = path.join(dir, 'deploy_key');
  const key = options.privateKey.endsWith('\n') ? options.privateKey : `${options.privateKey}\n`;

  await fs.writeFile(keyFile, key, { mode: 0o600 });

  const knownHosts = options.knownHostsPath ?? path.join(dir, 'known_hosts');
  await fs.mkdir(path.dirname(knownHosts), { recursive: true }).catch(() => undefined);

  // Git for Windows ships its own ssh next to git.exe (…/git/cmd/git.exe →
  // …/git/usr/bin/ssh.exe). Prefer it: it is the build git itself is tested
  // against. Fall back to whatever is on PATH, which on Windows Server 2019+
  // is the built-in OpenSSH client.
  const gitRoot = path.dirname(path.dirname(options.gitPath));
  const bundled = path.join(gitRoot, 'usr', 'bin', 'ssh.exe');
  const ssh = (await exists(bundled)) ? bundled : 'ssh';

  const command = [
    ssh === 'ssh' ? 'ssh' : shellPath(ssh),
    '-i', shellPath(keyFile),
    // Offer this key and nothing else: an agent or a stray key in the service
    // account's profile would otherwise be tried first and be refused.
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${shellPath(knownHosts)}`,
    // A service has no terminal, so a prompt is a hang.
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
  ].join(' ');

  return {
    env: { GIT_SSH_COMMAND: command },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export class GitClient {
  constructor(private readonly options: GitOptions) {}

  /** True when this client is set up to sign in with a deploy key. */
  get usesDeployKey(): boolean {
    return Boolean(this.options.sshPrivateKey);
  }

  private async withCredentials(
    url: string,
  ): Promise<{ args: string[]; env: Record<string, string>; cleanup: () => Promise<void> }> {
    if (isSshUrl(url)) {
      if (!this.options.sshPrivateKey) {
        throw new GitError(
          'This repository uses an SSH address, which needs a deploy key. Add one on the ' +
            'website\u2019s Git page, or switch to the https:// address.',
        );
      }

      const ssh = await createSshEnvironment({
        gitPath: this.options.gitPath,
        privateKey: this.options.sshPrivateKey,
        ...(this.options.knownHostsPath ? { knownHostsPath: this.options.knownHostsPath } : {}),
      });

      return { args: [], env: ssh.env, cleanup: ssh.cleanup };
    }

    const credentials = await createCredentialArgs(url, this.options.token);
    return { args: credentials.args, env: {}, cleanup: credentials.cleanup };
  }

  private async run(
    args: string[],
    cwd?: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const env: Record<string, string> = {
      // Never prompt: a service has no terminal, and a prompt would hang the
      // deploy until it timed out with no useful message.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      ...extraEnv,
    };

    let result;
    try {
      result = await runCommand({
        exe: this.options.gitPath,
        args,
        cwd,
        env,
        timeoutMs: 10 * 60 * 1000,
        onOutput: (line) => this.options.onOutput?.(line),
      });
    } catch (error) {
      // A missing git.exe surfaces as a raw spawn error naming a path inside
      // the panel's own installation, which tells the user nothing they can
      // act on and leaks where the panel lives.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GitError(
          'Git is not installed on this server. Install it from the Components list on the ' +
            'Settings page, then try again.',
        );
      }
      throw new GitError('Git could not be started on this server.');
    }

    if (result.exitCode !== 0) {
      throw new GitError(explainGitFailure(result.stderr || result.stdout));
    }
    return result.stdout;
  }

  /**
   * Clones a single commit's worth of history into `targetDir`.
   *
   * Shallow and single-branch: a deploy needs the files, not ten years of
   * history, and cloning the lot is slow and wastes disk on every release.
   *
   * Gives back the commit it landed on, because that can only be asked while
   * `.git` is still there and this is what removes it.
   */
  async cloneRelease(url: string, ref: string, targetDir: string): Promise<string | null> {
    const urlCheck = validateRepositoryUrl(url, { allowSsh: this.usesDeployKey });
    if (!urlCheck.ok) throw new GitError(urlCheck.reason);

    const refCheck = validateGitRef(ref);
    if (!refCheck.ok) throw new GitError(refCheck.reason);

    await fs.mkdir(path.dirname(targetDir), { recursive: true });

    const credentials = await this.withCredentials(url);

    try {
      await this.run(
        [
          ...credentials.args,
          'clone',
          '--depth', '1',
          '--single-branch',
          '--branch', ref,
          '--config', 'core.longpaths=true',
          '--',
          url,
          targetDir,
        ],
        undefined,
        credentials.env,
      );
    } finally {
      await credentials.cleanup();
    }

    const commit = await this.headCommit(targetDir);

    // The .git directory is not needed to run the app, and removing it means
    // there is no chance of a remote URL or cached credential surviving into
    // the release folder.
    await fs.rm(path.join(targetDir, '.git'), { recursive: true, force: true });

    return commit;
  }

  /**
   * Reads the commit a checkout is on, for the deployment record.
   *
   * Only meaningful while the checkout still has its `.git` folder. Asking
   * afterwards is not an error worth reporting — git says "not a git
   * repository", which in a deployment log reads like the clone failed.
   */
  async headCommit(repoDir: string): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', 'HEAD'], repoDir)).trim();
    } catch {
      return null;
    }
  }

  /**
   * The most recent commits on a branch, without checking anything out.
   *
   * A deploy clone is shallow and has its `.git` removed, so it cannot answer
   * "what has changed since?" — which is the question you actually have in
   * front of a deploy button. A small bare mirror is kept beside the site and
   * refreshed on demand instead: fetching a handful of commits costs a second,
   * and nothing about it is ever executed or served.
   */
  async recentCommits(options: {
    url: string;
    ref: string;
    /** Bare repository kept for this site. Created on first use. */
    cacheDir: string;
    limit?: number;
  }): Promise<CommitSummary[]> {
    const urlCheck = validateRepositoryUrl(options.url, { allowSsh: this.usesDeployKey });
    if (!urlCheck.ok) throw new GitError(urlCheck.reason);

    const refCheck = validateGitRef(options.ref);
    if (!refCheck.ok) throw new GitError(refCheck.reason);

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const depth = Math.max(limit, 20);
    const credentials = await this.withCredentials(options.url);
    const mirrored = await exists(path.join(options.cacheDir, 'HEAD'));

    try {
      if (mirrored) {
        await this.run(
          [
            ...credentials.args,
            '--git-dir', options.cacheDir,
            'fetch',
            '--depth', String(depth),
            '--force',
            '--',
            options.url,
            `${options.ref}:refs/heads/${options.ref}`,
          ],
          undefined,
          credentials.env,
        );
      } else {
        // A half-written mirror from an interrupted clone would never repair
        // itself, so start from nothing.
        await fs.rm(options.cacheDir, { recursive: true, force: true });
        await fs.mkdir(path.dirname(options.cacheDir), { recursive: true });

        await this.run(
          [
            ...credentials.args,
            'clone',
            '--bare',
            '--depth', String(depth),
            '--single-branch',
            '--branch', options.ref,
            '--',
            options.url,
            options.cacheDir,
          ],
          undefined,
          credentials.env,
        );
      }
    } finally {
      await credentials.cleanup();
    }

    // Unit separator between fields and record separator between commits, so
    // a commit message containing anything at all still parses.
    const output = await this.run([
      '--git-dir', options.cacheDir,
      'log',
      '--max-count', String(limit),
      '--format=%H%x1f%an%x1f%aI%x1f%s%x1e',
      `refs/heads/${options.ref}`,
    ]);

    return output
      .split('\u001e')
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record) => {
        const [sha = '', author = '', at = '', subject = ''] = record.split('\u001f');
        return {
          sha,
          shortSha: sha.slice(0, 7),
          author,
          at,
          subject: subject.slice(0, 200),
        };
      });
  }

  /** Confirms the repository and branch are reachable before a deploy starts. */
  async testAccess(url: string, ref: string): Promise<{ ok: boolean; message: string }> {
    const urlCheck = validateRepositoryUrl(url, { allowSsh: this.usesDeployKey });
    if (!urlCheck.ok) return { ok: false, message: urlCheck.reason };

    const refCheck = validateGitRef(ref);
    if (!refCheck.ok) return { ok: false, message: refCheck.reason };

    let credentials;
    try {
      credentials = await this.withCredentials(url);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not connect.',
      };
    }

    try {
      const output = await this.run(
        [...credentials.args, 'ls-remote', '--heads', '--', url, ref],
        undefined,
        credentials.env,
      );

      if (output.trim().length === 0) {
        return {
          ok: false,
          message: `The repository was found, but it has no branch called "${ref}".`,
        };
      }

      if (this.usesDeployKey) {
        return { ok: true, message: 'Connected using the deploy key. The key is installed correctly.' };
      }

      return {
        ok: true,
        message: this.options.token
          ? 'Connected using your access token.'
          : 'Connected. This repository is public.',
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not connect.' };
    } finally {
      await credentials.cleanup();
    }
  }
}

/** Turns git's output into something worth showing a person. */
export function explainGitFailure(output: string): string {
  const text = output.toLowerCase();

  // SSH failures first: they are worded nothing like the https ones, and
  // "permission denied" here always means the deploy key, never a password.
  if (text.includes('permission denied (publickey')) {
    return (
      'The repository refused the deploy key. Add the key shown on this page to the ' +
      'repository\u2019s Deploy keys, then try again \u2014 it has to be added to this exact ' +
      'repository, not to your account.'
    );
  }
  if (text.includes('host key verification failed')) {
    return (
      'The server could not confirm the identity of the code host. If nothing about the ' +
      'host has changed, try again in a minute.'
    );
  }
  if (text.includes('could not resolve hostname')) {
    return 'That address does not name a server this machine can find. Check it for typos.';
  }

  if (text.includes('authentication failed') || text.includes('could not read username')) {
    return (
      'The repository refused the sign-in. If it is private, add an access token; if you ' +
      'already have one, check it has not expired and can read this repository.'
    );
  }
  if (text.includes('repository not found') || text.includes('does not exist')) {
    // GitHub returns "not found" rather than "forbidden" for a private repo
    // you cannot see, so the real cause is usually missing access.
    return (
      'That repository could not be found. If it is private, add a deploy key or an access ' +
      'token that can read it \u2014 private repositories look missing until then.'
    );
  }
  if (text.includes('remote branch') && text.includes('not found')) {
    return 'That branch does not exist in the repository.';
  }
  if (text.includes('could not resolve host')) {
    return 'Could not reach the repository host. Check the server\u2019s internet connection.';
  }
  if (text.includes('permission denied')) {
    return 'Permission was refused by the repository.';
  }
  if (text.includes('filename too long')) {
    return (
      'Some file names in this repository are too long for Windows. ' +
      'Turn on "Long file names allowed" on the Server health page.'
    );
  }

  const firstLine = output.trim().split('\n').find((line) => line.trim().length > 0);
  return firstLine ? `Git reported: ${firstLine.trim()}` : 'The repository could not be downloaded.';
}
