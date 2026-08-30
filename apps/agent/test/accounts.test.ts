import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/index.js';
import { sites } from '../src/db/schema.js';
import { SecretVault } from '../src/security/vault.js';
import { AuthService, AuthError } from '../src/services/auth-service.js';
import { domainCovers, scopeOf } from '../src/api/trpc.js';
import { allocatedMailBytes, countMailboxes } from '../src/api/routers/mail.js';

/**
 * The three-role model: who exists, what they are allowed to hold, and how a
 * request is matched to the account that owns its subject.
 *
 * These are the rules that keep one customer out of another's website, so
 * they are tested against the real database rather than a mock of it.
 */

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');
const PASSWORD = 'a-password-long-enough';

let tmpDir: string;
let handle: DatabaseHandle;

async function ownerService(): Promise<{ auth: AuthService; ownerId: string }> {
  const vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();

  const auth = new AuthService(handle, vault, path.join(tmpDir, 'setup-token.txt'));
  const setupToken = await auth.ensureSetupToken();
  const { user } = await auth.completeSetup({
    setupToken,
    username: 'owner',
    password: PASSWORD,
  });

  return { auth, ownerId: user.id };
}

/** A website row is enough to test ownership; no files are involved. */
function giveSite(ownerUserId: string | null, slug: string, domains: string[]): void {
  handle.db
    .insert(sites)
    .values({
      id: crypto.randomUUID(),
      slug,
      displayName: slug,
      ownerUserId,
      runtime: 'static',
      domains,
      source: { kind: 'upload' },
      manifest: {},
    })
    .run();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-accounts-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the first account', () => {
  it('becomes the owner of the server', async () => {
    const { auth, ownerId } = await ownerService();

    // Whoever installs the panel is the one person who cannot be locked out
    // of it, so setup has to hand out the top role rather than ask for one.
    expect(auth.getUser(ownerId)?.role).toBe('superadmin');
    expect(auth.countOwners()).toBe(1);
  });
});

describe('managing accounts', () => {
  it('creates a customer with the limits it was given', async () => {
    const { auth, ownerId } = await ownerService();

    const customer = await auth.createUser({
      username: 'freya',
      password: PASSWORD,
      role: 'user',
      siteLimit: 3,
      mailQuotaBytes: 5 * 1024 ** 3,
      siteDiskQuotaBytes: 20 * 1024 ** 3,
      createdBy: ownerId,
    });

    expect(customer.role).toBe('user');
    expect(customer.siteLimit).toBe(3);
    expect(customer.mailQuotaBytes).toBe(5 * 1024 ** 3);
    expect(customer.siteCount).toBe(0);
  });

  it('never caps an administrator', async () => {
    // An admin capped at two websites would be an admin in name only, and the
    // number would sit in the database waiting to surprise somebody.
    const { auth } = await ownerService();

    const admin = await auth.createUser({
      username: 'sam',
      password: PASSWORD,
      role: 'admin',
      siteLimit: 2,
      mailQuotaBytes: 1024,
      siteDiskQuotaBytes: 1024,
    });

    expect(admin.siteLimit).toBeNull();
    expect(admin.mailQuotaBytes).toBeNull();
    expect(admin.siteDiskQuotaBytes).toBeNull();
  });

  it('drops the limits when a customer is promoted', async () => {
    const { auth } = await ownerService();
    const customer = await auth.createUser({
      username: 'freya',
      password: PASSWORD,
      role: 'user',
      siteLimit: 1,
    });

    expect(auth.updateUser(customer.id, { role: 'admin' }).siteLimit).toBeNull();
  });

  it('refuses a username somebody already has', async () => {
    const { auth } = await ownerService();
    await auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' });

    await expect(
      auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' }),
    ).rejects.toMatchObject({ code: 'username-taken' });
  });

  it('counts the websites each account holds', async () => {
    const { auth, ownerId } = await ownerService();
    const customer = await auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' });

    giveSite(customer.id, 'freya-io', ['freya.io']);
    giveSite(customer.id, 'freya-blog', []);
    giveSite(null, 'the-servers-own', []);

    const listed = auth.listUsers();
    expect(listed.find((person) => person.id === customer.id)?.siteCount).toBe(2);
    expect(listed.find((person) => person.id === ownerId)?.siteCount).toBe(0);
  });

  it('will not leave the server without an owner', async () => {
    /*
     * The one account that cannot be demoted, switched off or deleted while
     * it is the last of its kind. Losing it would leave a running server that
     * nobody can update, restart or take a website off.
     */
    const { auth, ownerId } = await ownerService();

    expect(() => auth.updateUser(ownerId, { role: 'admin' })).toThrow(AuthError);
    expect(() => auth.updateUser(ownerId, { disabled: true })).toThrow(/only owner/i);
    expect(() => auth.deleteUser(ownerId)).toThrow(/only owner/i);

    const second = await auth.createUser({
      username: 'second',
      password: PASSWORD,
      role: 'superadmin',
    });

    expect(auth.updateUser(ownerId, { role: 'admin' }).role).toBe('admin');
    expect(auth.countOwners()).toBe(1);
    expect(auth.getUser(second.id)?.role).toBe('superadmin');
  });

  it('signs somebody out the moment their account is switched off', async () => {
    const { auth } = await ownerService();
    const customer = await auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' });
    const { token } = await auth.login({ username: 'freya', password: PASSWORD, ip: '203.0.113.1' });

    expect(auth.resolveSession(token)).not.toBeNull();

    auth.updateUser(customer.id, { disabled: true });

    // Not "until their cookie expires": an account you have just switched off
    // should stop working now.
    expect(auth.resolveSession(token)).toBeNull();
    await expect(
      auth.login({ username: 'freya', password: PASSWORD, ip: '203.0.113.1' }),
    ).rejects.toThrow();
  });

  it('ends every session when a password is reset for somebody', async () => {
    // The usual reason for a reset is that somebody else knew the old one.
    const { auth } = await ownerService();
    const customer = await auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' });
    const { token } = await auth.login({ username: 'freya', password: PASSWORD, ip: '203.0.113.1' });

    await auth.setPassword(customer.id, 'a-brand-new-password');

    expect(auth.resolveSession(token)).toBeNull();
    const again = await auth.login({
      username: 'freya',
      password: 'a-brand-new-password',
      ip: '203.0.113.1',
    });
    expect(again.token).toBeTruthy();
  });

  it('leaves the websites behind when an account is removed', async () => {
    /*
     * Deleting a person must not delete live domains and the files behind
     * them. The websites fall back to the server so an admin can hand them
     * over or remove them deliberately.
     */
    const { auth } = await ownerService();
    const customer = await auth.createUser({ username: 'freya', password: PASSWORD, role: 'user' });
    giveSite(customer.id, 'freya-io', ['freya.io']);

    auth.deleteUser(customer.id);

    const remaining = handle.db.select().from(sites).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ownerUserId).toBeNull();
  });

  it('complains about an account that is not there', async () => {
    const { auth } = await ownerService();

    expect(() => auth.updateUser(crypto.randomUUID(), { disabled: true })).toThrow(AuthError);
    expect(() => auth.deleteUser(crypto.randomUUID())).toThrow(AuthError);
    await expect(auth.setPassword(crypto.randomUUID(), PASSWORD)).rejects.toThrow(AuthError);
  });
});

