import crypto from 'node:crypto';
import { DATABASE_NAME_MAX } from '@winpanel/shared';
import { DatabaseError } from './errors.js';

/**
 * What a database may be called, and how a value is made safe to put into a
 * statement.
 *
 * Every engine here takes its identifiers by interpolation — there is no
 * placeholder for a database or role name in SQL, and MongoDB's admin commands
 * take names as plain strings. So the validator below is the whole defence,
 * and it is deliberately far stricter than any of the three engines require:
 * lowercase letters, digits and underscores, and nothing else, on all of them.
 */

/**
 * A finished database name — prefix and all.
 *
 * The 63-character ceiling is PostgreSQL's identifier limit, which is the
 * smallest of the three; MariaDB allows 64 and MongoDB 63 bytes for a database
 * name on an authenticated deployment. Holding every engine to the smallest
 * means a name that works on one works on all of them, which is what lets the
 * panel present them as one feature.
 */
export function assertSafeDbName(name: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) {
    throw new DatabaseError(
      'A database name can only use lowercase letters, numbers and underscores.',
    );
  }
  return name;
}

/** The part of the name a person chose, before the owner prefix is added. */
export function assertSafeLabel(label: string): string {
  if (!new RegExp(`^[a-z0-9_]{1,${DATABASE_NAME_MAX}}$`).test(label)) {
    throw new DatabaseError(
      'Use lowercase letters, numbers and underscores only, ' +
        `up to ${DATABASE_NAME_MAX} characters.`,
    );
  }
  return label;
}

/**
 * The prefix every database belonging to a website carries.
 *
 * Names are shared across the whole server — one MariaDB, one PostgreSQL, one
 * MongoDB — so two customers both wanting a database called `shop` would
 * otherwise collide, and worse, the second would be handed the first one's
 * data. The prefix makes the owner part of the name.
 *
 * `wp_` is historical: it was WordPress that first needed a database here, and
 * changing it now would orphan every database created before this.
 */
export function sitePrefix(siteId: string): string {
  return `wp_${siteId.replace(/-/g, '').slice(0, 24)}`;
}

/** The prefix for a database that belongs to a person rather than a website. */
export function userPrefix(userId: string): string {
  return `u_${userId.replace(/-/g, '').slice(0, 20)}`;
}

/** A strong password for a new database. */
export function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Renders a value as a MySQL/MariaDB string literal that cannot break out of
 * its quotes.
 *
 * A password is free text chosen by a person, so it can contain anything —
 * and a bare backslash or quote would let it end the string early and run
 * whatever followed. This escapes the full set MySQL treats as special inside
 * a single-quoted literal (backslash first, so it cannot double-escape
 * itself), which is the whole defence against an injection here. Identifiers
 * are handled separately, by `assertSafeDbName`.
 */
export function sqlStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return `'${escaped}'`;
}

/**
 * Renders a value as a PostgreSQL dollar-quoted string.
 *
 * PostgreSQL's ordinary quoting rules depend on the `standard_conforming_
 * strings` setting, which a connection can change — so an escaper that doubles
 * quotes is only correct while nobody has turned that off. Dollar quoting has
 * no escape character at all: the literal runs to the next occurrence of the
 * tag, and nothing inside it is interpreted. A random tag that is checked not
 * to appear in the value makes the encoding unambiguous no matter what the
 * value contains.
 */
export function pgDollarQuoted(value: string): string {
  if (value.includes('\0')) {
    throw new DatabaseError('A password cannot contain a null character.');
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const tag = `$wp${crypto.randomBytes(8).toString('hex')}$`;
    if (!value.includes(tag)) return `${tag}${value}${tag}`;
  }

  // Sixty-four bits of randomness, eight times over. Reaching here means the
  // value was built to contain whatever we generate, which it cannot be.
  throw new DatabaseError('That password cannot be used.');
}
