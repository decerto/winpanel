import net from 'node:net';
import type { DatabaseEngine } from '@winpanel/shared';

export type DatabaseNetworkMode = 'loopback' | 'any' | 'whitelist';

/**
 * Who may reach one database from off the machine.
 *
 * This belongs to a database rather than to an engine, because the person who
 * should decide is whoever owns the database — not whoever owns the server.
 * The listener address and the firewall rule are machine-wide facts, so they
 * are worked out from every database on an engine at once; the login is then
 * restricted to the same sources, which is what stops one customer's choice
 * from putting anybody else's database within reach.
 */
export interface DatabaseNetworkPolicy {
  mode: DatabaseNetworkMode;
  remoteCidrs: string[];
}

export const DEFAULT_DATABASE_NETWORK_POLICY: DatabaseNetworkPolicy = {
  mode: 'loopback',
  remoteCidrs: [],
};

export function databaseFirewallRuleName(engine: DatabaseEngine): string {
  return `WinPanel - Database (${engine === 'mariadb' ? 'MariaDB' : engine === 'postgres' ? 'PostgreSQL' : 'MongoDB'})`;
}

export const DATABASE_FIREWALL_ENGINES = ['mariadb', 'postgres', 'mongodb'] as const;

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 ? octet : -1;
  });

  return octets.some((octet) => octet < 0) ? null : octets;
}