describe('reading the website out of a request', () => {
  it('finds the slug however the endpoint names it', () => {
    expect(scopeOf({ slug: 'kitora-io' }).slug).toBe('kitora-io');
    expect(scopeOf({ siteSlug: 'kitora-io' }).slug).toBe('kitora-io');
  });

  it('finds the domain, and the domain inside a mailbox address', () => {
    expect(scopeOf({ domain: 'Kitora.IO' }).domain).toBe('kitora.io');
    expect(scopeOf({ address: 'Hello@Kitora.IO' }).domain).toBe('kitora.io');
    // An explicit domain wins; the address is only a fallback.
    expect(scopeOf({ domain: 'a.com', address: 'hello@b.com' }).domain).toBe('a.com');
  });

  it('says nothing when there is nothing to say', () => {
    // An empty scope means "not about a website", which lets the request
    // through — so it must not be produced by a blank or malformed value.
    expect(scopeOf({ slug: '', domain: '' })).toEqual({});
    expect(scopeOf({ address: 'not-an-address' })).toEqual({});
    expect(scopeOf({ slug: 42 })).toEqual({});
    expect(scopeOf(undefined)).toEqual({});
    expect(scopeOf('kitora-io')).toEqual({});
  });
});

describe('which domains an owned domain covers', () => {
  it('covers what sits underneath it', () => {
    expect(domainCovers('example.com', 'example.com')).toBe(true);
    expect(domainCovers('example.com', 'mail.example.com')).toBe(true);
  });

  it('does not reach upwards or sideways', () => {
    /*
     * The direction matters. If owning a subdomain granted the parent, every
     * customer parked on a shared domain would inherit each other's.
     */
    expect(domainCovers('shop.example.com', 'example.com')).toBe(false);
    expect(domainCovers('example.com', 'notexample.com')).toBe(false);
    expect(domainCovers('example.com', 'example.com.attacker.net')).toBe(false);
  });
});

describe('how much of a mail allowance is already taken', () => {
  const box = (address: string, quota: number) => ({ name: address, emails: [address], quota });
  const ALLOWANCE = 10 * 1024 ** 3;

  it('adds up every mailbox', () => {
    // Ten mailboxes of a gigabyte are the same ten gigabytes as one of ten,
    // which is why a per-mailbox limit was never enough on its own.
    const total = allocatedMailBytes(
      [box('a@freya.io', 1024 ** 3), box('b@freya.io', 2 * 1024 ** 3)],
      ALLOWANCE,
      null,
    );

    expect(total).toBe(3 * 1024 ** 3);
  });

  it('does not count the mailbox being resized at its old size', () => {
    const total = allocatedMailBytes(
      [box('a@freya.io', 1024 ** 3), box('b@freya.io', 2 * 1024 ** 3)],
      ALLOWANCE,
      'A@Freya.IO',
    );

    expect(total).toBe(2 * 1024 ** 3);
  });

  it('reads an unlimited mailbox as using everything', () => {
    // Zero is the mail server's word for "no limit". Counting it as nothing
    // would let one unlimited mailbox hide behind an allowance.
    expect(allocatedMailBytes([box('a@freya.io', 0)], ALLOWANCE, null)).toBe(ALLOWANCE);
  });

  it('falls back to the mailbox name when it has no address', () => {
    expect(allocatedMailBytes([{ name: 'a@freya.io', emails: [], quota: 5 }], ALLOWANCE, 'a@freya.io')).toBe(0);
  });

  it('counts individual mailboxes but not non-mailbox principals', () => {
    expect(
      countMailboxes([
        { type: 'individual' },
        { type: 'individual' },
        { type: 'group' },
        { type: 'domain' },
      ]),
    ).toBe(2);
  });
});
