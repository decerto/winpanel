import type { DatabaseHandle } from '../db/index.js';
import { loadCloudflareToken } from '../dns/token.js';
import type { SecretVault } from '../security/vault.js';
import type { ServiceManager } from '../windows/service-manager.js';

/**
 * The environment Caddy runs with, in one place.
 *
 * It matters that this is one place. The generated config refers to the token
 * as `{env.CF_API_TOKEN}` rather than embedding it, so the config and the
 * service environment have to be kept in step — and when they are not, nothing
 * fails loudly. Caddy starts, serves HTTP happily, and simply never manages to
 * issue a certificate, which surfaces days later as an expired site.
 */

export const CADDY_SERVICE_ID = 'winpanel-caddy';

/** The variable Caddy's Cloudflare DNS module reads its token from. */
export const CLOUDFLARE_TOKEN_ENV_VAR = 'CF_API_TOKEN';

export function caddyServiceEnv(
  caddyDir: string,
  cloudflareToken?: string | null,
): Record<string, string> {
  return {
    // Caddy picks its data directory out of the environment. Left unset, a
    // service running as LocalSystem puts its certificates somewhere nobody
    // thinks to back up.
    XDG_DATA_HOME: caddyDir,
    XDG_CONFIG_HOME: caddyDir,
    ...(cloudflareToken ? { [CLOUDFLARE_TOKEN_ENV_VAR]: cloudflareToken } : {}),
  };
}

export type CaddyEnvResult = 'unchanged' | 'updated' | 'not-installed';

export interface CaddyEnvDependencies {
  db: DatabaseHandle;
  vault: SecretVault;
  services: ServiceManager;
  caddyDir: string;
}

/**
 * Makes Caddy's environment match the token the panel currently holds.
 *
 * Safe to call whenever: it rewrites nothing and restarts nothing unless the
 * environment has actually changed.
 */
export async function syncCaddyEnvironment(deps: CaddyEnvDependencies): Promise<CaddyEnvResult> {
  const token = loadCloudflareToken(deps.db, deps.vault);

  return await deps.services.setEnvironment(
    CADDY_SERVICE_ID,
    caddyServiceEnv(deps.caddyDir, token),
  );
}
