import { z } from 'zod';
import { GameServerCatalogEntry } from './game-server.js';

/**
 * A game-server definition WinPanel can install and supervise.
 *
 * These files are the contribution surface: a JSON document per game, stored
 * in the repo under `game-servers/catalogue/` and seeded into the installed
 * panel's data folder. Adding a game means adding a config file, not editing
 * TypeScript — the panel validates each one against this schema at startup.
 *
 * The shape is the same object the panel already passes around internally,
 * with the provider-specific knowledge spelled out as data. That is what lets
 * the loader merge built-ins and user files without any code knowing which is
 * which.
 */
export const GameServerConfigFile = GameServerCatalogEntry;
export type GameServerConfigFile = z.infer<typeof GameServerConfigFile>;
