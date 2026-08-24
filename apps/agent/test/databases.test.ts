import { describe, expect, it } from 'vitest';
import {
  assertSafeDbName,
  assertSafeLabel,
  pgDollarQuoted,
  sitePrefix,
  sqlStringLiteral,
  userPrefix,
} from '../src/databases/names.js';
import { DatabaseError } from '../src/databases/errors.js';
import { fullDatabaseName } from '../src/databases/service.js';
import { parseFilter } from '../src/databases/browser.js';

/**
 * A database name is interpolated into SQL, so the validator is the whole
 * defence against an injection reaching the database server. These are the
 * shapes it must accept and the ones it must refuse.
 */
describe('assertSafeDbName', () => {
  it('accepts lowercase letters, numbers and underscores', () => {
    expect(assertSafeDbName('wp_abc123_shop')).toBe('wp_abc123_shop');
  });

  it('refuses anything that could break out of the statement', () => {
    for (const bad of ['a b', 'a;DROP', "a'b", 'a`b', 'A-Upper', '', 'a"b', 'a$b']) {
      expect(() => assertSafeDbName(bad), bad).toThrow(DatabaseError);
    }
  });

  it('refuses a name longer than the smallest engine allows', () => {
    // PostgreSQL truncates identifiers at 63 characters, so a longer name
    // would silently become a different database than the one recorded.
    expect(assertSafeDbName('a'.repeat(63))).toHaveLength(63);
    expect(() => assertSafeDbName('a'.repeat(64))).toThrow(DatabaseError);
  });
});

describe('assertSafeLabel', () => {
  it('accepts what a person would reasonably type', () => {
    expect(assertSafeLabel('shop')).toBe('shop');
  });

  it('refuses a label long enough to push the full name past the limit', () => {
    expect(() => assertSafeLabel('a'.repeat(25))).toThrow(DatabaseError);
  });
});

/**
 * The prefix is what stops two customers who both want a database called
 * `shop` from being handed each other's data. Every engine here has a single
 * flat namespace shared by the whole machine.
 */
describe('database naming', () => {
  const siteId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const userId = '9c858901-8a57-4791-81fe-4c455b099bc9';

  it('names a site database after the site', () => {
    expect(sitePrefix(siteId)).toBe('wp_f47ac10b58cc4372a5670e02');
  });

  it('gives different sites different prefixes', () => {
    expect(sitePrefix(siteId)).not.toBe(sitePrefix('11111111-2222-3333-4444-555555555555'));
  });

  it('names a standalone database after its owner', () => {
    expect(userPrefix(userId)).toMatch(/^u_[a-z0-9]+$/);
  });

  it("keeps the finished name inside every engine's identifier limit", () => {
    const longest = fullDatabaseName('a'.repeat(24), { id: siteId }, null);
    expect(longest.length).toBeLessThanOrEqual(63);
  });

  it('refuses a label that is not a safe identifier', () => {
    expect(() => fullDatabaseName('drop table', { id: siteId }, null)).toThrow(DatabaseError);
  });
});

/**
 * A database password is free text, and it is interpolated into SQL. The
 * escaper is the whole defence against a crafted password ending the string
 * early and running whatever followed — the shape of a real injection.
 */
describe('sqlStringLiteral', () => {
  it('wraps a plain value in quotes', () => {
    expect(sqlStringLiteral('s3cret')).toBe("'s3cret'");
  });

  it('escapes a single quote so the string cannot be ended early', () => {
    expect(sqlStringLiteral("it's")).toBe("'it\\'s'");
  });

  it('escapes a backslash first, so it cannot double-escape the quote', () => {
    // The classic bypass: \' — without escaping the backslash, the quote is
    // "escaped" by it and the string still ends. Backslash must be doubled
    // before the quote is touched.
    expect(sqlStringLiteral("\\'")).toBe("'\\\\\\''");
  });

  it('escapes a trailing backslash, which would otherwise eat the closing quote', () => {
    expect(sqlStringLiteral('ends\\')).toBe("'ends\\\\'");
  });
});

/**
 * PostgreSQL's ordinary quoting depends on a setting a connection can change,
 * so passwords are dollar-quoted instead: the literal runs to the next
 * occurrence of a random tag, and nothing inside it is interpreted at all.
 */
describe('pgDollarQuoted', () => {
  it('wraps a value in a matching pair of tags', () => {
    const quoted = pgDollarQuoted('s3cret');
    const tag = quoted.slice(0, quoted.indexOf('$', 1) + 1);

    expect(quoted.startsWith(tag)).toBe(true);
    expect(quoted.endsWith(tag)).toBe(true);
    expect(quoted.slice(tag.length, -tag.length)).toBe('s3cret');
  });

  it('leaves quotes and backslashes exactly as they were', () => {
    // Nothing is escaped, because nothing needs to be — which is the point.
    expect(pgDollarQuoted("it's\\ a mess")).toContain("it's\\ a mess");
  });

  it('picks a tag that does not appear in the value', () => {
    const value = '$wpdeadbeefdeadbeef$';
    const quoted = pgDollarQuoted(value);
    const tag = quoted.slice(0, quoted.indexOf('$', 1) + 1);

    expect(value).not.toContain(tag);
  });

  it('refuses a null character, which no engine can carry', () => {
    expect(() => pgDollarQuoted('a\0b')).toThrow(DatabaseError);
  });
});

/**
 * A MongoDB filter arrives as text because that is how one is written
 * everywhere else. It is data handed to the driver rather than code, so the
 * only check that matters is that it is the shape the driver expects.
 */
describe('parseFilter', () => {
  it('treats nothing as no filter at all', () => {
    expect(parseFilter(undefined)).toEqual({});
    expect(parseFilter('   ')).toEqual({});
  });

  it('accepts a JSON object', () => {
    expect(parseFilter('{"name":"Ada"}')).toEqual({ name: 'Ada' });
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseFilter('{name: Ada}')).toThrow(DatabaseError);
  });

  it('refuses JSON that is not an object', () => {
    for (const bad of ['[1,2]', '"Ada"', '42', 'null']) {
      expect(() => parseFilter(bad), bad).toThrow(DatabaseError);
    }
  });
});
