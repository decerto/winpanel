import type { DatabaseHandle } from '../db/index.js';
import { CLOUDFLARE_TOKEN_ENV_VAR, cloudflareTokenGroups } from '../dns/token.js';
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

export { CLOUDFLARE_TOKEN_ENV_VAR };

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

  return Object.fromEntries(groups.map((group) => [group.envVar, group.token]));
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
