/**
 * The mail server's bootstrap file.
 *
 * Stalwart 0.16 does not read a configuration file in the way older versions
 * did. The file passed to `--config` says only *where the data store is*;
 * every other setting — listeners, certificates, accounts — is kept inside
 * that store and changed through the mail server's own administration.
 *
 * This was established by running the binary: it parses this file as JSON,
 * and a TOML file produces the memorable "expected value at line 1 column 1",
 * because a TOML section header is not a JSON value.
 *
 * Ports are therefore not ours to choose here, and the mail server binds the
 * standard ones (25, 465, 993) by itself on first start.
 */

export interface StalwartBootstrapInput {
  /** Directory the mail store is kept in. Created by the mail server. */
  storePath: string;
}

/**
 * Backslashes are legal in JSON only when escaped, and an unescaped Windows
 * path is the easiest way to produce a file the server will not read. Forward
 * slashes avoid the question entirely and Windows accepts them.
 */
function toPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function buildStalwartBootstrap(input: StalwartBootstrapInput): string {
  return `${JSON.stringify(
    {
      // The tag is case-sensitive: "rocksdb" is rejected, "RocksDb" accepted.
      '@type': 'RocksDb',
      path: toPath(input.storePath),
    },
    null,
    2,
  )}\n`;
}
