/**
 * The one place a catalog file's `{...}` tokens turn into real values.
 *
 * Launch arguments and seeded config values go through the same expansion, so
 * a game config can put its allocated port in an INI file and on the command
 * line without those being two different vocabularies. Adding a game means
 * writing tokens, not adding a branch to the installer.
 */

export interface PlaceholderValues {
  slug: string;
  displayName: string;
  installPath: string;
  dataDir: string;
  version: string;
  /** Allocated ports, keyed by the catalog port's `name` and by its `purpose`. */
  ports: ReadonlyMap<string, number>;
  /** Generated secrets, keyed by the catalog secret's `name`. */
  secrets: ReadonlyMap<string, string>;
  classpath?: string;
  heapMb?: number;
}

/** Tokens with a `name` argument, e.g. `{port:query}`. */
const KEYED = /\{(port|secret):([A-Za-z0-9_-]+)\}/g;

export class PlaceholderError extends Error {}

/**
 * Replaces every known token in `text`.
 *
 * An unresolvable `{port:...}` or `{secret:...}` throws rather than being left
 * in place: a typo in a community config should stop the install with a clear
 * message, not start a server listening on the literal string "{port:qeury}".
 * Tokens that are not ours are left untouched, because some games use braces
 * in their own arguments.
 */
export function expandPlaceholders(text: string, values: PlaceholderValues): string {
  const simple: Record<string, string | undefined> = {
    '{slug}': values.slug,
    '{displayName}': values.displayName,
    '{installPath}': values.installPath,
    '{dataDir}': values.dataDir,
    '{version}': values.version,
    '{classpath}': values.classpath,
    '{heapMb}': values.heapMb === undefined ? undefined : String(values.heapMb),
    // Kept for the common case, and because catalog files already use it.
    '{gamePort}': portValue(values, 'game'),
  };

  let result = text;
  for (const [token, replacement] of Object.entries(simple)) {
    if (!result.includes(token)) continue;
    if (replacement === undefined) {
      throw new PlaceholderError(`This game config uses ${token}, which this server has no value for.`);
    }
    result = result.replaceAll(token, replacement);
  }

  return result.replace(KEYED, (_match, kind: string, name: string) => {
    if (kind === 'port') {
      const port = values.ports.get(name);
      if (port === undefined) {
        throw new PlaceholderError(`This game config asks for the "${name}" port, which it does not declare.`);
      }
      return String(port);
    }
    const secret = values.secrets.get(name);
    if (secret === undefined) {
      throw new PlaceholderError(`This game config asks for the "${name}" secret, which it does not declare.`);
    }
    return secret;
  });
}

function portValue(values: PlaceholderValues, key: string): string | undefined {
  const port = values.ports.get(key);
  return port === undefined ? undefined : String(port);
}

/** Expands a value of any JSON type, leaving numbers and booleans alone. */
export function expandValue(
  value: string | number | boolean,
  values: PlaceholderValues,
): string | number | boolean {
  if (typeof value !== 'string') return value;
  const expanded = expandPlaceholders(value, values);
  // A port written as "{port:game}" should land in JSON as a number, not a
  // string, or games that parse their config strictly reject it.
  if (/^(\{port:[A-Za-z0-9_-]+\}|\{gamePort\}|\{heapMb\})$/.test(value)) {
    const asNumber = Number(expanded);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return expanded;
}
