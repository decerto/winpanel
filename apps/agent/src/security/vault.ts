import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../process/run-command.js';

/**
 * Encryption at rest for the Cloudflare token, git credentials, site
 * environment variables, the Stalwart admin password, and the low-privilege
 * build account's password.
 *
 * Design: a random 32-byte master key encrypts each secret with AES-256-GCM.
 * The master key itself is wrapped with Windows DPAPI at machine scope, so
 * the key file is worthless if copied to another machine — an attacker needs
 * code execution on this box, not just a copy of the disk.
 *
 * DPAPI is reached through PowerShell's ProtectedData rather than a native
 * addon, which keeps the agent free of compiled dependencies. It runs exactly
 * twice per process lifetime (unwrap at startup, wrap at first run), so the
 * cost of spawning PowerShell is irrelevant.
 *
 * On non-Windows (test and CI only) the master key is stored unwrapped and the
 * vault reports `protected: false`, which the Health page surfaces as a
 * warning. Production is always Windows.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class VaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultError';
  }
}

/** Wraps bytes with DPAPI at machine scope via PowerShell. */
async function dpapiProtect(plaintext: Buffer): Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$in = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($in);',
    '$out = [System.Security.Cryptography.ProtectedData]::Protect(',
    '  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine);',
    '[Console]::Out.Write([Convert]::ToBase64String($out));',
  ].join(' ');

  const result = await runCommand({
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    stdin: plaintext.toString('base64'),
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new VaultError(`Could not protect the vault key. ${result.stderr.trim()}`);
  }
  return Buffer.from(result.stdout.trim(), 'base64');
}

/** Unwraps DPAPI-protected bytes. */
async function dpapiUnprotect(ciphertext: Buffer): Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$in = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($in);',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect(',
    '  $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine);',
    '[Console]::Out.Write([Convert]::ToBase64String($out));',
  ].join(' ');

  const result = await runCommand({
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    stdin: ciphertext.toString('base64'),
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new VaultError(
      'Could not unlock the vault. This usually means the data folder was copied ' +
        'from another machine, or Windows was reinstalled.',
    );
  }
  return Buffer.from(result.stdout.trim(), 'base64');
}

interface KeyFile {
  version: 1;
  /** Whether `key` is DPAPI-wrapped. False only on non-Windows dev/CI. */
  protected: boolean;
  key: string;
}

export class SecretVault {
  #masterKey: Buffer | null = null;
  #protected = false;

  constructor(private readonly keyFilePath: string) {}

  /** True when the master key is DPAPI-wrapped (i.e. running on Windows). */
  get isHardwareProtected(): boolean {
    return this.#protected;
  }

  /** Loads the master key, creating one on first run. */
  async initialise(): Promise<void> {
    if (this.#masterKey) return;

    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.keyFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (raw === null) {
      await this.#createKey();
      return;
    }

    let parsed: KeyFile;
    try {
      parsed = JSON.parse(raw) as KeyFile;
    } catch (error) {
      throw new VaultError('The vault key file is corrupted.', { cause: error });
    }

    const stored = Buffer.from(parsed.key, 'base64');
    this.#masterKey = parsed.protected ? await dpapiUnprotect(stored) : stored;
    this.#protected = parsed.protected;

    if (this.#masterKey.length !== KEY_BYTES) {
      throw new VaultError('The vault key file is corrupted.');
    }
  }

  async #createKey(): Promise<void> {
    const key = crypto.randomBytes(KEY_BYTES);
    const useDpapi = process.platform === 'win32';
    const stored = useDpapi ? await dpapiProtect(key) : key;

    const payload: KeyFile = {
      version: 1,
      protected: useDpapi,
      key: stored.toString('base64'),
    };

    await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
    // Written 0600 so that even before ACLs are applied the key is not
    // world-readable on any platform.
    await fs.writeFile(this.keyFilePath, JSON.stringify(payload), { mode: 0o600 });

    this.#masterKey = key;
    this.#protected = useDpapi;
  }

  #requireKey(): Buffer {
    if (!this.#masterKey) {
      throw new VaultError('The vault has not been unlocked yet.');
    }
    return this.#masterKey;
  }

  /**
   * Encrypts a secret. The returned string is safe to store in SQLite.
   *
   * `context` is bound as additional authenticated data, so a ciphertext
   * cannot be lifted from one field and replayed into another — moving a
   * site's env var into the Cloudflare token slot will fail to decrypt.
   */
  encrypt(plaintext: string, context: string): string {
    const key = this.#requireKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string, context: string): string {
    const key = this.#requireKey();
    const raw = Buffer.from(ciphertext, 'base64');

    if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new VaultError('That stored secret is corrupted.');
    }

    const iv = raw.subarray(0, IV_BYTES);
    const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(authTag);

    try {
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new VaultError('That stored secret could not be read.', { cause: error });
    }
  }

  /** Clears the key from memory. Called on shutdown. */
  lock(): void {
    this.#masterKey?.fill(0);
    this.#masterKey = null;
  }
}
