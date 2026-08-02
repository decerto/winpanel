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
export const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      // Must match the server, or Dates arrive as strings.
      transformer: superjson,
      // Session cookie is httpOnly, so it has to be sent by the browser.
      fetch: (url, options) => fetch(url, { ...options, credentials: 'same-origin' }),
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
    if (error.message.includes('fetch')) {
      return 'Could not reach the server. Check that the panel service is running.';
    }
    return error.message;
  }
  return 'Something went wrong.';
}
