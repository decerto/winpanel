import { describe, expect, it } from 'vitest';
import { rollUpState, statusPresentation } from '@winpanel/shared';
import { CheckEngine, type CheckDefinition, type CheckOutcome } from '../src/checks/engine.js';
import {
  buildServerChecks,
  isPortExcluded,
  isPortFree,
  missingFirewallRuleNames,
} from '../src/checks/server-checks.js';
import { requiredFirewallRules } from '../src/bootstrap/windows-setup.js';

function makeCheck(id: string, outcome: CheckOutcome): CheckDefinition {
  return {
    id,
    category: 'server',
    name: `Check ${id}`,
    plainDescription: 'A description that a normal person can read.',
    ttlSeconds: 60,
    run: async () => outcome,
  };
}

describe('CheckEngine', () => {
  it('runs a check and returns a full result', async () => {
    const engine = new CheckEngine();
    engine.register(makeCheck('a', { state: 'ok', detail: 'All good' }));

    const result = await engine.runOne('a');
    expect(result.state).toBe('ok');
    expect(result.detail).toBe('All good');
    expect(result.name).toBe('Check a');
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it('reports unknown rather than crashing when a check throws', async () => {
    // One broken check must never take down the whole Health page.
    const engine = new CheckEngine();
    engine.register({
      id: 'explodes',
      category: 'server',
      name: 'Explodes',
      plainDescription: 'This one throws.',
      ttlSeconds: 60,
      run: async () => {
        throw new Error('registry unavailable');
      },
    });

    const result = await engine.runOne('explodes');
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('registry unavailable');
  });

  it('runs every registered check', async () => {
    const engine = new CheckEngine();
    engine.registerAll([
      makeCheck('a', { state: 'ok' }),
      makeCheck('b', { state: 'warning' }),
      makeCheck('c', { state: 'blocked' }),
    ]);

    const results = await engine.runAll();
    expect(results).toHaveLength(3);
  });

  it('rolls up to the worst state so one failure is never hidden', async () => {
    const engine = new CheckEngine();
    engine.registerAll([
      makeCheck('a', { state: 'ok' }),
      makeCheck('b', { state: 'ok' }),
      makeCheck('c', { state: 'blocked' }),
    ]);

    const results = await engine.runAll();
    expect(engine.overall(results)).toBe('blocked');
  });

  it('ranks warning above absent, and blocked above everything', () => {
    expect(rollUpState(['ok', 'ok'])).toBe('ok');
    expect(rollUpState(['ok', 'absent'])).toBe('absent');
    expect(rollUpState(['absent', 'warning'])).toBe('warning');
    expect(rollUpState(['warning', 'blocked'])).toBe('blocked');
    expect(rollUpState([])).toBe('ok');
  });

  it('uses the cache only while a result is still fresh', async () => {
    let runs = 0;
    const engine = new CheckEngine();
    engine.register({
      id: 'counted',
      category: 'server',
      name: 'Counted',
      plainDescription: 'Counts runs.',
      ttlSeconds: 300,
      run: async () => {
        runs++;
        return { state: 'ok' };
      },
    });

    await engine.runAll({ useCache: true });
    await engine.runAll({ useCache: true });
    expect(runs).toBe(1);

    await engine.runAll({ useCache: false });
    expect(runs).toBe(2);
  });

  it('selects only safe automatic fixes for the bulk action', async () => {
    const engine = new CheckEngine();
    engine.registerAll([
      makeCheck('ok-one', { state: 'ok' }),
      makeCheck('safe', {
        state: 'warning',
        fix: {
          kind: 'automatic',
          action: 'a',
          label: 'Fix',
          describesChange: 'x',
          safeToBatch: true,
          reversible: true,
        },
      }),
      makeCheck('risky', {
        state: 'blocked',
        // Changing the remote desktop port could lock the user out, so it
        // must never run as part of "fix everything".
        fix: {
          kind: 'automatic',
          action: 'b',
          label: 'Change RDP port',
          describesChange: 'y',
          safeToBatch: false,
          reversible: true,
        },
      }),
      makeCheck('manual', {
        state: 'blocked',
        fix: { kind: 'manual', label: 'Ask OVH', instructions: 'Open a ticket.' },
      }),
    ]);

    const results = await engine.runAll();
    const fixable = engine.batchFixable(results);

    expect(fixable.map((r) => r.id)).toEqual(['safe']);
  });

  it('throws for an unknown check id', async () => {
    const engine = new CheckEngine();
    await expect(engine.runOne('nope')).rejects.toThrow(/nope/);
  });
});

describe('status presentation', () => {
  it('gives every state an icon and a text label, not just a colour', () => {
    // Colour alone is unreadable for colour-blind users and in high contrast
    // modes, so each state must carry an icon and words too.
    for (const [state, presentation] of Object.entries(statusPresentation)) {
      expect(presentation.icon, state).toBeTruthy();
      expect(presentation.label, state).toBeTruthy();
      expect(presentation.token, state).toBeTruthy();
    }
  });
});

describe('port helpers', () => {
  it('detects a free port', async () => {
    expect(await isPortFree(0)).toBe(true);
  });

  it('detects a port that is in use', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    expect(await isPortFree(port, '127.0.0.1')).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('recognises Windows reserved port ranges', () => {
    // Binding inside one of these fails while netstat shows nothing
    // listening — worth detecting rather than debugging.
    const ranges = [
      { start: 50000, end: 50059 },
      { start: 3000, end: 3010 },
    ];

    expect(isPortExcluded(3005, ranges)).toBe(true);
    expect(isPortExcluded(3000, ranges)).toBe(true);
    expect(isPortExcluded(3010, ranges)).toBe(true);
    expect(isPortExcluded(3011, ranges)).toBe(false);
    expect(isPortExcluded(8443, ranges)).toBe(false);
  });
});

describe('server check definitions', () => {
  const checks = buildServerChecks();

  it('describes every check in plain English without jargon', () => {
    for (const check of checks) {
      expect(check.plainDescription.length, check.id).toBeGreaterThan(30);
      expect(check.plainDescription, check.id).not.toMatch(
        /registry key|reverse proxy|ACME|TLS-ALPN|DNS-01|W3SVC|LongPathsEnabled/,
      );
    }
  });

  it('gives every check a human-readable name', () => {
    for (const check of checks) {
      expect(check.name, check.id).not.toMatch(/[._]/);
      expect(check.name.length, check.id).toBeGreaterThan(3);
    }
  });

  it('covers the failure modes that are specific to a fresh Windows Server', () => {
    const ids = checks.map((c) => c.id);
    expect(ids).toContain('server.iis-conflict');
    expect(ids).toContain('server.long-paths');
    expect(ids).toContain('server.time-sync');
    expect(ids).toContain('server.disk-space');
    expect(ids).toContain('server.internet');
    expect(ids).toContain('server.background-services');
    expect(ids).toContain('server.firewall-rules');
  });

  it('runs every check without throwing on this machine', async () => {
    const engine = new CheckEngine();
    engine.registerAll(checks);

    const results = await engine.runAll();
    expect(results).toHaveLength(checks.length);
    for (const result of results) {
      expect(['ok', 'warning', 'blocked', 'absent', 'unknown']).toContain(result.state);
    }
  }, 30_000);
});

describe('firewall rules', () => {
  const names = requiredFirewallRules().map((rule) => rule.name);

  it('opens the preview port band so a site is reachable by IP', () => {
    const previews = requiredFirewallRules().find((rule) => rule.port === '7000-7999');
    expect(previews?.action).toBe('allow');
    expect(previews?.protocol).toBe('TCP');
  });

  it('reports nothing missing when every rule is present', () => {
    expect(missingFirewallRuleNames([...names, 'Some unrelated rule'])).toEqual([]);
  });

  it('names the rules Windows does not have', () => {
    const withoutPreviews = names.filter((name) => !name.includes('previews'));
    expect(missingFirewallRuleNames(withoutPreviews)).toEqual([
      'WinPanel - Website previews',
    ]);
  });
});
