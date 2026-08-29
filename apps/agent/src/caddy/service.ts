import type { DatabaseHandle } from '../db/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cloudflareTokenGroups,
  LEGACY_CLOUDFLARE_TOKEN_ENV_VAR,
  loadLegacyCloudflareToken,
} from '../dns/token.js';
import { sites } from '../db/schema.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager } from '../windows/service-manager.js';

/**
 * The environment Caddy runs with, in one place.
 *
 * It matters that this is one place. The generated config refers to each token
 * as `{env.CF_API_TOKEN…}` rather than embedding it, so the config and the
 * service environment have to be kept in step — and when they are not, nothing
 * fails loudly. Caddy starts, serves HTTP happily, and simply never manages to
 * issue a certificate, which surfaces days later as an expired site.
 *
 * The indirection is not only tidiness. Caddy writes its running config beside
 * its own data, where any local account can read it; the service configuration
 * lives in the panel's data folder, which is stripped of inheritance and
 * granted to SYSTEM and administrators alone. A token in the config would be
 * readable by anything on the machine — including the restricted account that
 * runs website build scripts.
 */

export const CADDY_SERVICE_ID = 'winpanel-caddy';


export function caddyServiceEnv(
  caddyDir: string,
  cloudflareTokens: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    // Caddy picks its data directory out of the environment. Left unset, a
    // service running as LocalSystem puts its certificates somewhere nobody
    // thinks to back up.
    XDG_DATA_HOME: caddyDir,
    XDG_CONFIG_HOME: caddyDir,
    ...cloudflareTokens,
  };
}

export type CaddyEnvResult = 'unchanged' | 'updated' | 'not-installed';

export interface CaddyEnvDependencies {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
  caddyDir: string;
}

/** Every Cloudflare token some website needs, by the variable it is read from. */
export function cloudflareTokenEnvironment(
  db: DatabaseHandle,
  vault: SecretVault,
): Record<string, string> {
  const rows = db.db.select({ id: sites.id, domains: sites.domains }).from(sites).all();

  const groups = cloudflareTokenGroups(
    db,
    vault,
    rows.map((row) => ({ id: row.id, domains: row.domains as string[] })),
  );

  const environment = Object.fromEntries(groups.map((group) => [group.envVar, group.token]));
  const legacy = loadLegacyCloudflareToken(db, vault);

  // Older autosaved Caddy configs still refer to this name. Keep it alive
  // until the current config has been loaded and the migration is finalised.
  if (legacy) environment[LEGACY_CLOUDFLARE_TOKEN_ENV_VAR] = legacy;

  return environment;
}

/**
 * Makes Caddy's environment match the tokens the panel currently holds.
 *
 * Safe to call whenever: it rewrites nothing and restarts nothing unless the
 * environment has actually changed.
 */
export async function syncCaddyEnvironment(deps: CaddyEnvDependencies): Promise<CaddyEnvResult> {
  return await deps.services.setEnvironment(
    CADDY_SERVICE_ID,
    caddyServiceEnv(deps.caddyDir, cloudflareTokenEnvironment(deps.db, deps.vault)),
  );
}

/** Caddy saves the running config here, and boots from it because of `--resume`. */
export function caddyAutosavePath(caddyDir: string): string {
  return path.join(caddyDir, 'caddy', 'autosave.json');
}

/** Caddy's own words for "I could not load the config I was given". */
const UNLOADABLE_CONFIG = /loading initial config|loading new config/i;

/**
 * Moves aside a saved configuration Caddy refuses to boot from.
 *
 * Caddy is run with `--resume`, so it starts from the config it last saved,
 * and that config names each Cloudflare token by a variable derived from the
 * token itself. Change the token, migrate it to a website, or remove it, and
 * the name it was saved under stops resolving: `{env...}` becomes empty, the
 * ACME issuer rejects the empty token, and Caddy exits before it listens.
 *
 * Nothing can repair that from the outside. The panel configures Caddy through
 * its admin API, which does not exist until Caddy starts, so a saved config it
 * cannot load leaves the web server down for good — and every website with it,
 * while the mail server quietly takes the ports Caddy never bound. The file is
 * kept rather than deleted so it can still be looked at afterwards.
 */
export async function quarantineUnloadableCaddyConfig(
  caddyDir: string,
  failure: string,
): Promise<string | null> {
  if (!UNLOADABLE_CONFIG.test(failure)) return null;

  const autosave = caddyAutosavePath(caddyDir);
  const quarantined = `${autosave}.unloadable-${Date.now()}`;

  try {
    await fs.rename(autosave, quarantined);
    return quarantined;
  } catch {
    // Nothing saved yet, so the config it could not load came from elsewhere.
    return null;
  }
}
