import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDmarc,
  checkMx,
  checkReverseDns,
  checkSpf,
  probeSmtp,
  testOutboundMail,
} from '../src/mail/readiness.js';

/**
 * Mail readiness checks.
 *
 * DNS is stubbed and SMTP is answered by a local socket, so these never touch
 * the internet or anyone's real domain.
 */

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Starts a throwaway server that sends a greeting, or nothing at all. */
async function startServer(greeting: string | null): Promise<number> {
  const server = net.createServer((socket) => {
    if (greeting !== null) socket.write(greeting);
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

describe('probeSmtp', () => {
  it('recognises a real mail server greeting', async () => {
    const port = await startServer('220 mail.example.com ESMTP ready\r\n');
    const result = await probeSmtp('127.0.0.1', port);

    expect(result.outcome).toBe('banner-received');
    expect(result.banner).toContain('220');
  });

  it('reports a refused connection separately from a timeout', async () => {
    // A refusal usually means a local firewall; a timeout means a provider
    // block. Conflating them sends people to the wrong place.
    const port = await startServer('220 ok\r\n');
    await new Promise<void>((resolve) => servers[0]!.close(() => resolve()));
    servers.length = 0;

    const result = await probeSmtp('127.0.0.1', port, 3000);
    expect(result.outcome).toBe('refused');
  });

  it('reports a timeout when nothing ever answers', async () => {
    // The signature of a provider-level block on port 25.
    const port = await startServer(null);
    const result = await probeSmtp('127.0.0.1', port, 500);

    expect(result.outcome).toBe('timeout');
  });

  it('treats a non-SMTP response as an error rather than success', async () => {
    // Something is listening, but it is not a mail server — an intercepting
    // proxy, for instance.
    const port = await startServer('HTTP/1.1 200 OK\r\n');
    const result = await probeSmtp('127.0.0.1', port);

    expect(result.outcome).toBe('error');
  });

  it('records how long the attempt took', async () => {
    const port = await startServer('220 ok\r\n');
    const result = await probeSmtp('127.0.0.1', port);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('outbound mail aggregation', () => {
  it('succeeds when any one server answers, even if others are silent', async () => {
    // One probe host being down must not produce a false "you are blocked",
    // which would send someone to their hosting provider for no reason.
    const good = await startServer('220 ok\r\n');
    const silent = await startServer(null);

    const probes = await Promise.all([
      probeSmtp('127.0.0.1', good),
      probeSmtp('127.0.0.1', silent, 400),
    ]);

    expect(probes.some((probe) => probe.outcome === 'banner-received')).toBe(true);
    expect(probes.every((probe) => probe.outcome === 'timeout')).toBe(false);
  }, 20_000);

  it('identifies a provider block when every attempt times out', async () => {
    // All hanging, none refused: packets going nowhere is what a
    // provider-level block on port 25 looks like.
    const a = await startServer(null);
    const b = await startServer(null);

    const probes = await Promise.all([
      probeSmtp('127.0.0.1', a, 400),
      probeSmtp('127.0.0.1', b, 400),
    ]);

    expect(probes.every((probe) => probe.outcome === 'timeout')).toBe(true);
  }, 20_000);

  it('reports plainly when the whole check cannot reach anything', async () => {
    // Uses unresolvable names, so nothing leaves this machine.
    const result = await testOutboundMail(['invalid.invalid', 'also-invalid.invalid']);

    expect(result.canSend).toBe(false);
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.probes).toHaveLength(2);
  }, 30_000);
});

describe('checkReverseDns', () => {
  const IP = '203.0.113.10';

  it('accepts a forward-confirmed name that matches the mail hostname', async () => {
    const result = await checkReverseDns(IP, 'mail.example.com', {
      reverse: async () => ['mail.example.com'],
      resolve4: async () => [IP],
    });

    expect(result.ok).toBe(true);
    expect(result.forwardConfirmed).toBe(true);
    expect(result.matchesMailHostname).toBe(true);
  });

  it('rejects a name that does not resolve back to this server', async () => {
    // A PTR record alone proves nothing: anyone can point a name anywhere.
    // Receiving servers confirm both directions, so this does too.
    const result = await checkReverseDns(IP, 'mail.example.com', {
      reverse: async () => ['mail.example.com'],
      resolve4: async () => ['198.51.100.1'],
    });

    expect(result.ok).toBe(false);
    expect(result.forwardConfirmed).toBe(false);
    expect(result.summary).toMatch(/does not point back/i);
  });

  it('explains the consequence when no reverse name is set', async () => {
    const result = await checkReverseDns(IP, 'mail.example.com', {
      reverse: async () => {
        throw new Error('ENOTFOUND');
      },
      resolve4: async () => [],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/reject or spam-folder/i);
    expect(result.summary).toMatch(/control panel/i);
  });

  it('accepts a valid name that differs from the mail hostname, with a note', async () => {
    const result = await checkReverseDns(IP, 'mail.example.com', {
      reverse: async () => ['server123.hosting.net'],
      resolve4: async () => [IP],
    });

    expect(result.ok).toBe(true);
    expect(result.matchesMailHostname).toBe(false);
    expect(result.summary).toMatch(/still works/i);
  });
});

describe('checkSpf', () => {
  it('accepts a strict record', async () => {
    const result = await checkSpf('example.com', {
      resolveTxt: async () => [['v=spf1 mx -all']],
    });

    expect(result.ok).toBe(true);
    expect(result.present).toBe(true);
  });

  it('rejects a record that lets anyone send as your domain', async () => {
    // +all is worse than having no record at all.
    const result = await checkSpf('example.com', {
      resolveTxt: async () => [['v=spf1 mx +all']],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/allows anyone/i);
  });

  it('flags a record with no failure policy', async () => {
    const result = await checkSpf('example.com', {
      resolveTxt: async () => [['v=spf1 mx']],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/-all/);
  });

  it('explains why a missing record matters', async () => {
    const result = await checkSpf('example.com', { resolveTxt: async () => [] });

    expect(result.present).toBe(false);
    expect(result.summary).toMatch(/cannot tell/i);
  });

  it('joins split TXT records before parsing', async () => {
    // Long records arrive as several strings and must be reassembled.
    const result = await checkSpf('example.com', {
      resolveTxt: async () => [['v=spf1 ', 'mx ', '-all']],
    });

    expect(result.ok).toBe(true);
  });
});

describe('checkDmarc', () => {
  it('accepts a record and reports the policy', async () => {
    const result = await checkDmarc('example.com', {
      resolveTxt: async () => [['v=DMARC1; p=reject; rua=mailto:a@example.com']],
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('reject');
  });

  it('describes monitor-only mode as a starting point rather than a fault', async () => {
    const result = await checkDmarc('example.com', {
      resolveTxt: async () => [['v=DMARC1; p=none']],
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/monitor only/i);
  });

  it('explains what a missing record means', async () => {
    const result = await checkDmarc('example.com', {
      resolveTxt: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    expect(result.present).toBe(false);
    expect(result.summary).toMatch(/what to do with email/i);
  });
});

describe('checkMx', () => {
  it('confirms mail is delivered to this server', async () => {
    const result = await checkMx('example.com', 'mail.example.com', {
      resolveMx: async () => [{ exchange: 'mail.example.com', priority: 10 }],
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/delivered to this server/i);
  });

  it('says where mail actually goes when it points elsewhere', async () => {
    const result = await checkMx('example.com', 'mail.example.com', {
      resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('aspmx.l.google.com');
  });

  it('ignores a trailing dot on the hostname', async () => {
    const result = await checkMx('example.com', 'mail.example.com', {
      resolveMx: async () => [{ exchange: 'mail.example.com.', priority: 10 }],
    });

    expect(result.ok).toBe(true);
  });

  it('explains that no MX means nowhere to deliver', async () => {
    const result = await checkMx('example.com', 'mail.example.com', {
      resolveMx: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    expect(result.present).toBe(false);
    expect(result.summary).toMatch(/nowhere to deliver/i);
  });
});
