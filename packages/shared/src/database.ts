import { z } from 'zod';
import { MARIADB_PORT, MONGODB_PORT, POSTGRES_PORT } from './ports.js';

/**
 * The database servers the panel can run for you.
 *
 * Three engines, because the three things people self-host want different
 * ones: WordPress and most PHP apps want MySQL-compatible (MariaDB), a lot of
 * modern application code wants PostgreSQL, and a lot of Node projects want
 * MongoDB. Rather than making anyone choose a host per database, the panel
 * installs whichever are wanted and treats a database as a database.
 *
 * Everything here is shared with the panel so a dropdown can never offer an
 * engine the server does not have, and so both sides agree on what a database
 * name is allowed to look like.
 */

export const DatabaseEngine = z.enum(['mariadb', 'postgres', 'mongodb']);
export type DatabaseEngine = z.infer<typeof DatabaseEngine>;

/** How a database on an engine is looked inside. */
export const DatabaseBrowserKind = z.enum([
  /** Adminer, proxied by the panel. Covers the two SQL engines. */
  'adminer',
  /** The panel's own document browser. MongoDB has no Adminer driver. */
  'built-in',
]);
export type DatabaseBrowserKind = z.infer<typeof DatabaseBrowserKind>;

export interface DatabaseEngineInfo {
  id: DatabaseEngine;
  /** What the panel calls it on screen. */
  label: string;
  /** The product name, for the one place it has to be said out loud. */
  product: string;
  /** One sentence on what it is for, in plain English. */
  description: string;
  /** The component that must be installed before this engine is offered. */
  componentId: 'mariadb' | 'postgres' | 'mongodb';
  /** The loopback port its server listens on. */
  port: number;
  /** Whether it speaks SQL, which decides what the connection details say. */
  sql: boolean;
  browser: DatabaseBrowserKind;
}

export const DATABASE_ENGINES: readonly DatabaseEngineInfo[] = [
  {
    id: 'mariadb',
    label: 'MariaDB',
    product: 'MariaDB',
    description:
      'MySQL-compatible. What WordPress and most PHP applications expect.',
    componentId: 'mariadb',
    port: MARIADB_PORT,
    sql: true,
    browser: 'adminer',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    product: 'PostgreSQL',
    description:
      'The relational database most modern application frameworks default to.',
    componentId: 'postgres',
    port: POSTGRES_PORT,
    sql: true,
    browser: 'adminer',
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    product: 'MongoDB',
    description:
      'Stores documents rather than rows. Common in Node.js and JavaScript projects.',
    componentId: 'mongodb',
    port: MONGODB_PORT,
    sql: false,
    browser: 'built-in',
  },
];

export function databaseEngineInfo(engine: DatabaseEngine): DatabaseEngineInfo {
  const found = DATABASE_ENGINES.find((candidate) => candidate.id === engine);
  // The enum and the table are declared together above, so this cannot happen
  // without one of them being edited and the other forgotten.
  if (!found) throw new Error(`There is no database engine called "${engine}".`);
  return found;
}

/** The engine an installed component provides, if it provides one. */
export function engineForComponent(componentId: string): DatabaseEngine | null {
  return DATABASE_ENGINES.find((engine) => engine.componentId === componentId)?.id ?? null;
}

/**
 * The part of a database name a person chooses.
 *
 * The panel puts an owner prefix in front of it, so this is only the trailing
 * label. Held to lowercase letters, digits and underscores because the full
 * name is interpolated into SQL as an identifier, and because it has to be a
 * legal name on all three engines at once — PostgreSQL folds unquoted names to
 * lowercase, and MongoDB refuses several punctuation characters outright.
 *
 * Twenty-four characters, so that even the longest prefix leaves the finished
 * name inside PostgreSQL's 63-character identifier limit.
 */
export const DATABASE_NAME_MAX = 24;

export const DatabaseName = z
  .string()
  .min(1)
  .max(DATABASE_NAME_MAX)
  .regex(
    /^[a-z0-9_]+$/,
    'Use lowercase letters, numbers and underscores only.',
  );

/**
 * A database's connection details, as the panel hands them to whoever owns it.
 *
 * The password is deliberately not part of this: it is revealed on its own,
 * once, by a separate call that is audited.
 */
export const DatabaseConnection = z.object({
  engine: DatabaseEngine,
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  username: z.string(),
  /** A ready-made URI with the password left as a placeholder. */
  uriTemplate: z.string(),
});
export type DatabaseConnection = z.infer<typeof DatabaseConnection>;

/**
 * The connection URI for a database.
 *
 * Built here rather than in the panel so the page, the documentation and
 * anything else that has to state it all say exactly the same thing. The
 * username and password are percent-encoded: a generated password is
 * base64url and safe, but a person may choose one containing `@`, `/` or `:`,
 * and an unencoded one of those silently produces a URI that parses as a
 * different host.
 */
export function databaseUri(
  engine: DatabaseEngine,
  username: string,
  database: string,
  password: string,
  host = '127.0.0.1',
): string {
  const info = databaseEngineInfo(engine);
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const authority =
    `${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    `@${formattedHost}:${info.port}`;

  switch (engine) {
    case 'mariadb':
      return `mysql://${authority}/${database}`;
    case 'postgres':
      return `postgresql://${authority}/${database}`;
    case 'mongodb':
      // The user lives inside its own database rather than in `admin`, so the
      // driver has to be told where to authenticate or it looks in the wrong
      // place and reports the password as wrong.
      return `mongodb://${authority}/${database}?authSource=${database}`;
  }
}

/** The same URI with a placeholder where the password goes. */
export function databaseUriTemplate(
  engine: DatabaseEngine,
  username: string,
  database: string,
  placeholder = 'PASSWORD',
  host = '127.0.0.1',
): string {
  return databaseUri(engine, username, database, placeholder, host);
}
