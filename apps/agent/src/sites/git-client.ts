import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand } from '../process/run-command.js';

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
  onOutput?: (line: string) => void;
}

/** Rejects URLs git would treat as something other than a remote fetch. */
export function validateRepositoryUrl(url: string): { ok: true } | { ok: false; reason: string } {
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

  // SSH addresses would need a deploy key and a known_hosts entry on the
  // server. Rather than half-supporting that, point at the option that works
  // today and takes thirty seconds to set up.
  if (/^(git@|ssh:\/\/)/i.test(trimmed)) {
    return {
      ok: false,
      reason:
        'Use the https:// address instead of the SSH one, for example ' +
        'https://github.com/you/your-project.git. For a private repository, add an ' +
        'access token below.',
    };
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

export class GitClient {
  constructor(private readonly options: GitOptions) {}

  private async withCredentials(
    url: string,
  ): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
    return await createCredentialArgs(url, this.options.token);
  }

  private async run(args: string[], cwd?: string): Promise<string> {
    const env: Record<string, string> = {
      // Never prompt: a service has no terminal, and a prompt would hang the
      // deploy until it timed out with no useful message.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    };

    const result = await runCommand({
      exe: this.options.gitPath,
      args,
      cwd,
      env,
      timeoutMs: 10 * 60 * 1000,
      onOutput: (line) => this.options.onOutput?.(line),
    });

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
   */
  async cloneRelease(url: string, ref: string, targetDir: string): Promise<void> {
    const urlCheck = validateRepositoryUrl(url);
    if (!urlCheck.ok) throw new GitError(urlCheck.reason);

    const refCheck = validateGitRef(ref);
    if (!refCheck.ok) throw new GitError(refCheck.reason);

    await fs.mkdir(path.dirname(targetDir), { recursive: true });

    const credentials = await this.withCredentials(url);

    try {
      await this.run([
        ...credentials.args,
        'clone',
        '--depth', '1',
        '--single-branch',
        '--branch', ref,
        '--config', 'core.longpaths=true',
        '--',
        url,
        targetDir,
      ]);
    } finally {
      await credentials.cleanup();
    }

    // The .git directory is not needed to run the app, and removing it means
    // there is no chance of a remote URL or cached credential surviving into
    // the release folder.
    await fs.rm(path.join(targetDir, '.git'), { recursive: true, force: true });
  }

  /** Reads the commit a clone landed on, for the deployment record. */
  async headCommit(repoDir: string): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', 'HEAD'], repoDir)).trim();
    } catch {
      return null;
    }
  }

  /** Confirms the repository and branch are reachable before a deploy starts. */
  async testAccess(url: string, ref: string): Promise<{ ok: boolean; message: string }> {
    const urlCheck = validateRepositoryUrl(url);
    if (!urlCheck.ok) return { ok: false, message: urlCheck.reason };

    const refCheck = validateGitRef(ref);
    if (!refCheck.ok) return { ok: false, message: refCheck.reason };

    const credentials = await this.withCredentials(url);

    try {
      const output = await this.run([
        ...credentials.args,
        'ls-remote',
        '--heads',
        '--',
        url,
        ref,
      ]);

      if (output.trim().length === 0) {
        return {
          ok: false,
          message: `The repository was found, but it has no branch called "${ref}".`,
        };
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

  if (text.includes('authentication failed') || text.includes('could not read username')) {
    return (
      'The repository refused the sign-in. If it is private, add an access token; if you ' +
      'already have one, check it has not expired and can read this repository.'
    );
  }
  if (text.includes('repository not found') || text.includes('does not exist')) {
    // GitHub returns "not found" rather than "forbidden" for a private repo
    // you cannot see, so the real cause is usually a missing or wrong token.
    return (
      'That repository could not be found. If it is private, add an access token that ' +
      'can read it \u2014 private repositories look missing until then.'
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
