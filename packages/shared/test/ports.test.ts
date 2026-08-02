import { describe, expect, it } from 'vitest';
import {
  APP_PORT_RANGE_END,
  APP_PORT_RANGE_START,
  CADDY_ADMIN_PORT,
  MAIL_PORTS,
  PANEL_PORT,
  RESERVED_PORTS,
  STALWART_HTTP_PORT,
  isAssignablePort,
  validateAssignablePort,
} from '../src/ports.js';

describe('port allocation rules', () => {
  it('never allows the panel port to be assigned to a site', () => {
    // The user picked a fixed panel port precisely so it is memorable. The
    // flip side is that a site must never be able to take it, or the panel
    // becomes unreachable and unfixable through the panel itself.
    const result = validateAssignablePort(PANEL_PORT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('lock you out');
  });

  it('rejects every reserved port', () => {
    for (const port of RESERVED_PORTS) {
      expect(isAssignablePort(port), `port ${port}`).toBe(false);
    }
  });

  it('rejects the infrastructure ports by name', () => {
    expect(isAssignablePort(CADDY_ADMIN_PORT)).toBe(false);
    expect(isAssignablePort(STALWART_HTTP_PORT)).toBe(false);
    for (const port of MAIL_PORTS) {
      expect(isAssignablePort(port), `mail port ${port}`).toBe(false);
    }
  });

  it('rejects RDP so a misconfiguration cannot end the session', () => {
    expect(isAssignablePort(3389)).toBe(false);
  });

  it('accepts ordinary ports in the app range', () => {
    for (const port of [APP_PORT_RANGE_START, 3500, APP_PORT_RANGE_END]) {
      expect(isAssignablePort(port), `port ${port}`).toBe(true);
    }
  });

  it('rejects the Windows dynamic range used for outgoing connections', () => {
    expect(isAssignablePort(49152)).toBe(false);
    expect(isAssignablePort(60000)).toBe(false);
    expect(isAssignablePort(49151)).toBe(true);
  });

  it('rejects privileged ports below 1024', () => {
    expect(isAssignablePort(1023)).toBe(false);
    expect(isAssignablePort(1024)).toBe(true);
  });

  it('rejects ports already taken by another app', () => {
    const taken = new Set([3001, 3002]);
    expect(isAssignablePort(3001, taken)).toBe(false);
    expect(isAssignablePort(3003, taken)).toBe(true);
  });

  it('rejects nonsense input', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(isAssignablePort(port), `port ${port}`).toBe(false);
    }
  });
});
