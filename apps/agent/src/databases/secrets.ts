import type { DatabaseEngine } from '@winpanel/shared';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretVault } from '../security/vault.js';
import { deleteSecret, readSecret, writeSecret } from '../security/secret-store.js';
import { ENGINE_ROOT_SECRET } from './types.js';

/**
 * Where database passwords live.
 *
 * They cannot be hashed: the panel has to be able to present them to whoever
 * owns the database, and to hand them to the browser's sign-in. So they are
 * encrypted at rest in the vault, which is what the machine's DPAPI key
 * protects, and read back only for the account that owns them.
 */

/** The key one database's own password is stored under. */
function passwordKey(engine: DatabaseEngine, name: string): string {
  return `db.pass:${engine}:${name}`;
}

/**
 * The key site databases used before there was more than one engine.
 *
 * Kept only so an existing MariaDB database's password is still findable after
 * an upgrade. It is read once and rewritten under the current key, so this
 * fades out on its own as sites are touched.
 */
function legacyPasswordKey(siteId: string, name: string): string {
  return `site.dbPass:${siteId}:${name}`;
}

/** The administrative password for an engine, or null if it was never set up. */
export function readRootPassword(
  db: DatabaseHandle,
  vault: SecretVault,
  engine: DatabaseEngine,
): string | null {
  return readSecret(db, vault, ENGINE_ROOT_SECRET[engine]);
}

export function writeRootPassword(
  db: DatabaseHandle,
  vault: SecretVault,
  engine: DatabaseEngine,
  password: string,
): void {
  writeSecret(db, vault, ENGINE_ROOT_SECRET[engine], password);
}

export function writeDatabasePassword(
  db: DatabaseHandle,
  vault: SecretVault,
  engine: DatabaseEngine,
  name: string,
  password: string,
): void {
  writeSecret(db, vault, passwordKey(engine, name), password);
}

/**
 * A database's own password.
 *
 * `legacySiteId` lets a MariaDB database created before engines existed still
 * be found; when it is, the password is moved to the current key so the next
 * read does not have to look twice.
 */
export function readDatabasePassword(
  db: DatabaseHandle,
  vault: SecretVault,
  engine: DatabaseEngine,
  name: string,
  legacySiteId?: string | null,
): string | null {
  const current = readSecret(db, vault, passwordKey(engine, name));
  if (current) return current;

  if (engine !== 'mariadb' || !legacySiteId) return null;

  const legacy = readSecret(db, vault, legacyPasswordKey(legacySiteId, name));
  if (!legacy) return null;

  writeSecret(db, vault, passwordKey(engine, name), legacy);
  deleteSecret(db, legacyPasswordKey(legacySiteId, name));
  return legacy;
}

export function deleteDatabasePassword(
  db: DatabaseHandle,
  engine: DatabaseEngine,
  name: string,
  legacySiteId?: string | null,
): void {
  deleteSecret(db, passwordKey(engine, name));
  if (legacySiteId) deleteSecret(db, legacyPasswordKey(legacySiteId, name));
}
