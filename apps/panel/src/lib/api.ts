import { createTRPCClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '@winpanel/agent/src/api/routers/index.js';

/**
 * Typed client for the agent's API.
 *
 * Types come straight from the router definition, so a change to a procedure
 * shows up as a compile error here rather than as a runtime surprise in the
 * browser.
 */
/**
 * Nothing may hang forever.
 *
 * `fetch` has no timeout of its own, so a stalled connection leaves whichever
 * button started the request disabled with a spinner on it and no way back
 * except reloading the page. This is longer than any server-side timeout the
 * agent applies, so it only ever fires when the request itself is stuck.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      // Must match the server, or Dates arrive as strings.
      transformer: superjson,
      // Session cookie is httpOnly, so it has to be sent by the browser.
      fetch: (url, options) => {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

        return fetch(url, {
          ...options,
          credentials: 'same-origin',
          // tRPC passes its own signal for cancellation; both must be honoured.
          signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
      },
    }),
  ],
});

/**
 * Turns an API error into something worth showing a person.
 *
 * The agent already phrases its errors in plain language, so this mostly
 * guards against the cases where the network failed before any message came
 * back.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.message.includes('timed out')) {
      return 'The server took too long to answer. Nothing was lost \u2014 try again.';
    }
    if (error.message.includes('fetch')) {
      return 'Could not reach the server. Check that the panel service is running.';
    }
    return error.message;
  }
  return 'Something went wrong.';
}
