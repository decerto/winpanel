import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GitClient,
  createCredentialArgs,
  credentialUsernameFor,
  explainGitFailure,
  validateGitRef,
  validateRepositoryUrl,
} from '../src/sites/git-client.js';
import { redactSecrets, serviceIdFor } from '../src/sites/deploy-handler.js';

describe('validateRepositoryUrl', () => {
  it('accepts ordinary https addresses', () => {
    for (const url of [
      'https://github.com/user/project.git',
      'https://gitlab.com/group/project',
      'https://bitbucket.org/team/project.git',
      'https://dev.azure.com/org/project/_git/repo',
    ]) {
      expect(validateRepositoryUrl(url).ok, url).toBe(true);
    }
  });

  it('rejects SSH addresses unless a deploy key is being used', () => {
    // Without a key there is no identity to offer, and git would sit waiting
    // for a password no service can type. With one, SSH is the normal route.
    for (const url of ['git@github.com:user/project.git', 'ssh://git@github.com/u/p.git']) {
      const result = validateRepositoryUrl(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/deploy key/i);

      expect(validateRepositoryUrl(url, { allowSsh: true }).ok, url).toBe(true);
    }
  });

  it('rejects an address that git would read as an option', () => {
    // `--upload-pack=cmd` makes git execute an arbitrary command. Arguments
    // are already passed as an array, but a leading dash is still refused.
    for (const url of ['--upload-pack=calc.exe', '-c', '--config=x']) {
      expect(validateRepositoryUrl(url).ok, url).toBe(false);
    }
  });

  it('rejects the ext:: transport, which runs a command', () => {
    expect(validateRepositoryUrl('ext::sh -c "calc.exe"').ok).toBe(false);
    expect(validateRepositoryUrl('EXT::whatever').ok).toBe(false);
  });

  it('rejects local paths and unusual schemes', () => {
    for (const url of ['file:///C:/Windows', 'C:\\Windows\\System32', '/etc/passwd']) {
      expect(validateRepositoryUrl(url).ok, url).toBe(false);
    }
  });

  it('rejects null bytes and empty input', () => {
    expect(validateRepositoryUrl('https://x.com/a\u0000b').ok).toBe(false);
    expect(validateRepositoryUrl('   ').ok).toBe(false);
  });

  it('explains the expected format', () => {
    const result = validateRepositoryUrl('github.com/user/project');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('https://');
  });
});

describe('validateGitRef', () => {
  it('accepts ordinary branch and tag names', () => {
    for (const ref of ['main', 'develop', 'release/2026-01', 'v1.2.3', 'feature/new-ui']) {
      expect(validateGitRef(ref).ok, ref).toBe(true);
    }
  });

  it('rejects a branch name that git would read as an option', () => {
    expect(validateGitRef('--upload-pack=x').ok).toBe(false);
    expect(validateGitRef('-x').ok).toBe(false);
  });

  it('rejects characters git does not allow in refs', () => {
    for (const ref of ['bad name', 'bad~name', 'bad^name', 'bad:name', 'bad?name', 'bad*']) {
      expect(validateGitRef(ref).ok, ref).toBe(false);
    }
  });

  it('rejects double dots, which git treats as a range', () => {
    expect(validateGitRef('main..develop').ok).toBe(false);
  });
});

describe('credentialUsernameFor', () => {
  it('uses the username each host actually expects', () => {
    // Getting this wrong produces a bare "authentication failed" with no clue
    // as to why, so each host is handled explicitly.
    expect(credentialUsernameFor('github.com')).toBe('x-access-token');
    expect(credentialUsernameFor('gitlab.com')).toBe('oauth2');
    expect(credentialUsernameFor('gitlab.mycompany.net')).toBe('oauth2');
    expect(credentialUsernameFor('bitbucket.org')).toBe('x-token-auth');
    expect(credentialUsernameFor('dev.azure.com')).toBe('pat');
  });

  it('falls back to a sensible default for self-hosted servers', () => {
    expect(credentialUsernameFor('git.mycompany.internal')).toBe('x-access-token');
  });
});

