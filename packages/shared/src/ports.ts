import { z } from 'zod';

/**
 * The panel's own port. Fixed so it is easy to remember, and permanently
 * reserved so a hosted app can never be allocated it — being locked out of the
 * panel by your own site config would be a miserable failure mode.
 */
export const PANEL_PORT = 8443;

/** Caddy's admin API. Bound to loopback only. */
export const CADDY_ADMIN_PORT = 2019;

/** Stalwart's HTTP surface (admin UI, JMAP, autoconfig). Bound to loopback only. */
export const STALWART_HTTP_PORT = 8080;

/**
 * The edge. Caddy owns these and everything else is proxied through it, so any
 * other program that binds one of them takes the whole server's web traffic
 * down with it.
 */
export const WEB_PORTS = [80, 443] as const;

export const MAIL_PORTS = [25, 465, 587, 993, 995, 4190] as const;

/**
 * Ports the allocator must never hand out.
 *
 * Note the deliberate absence of anything above 49151: Windows' default
 * dynamic port range starts at 49152, and we allocate from 3001 upward, so
 * they cannot collide. The allocator additionally consults
 * `netsh interface ipv4 show excludedportrange`, because Hyper-V and WSL
 * reserve ranges that produce the confusing "port is in use but nothing is
 * listening" symptom.
 */
export const RESERVED_PORTS: ReadonlySet<number> = new Set<number>([
  20, 21, // FTP
  22, // SSH
  53, // DNS
  ...WEB_PORTS, // Caddy edge
  PANEL_PORT,
  CADDY_ADMIN_PORT,
  STALWART_HTTP_PORT,
  ...MAIL_PORTS,
  3389, // RDP — locking this out would end the session
  5985, 5986, // WinRM
]);

/** Site application ports are allocated from here upward. */
export const APP_PORT_RANGE_START = 3001;
export const APP_PORT_RANGE_END = 3999;

/** .NET/Kestrel apps get their own band, purely for legibility in netstat. */
export const DOTNET_PORT_RANGE_START = 5000;
export const DOTNET_PORT_RANGE_END = 5999;

/**
 * Every site also gets a "preview" port on the public interface.
 *
 * Without one, a site is only reachable once a domain exists and DNS has
 * propagated — which makes it impossible to check that what you just uploaded
 * actually works. This band is served by Caddy with no host matching, so
 * `http://<server-ip>:<preview-port>` always reaches the site.
 *
 * Distinct from the app port band on purpose: app ports bind to loopback only
 * and must never be exposed, whereas these are deliberately public.
 */
export const PREVIEW_PORT_RANGE_START = 7000;
export const PREVIEW_PORT_RANGE_END = 7999;

export const Port = z.number().int().min(1).max(65535);

export interface PortRejection {
  readonly ok: false;
  readonly reason: string;
}
export interface PortAcceptance {
  readonly ok: true;
}
export type PortValidation = PortAcceptance | PortRejection;

/**
 * Validates a port a user typed in manually. The same rules the automatic
 * allocator follows, so a hand-entered port cannot bypass them.
 */
export function validateAssignablePort(
  port: number,
  takenPorts: ReadonlySet<number> = new Set(),
): PortValidation {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: 'Enter a port number between 1 and 65535.' };
  }
  if (port === PANEL_PORT) {
    return {
      ok: false,
      reason: `Port ${PANEL_PORT} is used by this control panel. Using it would lock you out.`,
    };
  }
  if (RESERVED_PORTS.has(port)) {
    return { ok: false, reason: `Port ${port} is reserved by the server and cannot be used.` };
  }
  if (port < 1024) {
    return { ok: false, reason: 'Ports below 1024 are reserved for system services.' };
  }
  if (port >= 49152) {
    return {
      ok: false,
      reason: 'Ports from 49152 up are used by Windows for outgoing connections.',
    };
  }
  if (takenPorts.has(port)) {
    return { ok: false, reason: `Port ${port} is already used by another app on this server.` };
  }
  return { ok: true };
}

/** True when a port is safe to hand out, ignoring live-bind checks. */
export function isAssignablePort(port: number, takenPorts?: ReadonlySet<number>): boolean {
  return validateAssignablePort(port, takenPorts).ok;
}

export const PortAllocation = z.object({
  port: Port,
  siteId: z.string().uuid(),
  colour: z.enum(['blue', 'green', 'preview']),
  allocatedAt: z.coerce.date(),
});
export type PortAllocation = z.infer<typeof PortAllocation>;
