import { CADDY_ADMIN_PORT } from '@winpanel/shared';

/**
 * Client for Caddy's admin API.
 *
 * Uses `@id`-addressed endpoints wherever possible, because rewriting the
 * whole configuration to change one upstream is both slower and far more
 * likely to clobber a concurrent change.
 *
 * Concurrency is handled with ETag / If-Match. Two overlapping edits — say a
 * deploy switching an upstream while the user adds a domain — would otherwise
 * silently lose one of the changes.
 */

export class CaddyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'CaddyError';
  }
}

export class CaddyConflictError extends CaddyError {
  constructor() {
    super('The configuration changed while this update was being prepared.', 412);
    this.name = 'CaddyConflictError';
  }
}

/** Caddy answers `{"error": "..."}`, but not always, and not always as JSON. */
function reasonFrom(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';

  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error !== '') return ` ${parsed.error}`;
  } catch {
    // Not JSON: whatever it said is still better than nothing.
  }

  return ` ${trimmed}`;
}

export interface CaddyClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class CaddyClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly origin: string;

  constructor(options: CaddyClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${CADDY_ADMIN_PORT}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.origin = new URL(this.baseUrl).origin;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; text: string; etag: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          /*
           * Node's fetch attaches an empty `Origin` on anything that is not a
           * GET, and Caddy's admin API runs its cross-site check whenever the
           * header is present at all — so it rejects every write with "client
           * is not allowed to access from origin ''". Naming the endpoint we
           * are already talking to satisfies the check.
           */
          origin: this.origin,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();

      if (response.status === 412) throw new CaddyConflictError();

      if (!response.ok) {
        const detail = text.slice(0, 500);
        throw new CaddyError(
          // Caddy says exactly which part of the configuration it disliked,
          // and without it the message is a dead end for everyone.
          `The web server rejected the change.${reasonFrom(detail)}`,
          response.status,
          detail,
        );
      }

      return { status: response.status, text, etag: response.headers.get('etag') };
    } catch (error) {
      if (error instanceof CaddyError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new CaddyError('The web server did not respond in time.');
      }
      throw new CaddyError(
        'Could not reach the web server. It may not be running.',
        undefined,
        (error as Error).message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when Caddy is up and answering. */
  async isRunning(): Promise<boolean> {
    try {
      await this.request('GET', '/config/');
      return true;
    } catch {
      return false;
    }
  }

  async getConfig(path = '/'): Promise<unknown> {
    const { text } = await this.request('GET', `/config${path}`);
    return text ? JSON.parse(text) : null;
  }

  /** The running admin block, or null when Caddy is using its own default. */
  async getAdminConfig(): Promise<unknown> {
    return await this.getConfig('/admin');
  }

  /** Replaces the entire configuration. */
  async load(config: unknown): Promise<void> {
    await this.request('POST', '/load', config);
  }

  /** Validates a configuration without applying it. */
  async validate(config: unknown): Promise<boolean> {
    try {
      await this.request('POST', '/adapt', config, { 'content-type': 'application/json' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Points a site's proxy at a different port.
   *
   * This is the whole of a zero-downtime release: the new version is already
   * running and health-checked on the standby port, and this switches traffic
   * to it in one atomic step.
   */
  async switchUpstream(proxyId: string, port: number): Promise<void> {
    await this.request('PATCH', `/id/${proxyId}/upstreams`, [{ dial: `127.0.0.1:${port}` }]);
  }

  async getUpstreams(proxyId: string): Promise<Array<{ dial: string }>> {
    const { text } = await this.request('GET', `/id/${proxyId}/upstreams`);
    return JSON.parse(text) as Array<{ dial: string }>;
  }

  /**
   * Read-modify-write with optimistic concurrency.
   *
   * Retries on a conflict rather than failing, because the common cause is a
   * simultaneous edit to an unrelated part of the config.
   */
  async update(
    path: string,
    mutate: (current: unknown) => unknown,
    attempts = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const { text, etag } = await this.request('GET', `/config${path}`);
      const current = text ? JSON.parse(text) : null;
      const next = mutate(current);

      try {
        await this.request(
          'PATCH',
          `/config${path}`,
          next,
          etag ? { 'if-match': etag } : {},
        );
        return;
      } catch (error) {
        if (error instanceof CaddyConflictError && attempt < attempts) continue;
        throw error;
      }
    }
  }

  /** Live status of every backend, used by the Health page. */
  async upstreamHealth(): Promise<
    Array<{ address: string; num_requests: number; fails: number }>
  > {
    const { text } = await this.request('GET', '/reverse_proxy/upstreams');
    return JSON.parse(text) as Array<{
      address: string;
      num_requests: number;
      fails: number;
    }>;
  }
}
