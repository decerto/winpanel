import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretVault, VaultError } from '../src/security/vault.js';

let tmpDir: string;
let keyFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-vault-'));
  keyFile = path.join(tmpDir, 'vault.key');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SecretVault', () => {
  it('creates a key on first use and round-trips a secret', async () => {
    const vault = new SecretVault(keyFile);
    await vault.initialise();

    const secret = 'cf_token_abc123';
    const sealed = vault.encrypt(secret, 'cloudflare.token');
    expect(sealed).not.toContain(secret);
    expect(vault.decrypt(sealed, 'cloudflare.token')).toBe(secret);
  });

  it('protects the master key with DPAPI on Windows', async () => {
    const vault = new SecretVault(keyFile);
    await vault.initialise();
    expect(vault.isHardwareProtected).toBe(process.platform === 'win32');
  });

  it('reuses the same key across restarts', async () => {
    const first = new SecretVault(keyFile);
    await first.initialise();
    const sealed = first.encrypt('persisted', 'site.env:demo');

    const second = new SecretVault(keyFile);
    await second.initialise();
    expect(second.decrypt(sealed, 'site.env:demo')).toBe('persisted');
  });

  it('refuses to decrypt a secret under a different context', async () => {
    // Context is bound as AAD, so a ciphertext cannot be moved between
    // fields — lifting a site's env var into the Cloudflare token slot fails.
    const vault = new SecretVault(keyFile);
    await vault.initialise();

    const sealed = vault.encrypt('value', 'site.env:alpha');
    expect(() => vault.decrypt(sealed, 'site.env:beta')).toThrow(VaultError);
    expect(() => vault.decrypt(sealed, 'cloudflare.token')).toThrow(VaultError);
    expect(vault.decrypt(sealed, 'site.env:alpha')).toBe('value');
  });

  it('detects tampering with the ciphertext', async () => {
    const vault = new SecretVault(keyFile);
    await vault.initialise();

    const sealed = vault.encrypt('important', 'ctx');
    const bytes = Buffer.from(sealed, 'base64');
    // Flip a bit in the ciphertext; GCM's auth tag must reject it.
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);

    expect(() => vault.decrypt(bytes.toString('base64'), 'ctx')).toThrow(VaultError);
  });

  it('produces a different ciphertext each time for the same input', async () => {
    const vault = new SecretVault(keyFile);
    await vault.initialise();

    const a = vault.encrypt('same', 'ctx');
    const b = vault.encrypt('same', 'ctx');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a, 'ctx')).toBe(vault.decrypt(b, 'ctx'));
  });

  it('rejects a corrupted key file with a clear message', async () => {
    await fs.writeFile(keyFile, 'not json at all');
    const vault = new SecretVault(keyFile);
    await expect(vault.initialise()).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses to encrypt before it is unlocked', () => {
    const vault = new SecretVault(keyFile);
    expect(() => vault.encrypt('x', 'ctx')).toThrow(VaultError);
  });

  it('clears the key from memory when locked', async () => {
    const vault = new SecretVault(keyFile);
    await vault.initialise();
    vault.lock();
    expect(() => vault.encrypt('x', 'ctx')).toThrow(VaultError);
  });
});
