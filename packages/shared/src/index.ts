/**
 * Shared contracts between the agent and the panel.
 *
 * Everything crossing the wire is defined here once, as a zod schema, so the
 * server validates and the client gets types from the same source.
 */

export * from './status.js';
export * from './paths.js';
export * from './manifest.js';
export * from './site.js';
export * from './job.js';
export * from './ports.js';
export * from './component.js';
export * from './user.js';
export * from './dns.js';
export * from './files.js';
export * from './mail.js';
export * from './game-server.js';
export * from './game-server-config.js';