describe('private repository credentials', () => {
  const TOKEN = 'ghp_thisisaverysecrettokenvalue123';

  it('never places the token in the command line arguments', async () => {
    /*
     * The important one. On Windows any account can read another process's
     * arguments through WMI, so a token embedded in the clone URL would be
     * readable by anything running on the box while the clone is in flight.
     */
    const credentials = await createCredentialArgs(
      'https://github.com/me/private.git',
      TOKEN,
    );

    try {
      const joined = credentials.args.join(' ');
      expect(joined).not.toContain(TOKEN);
      expect(joined).toContain('credential.helper=store');
    } finally {
      await credentials.cleanup();
    }
  });

  it('puts the token in a private file that is removed afterwards', async () => {
    const credentials = await createCredentialArgs(
      'https://github.com/me/private.git',
      TOKEN,
    );

    expect(credentials.file).not.toBeNull();
    const contents = await fs.readFile(credentials.file!, 'utf8');

    // The token is present in the file, with the username GitHub expects.
    expect(contents).toContain(TOKEN);
    expect(contents).toContain('x-access-token');
    expect(contents).toContain('github.com');

    await credentials.cleanup();

    // And gone once the operation finishes.
    await expect(fs.readFile(credentials.file!, 'utf8')).rejects.toThrow();
  });

  it('uses the right username for each host', async () => {
    const cases: Array<[string, string]> = [
      ['https://github.com/a/b.git', 'x-access-token'],
      ['https://gitlab.com/a/b.git', 'oauth2'],
      ['https://bitbucket.org/a/b.git', 'x-token-auth'],
    ];

    for (const [url, expected] of cases) {
      const credentials = await createCredentialArgs(url, TOKEN);
      const contents = await fs.readFile(credentials.file!, 'utf8');
      expect(contents, url).toContain(expected);
      await credentials.cleanup();
    }
  });

  it('escapes a token containing characters that would break the URL', async () => {
    // Some providers issue tokens containing / or +, which would otherwise
    // corrupt the credential line and produce a baffling auth failure.
    const awkward = 'abc/def+ghi:jkl@mno';
    const credentials = await createCredentialArgs('https://github.com/a/b.git', awkward);

    const contents = await fs.readFile(credentials.file!, 'utf8');
    expect(contents).toContain(encodeURIComponent(awkward));
    expect(contents.split('@').length).toBe(2);

    await credentials.cleanup();
  });

  it('resets the credential helper even when there is no token', async () => {
    // Without this, a stale entry in Windows Credential Manager can make a
    // public clone fail in a way that makes no sense to anyone.
    const credentials = await createCredentialArgs('https://github.com/a/b.git');

    expect(credentials.args).toEqual(['-c', 'credential.helper=']);
    expect(credentials.file).toBeNull();
    await credentials.cleanup();
  });

  it('reports a connection failure rather than throwing', async () => {
    const client = new GitClient({ gitPath: 'definitely-not-git-at-all' });
    const result = await client.testAccess('https://github.com/x/y.git', 'main');

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('explainGitFailure', () => {
  it('explains an authentication failure and how to fix it', () => {
    const message = explainGitFailure('remote: Authentication failed for https://github.com/x');
    expect(message).toMatch(/access token/i);
    expect(message).toMatch(/expired/i);
    expect(message).not.toMatch(/fatal|remote:/i);
  });

  it('explains that a private repository looks missing without a token', () => {
    // GitHub returns "not found" rather than "forbidden" for a private repo
    // you cannot see, which sends people hunting for a typo that isn't there.
    const message = explainGitFailure('ERROR: Repository not found.');
    expect(message).toMatch(/private/i);
    expect(message).toMatch(/access token/i);
  });

  it('explains a missing branch', () => {
    expect(
      explainGitFailure("fatal: Remote branch nope not found in upstream origin"),
    ).toMatch(/branch does not exist/i);
  });

  it('explains a DNS failure as a connectivity problem', () => {
    expect(explainGitFailure('fatal: unable to access ... Could not resolve host: github.com'))
      .toMatch(/internet connection/i);
  });

  it('points at the long-paths setting for the Windows path limit', () => {
    // This is a Windows-specific trap, and the fix lives on the Health page.
    const message = explainGitFailure('error: unable to create file ...: Filename too long');
    expect(message).toMatch(/long file names/i);
    expect(message).toMatch(/server health/i);
  });

  it('falls back to the first line rather than an empty message', () => {
    expect(explainGitFailure('fatal: something unusual happened')).toContain('something unusual');
  });
});

describe('redactSecrets', () => {
  it('removes credentials embedded in a URL', () => {
    const line = 'Cloning into https://x-access-token:ghp_supersecretvalue123@github.com/a/b';
    const redacted = redactSecrets(line);

    expect(redacted).not.toContain('ghp_supersecretvalue123');
    expect(redacted).toContain('https://***@');
  });

  it('removes a bare GitHub token', () => {
    const redacted = redactSecrets('using token ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(redacted).toContain('***');
  });

  it('removes tokens passed as query parameters', () => {
    const redacted = redactSecrets('GET /repo?access_token=secretvalue&page=1');
    expect(redacted).not.toContain('secretvalue');
    expect(redacted).toContain('page=1');
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'Resolving deltas: 100% (42/42), done.';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('serviceIdFor', () => {
  it('gives each colour its own service so both can exist at once', () => {
    // Blue/green needs both versions installed simultaneously: the new one
    // has to be running and healthy before traffic moves.
    expect(serviceIdFor('kitora', 'blue')).toBe('winpanel-site-kitora-blue');
    expect(serviceIdFor('kitora', 'green')).toBe('winpanel-site-kitora-green');
    expect(serviceIdFor('kitora', 'blue')).not.toBe(serviceIdFor('kitora', 'green'));
  });

  it('namespaces services so ours are identifiable in services.msc', () => {
    expect(serviceIdFor('example', 'blue')).toMatch(/^winpanel-/);
  });
});