function expandIpv6(value: string): number[] | null {
  const lower = value.toLowerCase();
  if (lower.includes('%')) return null;

  const halves = lower.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(':');
    const groups: number[] = [];

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }

    return groups;
  };

  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function formatIpv6(groups: readonly number[]): string {
  const values = groups.map((group) => group.toString(16));
  let bestStart = -1;
  let bestLength = 1;

  for (let start = 0; start < values.length; start++) {
    if (groups[start] !== 0) continue;
    let end = start;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end - 1;
  }

  if (bestStart < 0) return values.join(':');
  const before = values.slice(0, bestStart).join(':');
  const after = values.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

interface ParsedAddress {
  family: 4 | 6;
  value: number[];
}

function parseAddress(value: string): ParsedAddress | null {
  const family = net.isIP(value);
  if (family === 4) {
    const octets = parseIpv4(value);
    return octets ? { family: 4, value: octets } : null;
  }
  if (family === 6) {
    const groups = expandIpv6(value);
    return groups ? { family: 6, value: groups } : null;
  }
  return null;
}

function addressToBigInt(address: ParsedAddress): bigint {
  const shift = address.family === 4 ? 8n : 16n;
  return address.value.reduce((result, part) => (result << shift) | BigInt(part), 0n);
}

function bigIntToAddress(value: bigint, family: 4 | 6): ParsedAddress {
  const count = family === 4 ? 4 : 16;
  const bytes = Array.from({ length: count }, (_, index) =>
    Number((value >> BigInt((count - index - 1) * 8)) & 255n),
  );
  return family === 4
    ? { family, value: bytes }
    : {
        family,
        value: Array.from({ length: 8 }, (_, index) =>
          (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!,
        ),
      };
}

function formatAddress(address: ParsedAddress): string {
  return address.family === 4
    ? address.value.join('.')
    : formatIpv6(address.value);
}

/**
 * Turns `::ffff:203.0.113.42` into `203.0.113.42`.
 *
 * A browser reaching a panel bound to `::` arrives as an IPv4-mapped IPv6
 * address, and Windows Firewall does not match one of those against the IPv4
 * source it really is — so the whitelist would silently never admit the very
 * machine that asked to be on it.
 */
export function unmapIpv4(input: string): string {
  const value = input.trim();
  if (value.includes('/')) return value;

  const lower = value.toLowerCase();
  if (!lower.startsWith('::ffff:')) return value;

  const mapped = lower.slice('::ffff:'.length);
  return net.isIP(mapped) === 4 ? mapped : value;
}

/** Converts one address or CIDR into a canonical Windows Firewall value. */
export function normaliseRemoteCidr(input: string): string {
  const value = unmapIpv4(input);
  if (!value) throw new Error('Enter an IP address or network range.');

  const slash = value.indexOf('/');
  if (slash !== value.lastIndexOf('/')) throw new Error(`That is not a valid IP address: ${input}`);

  const addressText = slash < 0 ? value : value.slice(0, slash);
  const address = parseAddress(addressText);
  if (!address) throw new Error(`That is not a valid IP address: ${input}`);

  if (slash < 0) return formatAddress(address);

  const prefixText = value.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) throw new Error(`That is not a valid network range: ${input}`);
  const prefix = Number(prefixText);
  const bits = address.family === 4 ? 32 : 128;
  if (prefix > bits) throw new Error(`That network range is too wide: ${input}`);

  const numeric = addressToBigInt(address);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
  const network = bigIntToAddress(numeric & mask, address.family);
  return `${formatAddress(network)}/${prefix}`;
}

export function normaliseRemoteCidrs(values: readonly string[]): string[] {
  const normalised = [...new Set(values.map(normaliseRemoteCidr))];
  if (normalised.length > 100) throw new Error('A maximum of 100 network ranges can be whitelisted.');
  return normalised;
}

export function normaliseDatabaseNetworkPolicy(
  mode: DatabaseNetworkMode,
  remoteCidrs: readonly string[] = [],
): DatabaseNetworkPolicy {
  const cidrs = mode === 'whitelist' ? normaliseRemoteCidrs(remoteCidrs) : [];
  if (mode === 'whitelist' && cidrs.length === 0) {
    throw new Error('Add at least one IP address or network range to the whitelist.');
  }
  return { mode, remoteCidrs: cidrs };
}

/**
 * What one engine's listener and firewall rule have to be, given every
 * database on it.
 *
 * The widest choice wins, because a single process cannot listen two ways at
 * once: one database asking for any address opens the port, and the rest are
 * held back by their own login instead.
 */
export function combineDatabaseNetworkPolicies(
  policies: readonly DatabaseNetworkPolicy[],
): DatabaseNetworkPolicy {
  if (policies.some((policy) => policy.mode === 'any')) return { mode: 'any', remoteCidrs: [] };

  const cidrs = [
    ...new Set(policies.flatMap((policy) => (policy.mode === 'whitelist' ? policy.remoteCidrs : []))),
  ];

  return cidrs.length > 0 ? { mode: 'whitelist', remoteCidrs: cidrs } : { ...DEFAULT_DATABASE_NETWORK_POLICY };
}

export function isRemoteDatabaseNetworkPolicy(policy: DatabaseNetworkPolicy): boolean {
  return policy.mode !== 'loopback';
}

/** The listener address used by the three Windows database services. */
export function databaseBindAddress(policy: DatabaseNetworkPolicy): string {
  return isRemoteDatabaseNetworkPolicy(policy) ? '0.0.0.0' : '127.0.0.1';
}

export function databaseServerArgs(
  engine: DatabaseEngine,
  dataDir: string,
  policy: DatabaseNetworkPolicy,
): string[] {
  const bind = databaseBindAddress(policy);

  switch (engine) {
    case 'mariadb':
      return [`--datadir=${dataDir}`, `--bind-address=${bind}`, '--port=3306'];
    case 'postgres':
      return ['-D', dataDir, '-h', bind, '-p', '5432'];
    case 'mongodb':
      return ['--dbpath', dataDir, '--bind_ip', bind, '--port', '27017', '--auth'];
  }
}

export function databaseFirewallRemoteIp(policy: DatabaseNetworkPolicy): string | undefined {
  if (policy.mode === 'any') return 'any';
  if (policy.mode === 'whitelist') return policy.remoteCidrs.join(',');
  return undefined;
}