import { describe, expect, it } from 'vitest';
import {
  CreateUserRequest,
  ROLE_LABELS,
  UpdateUserRequest,
  UserRole,
  roleAtLeast,
} from '../src/user.js';

/**
 * The role model, which both halves of the panel and every authorisation
 * check depend on agreeing about.
 */

describe('roles', () => {
  it('ranks the owner above an administrator above a customer', () => {
    expect(roleAtLeast('superadmin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'user')).toBe(true);
    expect(roleAtLeast('user', 'user')).toBe(true);

    expect(roleAtLeast('admin', 'superadmin')).toBe(false);
    expect(roleAtLeast('user', 'admin')).toBe(false);
  });

  it('has a name and an explanation for every role', () => {
    // The panel never shows the internal name to anybody, so a role without a
    // label would appear as a blank badge.
    for (const role of UserRole.options) {
      expect(ROLE_LABELS[role].label, role).toBeTruthy();
      expect(ROLE_LABELS[role].description, role).toBeTruthy();
    }
  });
});

describe('creating an account', () => {
  const valid = {
    username: 'freya',
    password: 'a-password-long-enough',
    role: 'user' as const,
  };

  it('treats an unspecified limit as no limit', () => {
    const parsed = CreateUserRequest.parse(valid);

    expect(parsed.siteLimit).toBeNull();
    expect(parsed.mailQuotaBytes).toBeNull();
    expect(parsed.siteDiskQuotaBytes).toBeNull();
  });

  it('accepts a limit of none at all', () => {
    // An account that may hold no websites yet is a real answer, and must not
    // be confused with "no limit".
    expect(CreateUserRequest.parse({ ...valid, siteLimit: 0 }).siteLimit).toBe(0);
  });

  it('rejects a username that would be awkward in a folder name or a URL', () => {
    for (const username of ['a', 'has space', 'has/slash', '../..', '']) {
      expect(CreateUserRequest.safeParse({ ...valid, username }).success, username).toBe(false);
    }
  });

  it('rejects a short password', () => {
    expect(CreateUserRequest.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('rejects a role that does not exist', () => {
    expect(CreateUserRequest.safeParse({ ...valid, role: 'owner' }).success).toBe(false);
  });
});

describe('changing an account', () => {
  it('leaves out what was not asked for', () => {
    /*
     * The difference between "not mentioned" and "set to no limit" is the
     * whole reason the limits are optional here: a form that only edits the
     * role must not silently clear somebody's quotas.
     */
    const parsed = UpdateUserRequest.parse({
      userId: '5b1f4b1e-5f6e-4a4e-9a5b-1f4b1e5f6e4a',
      role: 'admin',
    });

    expect(parsed).toEqual({ userId: '5b1f4b1e-5f6e-4a4e-9a5b-1f4b1e5f6e4a', role: 'admin' });
    expect('siteLimit' in parsed).toBe(false);
  });

  it('needs a real account id', () => {
    expect(UpdateUserRequest.safeParse({ userId: 'freya', role: 'admin' }).success).toBe(false);
  });
});
