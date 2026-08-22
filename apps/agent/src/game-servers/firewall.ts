import type { GameServerPort } from '@winpanel/shared';
import { FirewallManager, type FirewallRule } from '../bootstrap/windows-setup.js';

/** Stable, instance-owned Windows Firewall rules for public game bindings. */
export function gameServerFirewallRules(
  slug: string,
  ports: readonly Pick<GameServerPort, 'name' | 'protocol' | 'purpose' | 'visibility' | 'port'>[],
): FirewallRule[] {
  return ports
    .filter((port) => port.visibility === 'public')
    .map((port) => ({
      name: `WinPanel - Game server - ${slug} - ${port.name}`,
      port: port.port,
      protocol: port.protocol.toUpperCase() as 'TCP' | 'UDP',
      action: 'allow' as const,
      purpose: `Public ${port.purpose} port for ${slug}.`,
    }));
}

export async function applyGameServerFirewall(
  firewall: FirewallManager,
  slug: string,
  ports: readonly Pick<GameServerPort, 'name' | 'protocol' | 'purpose' | 'visibility' | 'port'>[],
): Promise<void> {
  await firewall.applyAll(gameServerFirewallRules(slug, ports));
}

export async function removeGameServerFirewall(
  firewall: FirewallManager,
  slug: string,
  ports: readonly Pick<GameServerPort, 'name' | 'protocol' | 'purpose' | 'visibility' | 'port'>[],
): Promise<void> {
  for (const rule of gameServerFirewallRules(slug, ports)) await firewall.remove(rule.name);
}
