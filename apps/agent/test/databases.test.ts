import { describe, expect, it } from 'vitest';
import { assertSafeDbName, sqlStringLiteral, DatabaseError } from '../src/sites/databases.js';

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
    for (const bad of ['a b', 'a;DROP', "a'b", 'a`b', 'A-Upper', '']) {
      expect(() => assertSafeDbName(bad), bad).toThrow(DatabaseError);
    }
  });

  it('refuses a name that is too long', () => {
    expect(() => assertSafeDbName('a'.repeat(65))).toThrow(DatabaseError);
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
