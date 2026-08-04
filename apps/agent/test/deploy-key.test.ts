import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateDeployKey,
  isSshUrl,
  sshHostOf,
  toHttpsUrl,
  toSshUrl,
} from '../src/sites/ssh-keys.js';
import { createSshEnvironment } from '../src/sites/git-client.js';

/**
 * The OpenSSH private key format is written by hand, so it is read back by
 * hand here. If the encoding drifts, ssh refuses the key with "invalid
 * format" at deploy time — long after anyone could connect it to a change.
 */
function parseOpenSshKey(pem: string): {
  publicPoint: Buffer;
  privatePublicPoint: Buffer;
  seedAndPoint: Buffer;
  checksMatch: boolean;
  secretIsBlockAligned: boolean;
} {
  const base64 = pem
    .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
    .replace('-----END OPENSSH PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const body = Buffer.from(base64, 'base64');

  let offset = 0;
  const magic = body.subarray(0, 15).toString('binary');
  offset = 15;

  const readString = (): Buffer => {
    const length = body.readUInt32BE(offset);
    offset += 4;
    const value = body.subarray(offset, offset + length);
    offset += length;
    return value;
  };

  expect(magic).toBe('openssh-key-v1\0');
  expect(readString().toString()).toBe('none');
  expect(readString().toString()).toBe('none');
  expect(readString().length).toBe(0);
  expect(body.readUInt32BE(offset)).toBe(1);
  offset += 4;

  const publicBlob = readString();
  const secret = readString();
  expect(offset).toBe(body.length);

  let publicOffset = 0;
  const readFrom = (buffer: Buffer, at: number): [Buffer, number] => {
    const length = buffer.readUInt32BE(at);
    return [buffer.subarray(at + 4, at + 4 + length), at + 4 + length];
  };

  let field: Buffer;
  [field, publicOffset] = readFrom(publicBlob, publicOffset);
  expect(field.toString()).toBe('ssh-ed25519');
  const [publicPoint] = readFrom(publicBlob, publicOffset);

  let secretOffset = 8;
  [field, secretOffset] = readFrom(secret, secretOffset);
  expect(field.toString()).toBe('ssh-ed25519');

  let privatePublicPoint: Buffer;
  [privatePublicPoint, secretOffset] = readFrom(secret, secretOffset);
  const [seedAndPoint] = readFrom(secret, secretOffset);

  return {
    publicPoint,
    privatePublicPoint,
    seedAndPoint,
    checksMatch: secret.readUInt32BE(0) === secret.readUInt32BE(4),
    secretIsBlockAligned: secret.length % 8 === 0,
  };
}

describe('generateDeployKey', () => {
  it('writes a key ssh can actually read', () => {
    const key = generateDeployKey('winpanel-test');
    const parsed = parseOpenSshKey(key.privateKey);

    expect(key.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(key.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(parsed.checksMatch).toBe(true);
    // The "none" cipher still has a block size, and ssh rejects a short block.
    expect(parsed.secretIsBlockAligned).toBe(true);
    expect(parsed.publicPoint.length).toBe(32);
    // OpenSSH stores seed and public point together as the private field.
    expect(parsed.seedAndPoint.length).toBe(64);
    expect(parsed.seedAndPoint.subarray(32).equals(parsed.publicPoint)).toBe(true);
    expect(parsed.privatePublicPoint.equals(parsed.publicPoint)).toBe(true);
  });

  it('publishes the same key in the one-line form the user pastes', () => {
    const key = generateDeployKey('winpanel-test');
    const [type, blob, comment] = key.publicKey.split(' ');

    expect(type).toBe('ssh-ed25519');
    expect(comment).toBe('winpanel-test');
    expect(Buffer.from(blob ?? '', 'base64').subarray(-32)).toEqual(
      parseOpenSshKey(key.privateKey).publicPoint,
    );
    expect(key.fingerprint.startsWith('SHA256:')).toBe(true);
  });

  it('never repeats a key', () => {
    expect(generateDeployKey().publicKey).not.toBe(generateDeployKey().publicKey);
  });
});

describe('repository address conversion', () => {
  it('recognises both spellings of an SSH address', () => {
    expect(isSshUrl('git@github.com:decerto/ds.git')).toBe(true);
    expect(isSshUrl('ssh://git@github.com/decerto/ds.git')).toBe(true);
    expect(isSshUrl('https://github.com/decerto/ds.git')).toBe(false);
  });

  it('converts to the SSH form a deploy key needs', () => {
    // A deploy key does not authenticate https, so pasting one in and then
    // cloning over https fails as "repository not found".
    expect(toSshUrl('https://github.com/decerto/ds.git')).toBe('git@github.com:decerto/ds.git');
    expect(toSshUrl('https://github.com/decerto/ds')).toBe('git@github.com:decerto/ds.git');
    expect(toSshUrl('git@github.com:decerto/ds.git')).toBe('git@github.com:decerto/ds.git');
  });

  it('converts back for tokens and public repositories', () => {
    expect(toHttpsUrl('git@github.com:decerto/ds.git')).toBe('https://github.com/decerto/ds.git');
    expect(toHttpsUrl('ssh://git@gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project.git',
    );
    expect(toHttpsUrl('https://github.com/decerto/ds.git')).toBe('https://github.com/decerto/ds.git');
  });

  it('reads the host out of either spelling', () => {
    expect(sshHostOf('git@GitHub.com:decerto/ds.git')).toBe('github.com');
    expect(sshHostOf('ssh://git@bitbucket.org/team/repo.git')).toBe('bitbucket.org');
    expect(sshHostOf('https://github.com/decerto/ds.git')).toBe(null);
  });
});

describe('createSshEnvironment', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('hands ssh a key file that disappears again afterwards', async () => {
    const key = generateDeployKey();
    const knownHosts = path.join(os.tmpdir(), 'winpanel-test-hosts', 'known_hosts');

    const ssh = await createSshEnvironment({
      gitPath: 'C:\\panel\\bin\\git\\cmd\\git.exe',
      privateKey: key.privateKey,
      knownHostsPath: knownHosts,
    });

    const command = ssh.env['GIT_SSH_COMMAND'] ?? '';
    const keyFile = /-i "([^"]+)"/.exec(command)?.[1];

    expect(keyFile).toBeTruthy();
    // Git re-parses this through a shell, which would eat the backslashes.
    expect(command).not.toContain('\\');
    expect(command).toContain('IdentitiesOnly=yes');
    expect(command).toContain('BatchMode=yes');
    expect(await fs.readFile(keyFile!.replace(/\//g, path.sep), 'utf8')).toBe(key.privateKey);

    await ssh.cleanup();
    await expect(fs.access(keyFile!.replace(/\//g, path.sep))).rejects.toThrow();

    await fs.rm(path.dirname(knownHosts), { recursive: true, force: true });
  });
});
