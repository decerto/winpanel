import net from 'node:net';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import {
  OUTBOUND_SMTP_PROBE_HOSTS,
  type SmtpProbeOutcome,
  type SmtpProbeResult,
} from '@winpanel/shared';

/**
 * Mail readiness.
 *
 * Mail is the one part of this system that depends on things outside the
 * server. A hosting provider blocks outbound port 25 by default, and reverse
 * DNS is set in their control panel, not here. Neither can be automated — only
 * verified — so these checks re-run on a schedule and report when the
 * situation changes.
 */

/**
 * Opens a TCP connection and waits for the SMTP greeting.
 *
 * The distinction between the three outcomes is the whole point:
 *   - `timeout` is the signature of a provider-level block. The packets go
 *     nowhere and nothing answers.
 *   - `refused` means something actively said no, which is usually a local
 *     firewall.
 *   - `banner-received` means outbound mail genuinely works.
 *
 * A plain "can't connect" would conflate all three and send you looking in the
 * wrong place.
 */
export async function probeSmtp(
  host: string,
  port = 25,
  timeoutMs = 10_000,
): Promise<SmtpProbeResult> {
  const startedAt = Date.now();

  return await new Promise<SmtpProbeResult>((resolve) => {
    let settled = false;
    const socket = new net.Socket();

    const finish = (outcome: SmtpProbeOutcome, banner: string | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, outcome, banner, elapsedMs: Date.now() - startedAt });
    };

    socket.setTimeout(timeoutMs);

    socket.once('timeout', () => finish('timeout', null));

    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      // ETIMEDOUT surfaces as an error rather than the timeout event when the
      // OS gives up first, and it means the same thing.
      finish(code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'timeout' : 'error', null);
    });

    socket.once('data', (chunk) => {
      const banner = chunk.toString('utf8').trim();
      // A 220 greeting is the only response that proves a real SMTP server
      // answered, rather than something intercepting the port.
      finish(banner.startsWith('220') ? 'banner-received' : 'error', banner.slice(0, 200));
    });

    socket.connect(port, host);
  });
}

export interface OutboundMailResult {
  canSend: boolean;
  blocked: boolean;
  probes: SmtpProbeResult[];
  summary: string;
}

/**
 * Tests whether this server can send mail at all.
 *
 * Several well-known mail servers are probed, because any single one could be
 * down or rate-limiting us and a false negative here sends someone to their
 * hosting provider for no reason.
 */
export async function testOutboundMail(
  hosts: readonly string[] = OUTBOUND_SMTP_PROBE_HOSTS,
): Promise<OutboundMailResult> {
  const probes = await Promise.all(hosts.map((host) => probeSmtp(host)));

  const succeeded = probes.filter((probe) => probe.outcome === 'banner-received');
  const timedOut = probes.filter((probe) => probe.outcome === 'timeout');

  if (succeeded.length > 0) {
    return {
      canSend: true,
      blocked: false,
      probes,
      summary: 'This server can send email to the outside world.',
    };
  }

  // Every attempt hanging is the classic signature of a provider block.
  if (timedOut.length === probes.length) {
    return {
      canSend: false,
      blocked: true,
      probes,
      summary:
        'Outgoing email is blocked. Hosting providers block this by default and will ' +
        'usually unblock it on request \u2014 the panel will keep checking and tell you ' +
        'when it opens.',
    };
  }

  return {
    canSend: false,
    blocked: false,
    probes,
    summary:
      'Could not reach any mail servers. This may be a firewall on this machine rather ' +
      'than a block by your hosting provider.',
  };
}

export interface ReverseDnsResult {
  ok: boolean;
  pointerName: string | null;
  forwardConfirmed: boolean;
  matchesMailHostname: boolean;
  summary: string;
}

/**
 * Checks the server's reverse DNS.
 *
 * Forward-confirmed, deliberately: a PTR record alone proves nothing, because
 * anyone can point a name at any address. Receiving servers resolve the name
 * back and check it returns the same address, so that is what is checked here.
 */
export async function checkReverseDns(
  ipAddress: string,
  mailHostname: string,
  resolver: {
    reverse: (ip: string) => Promise<string[]>;
    resolve4: (host: string) => Promise<string[]>;
  } = dns,
): Promise<ReverseDnsResult> {
  let pointerName: string | null = null;

  try {
    const names = await resolver.reverse(ipAddress);
    pointerName = names[0] ?? null;
  } catch {
    return {
      ok: false,
      pointerName: null,
      forwardConfirmed: false,
      matchesMailHostname: false,
      summary:
        'Your server has no reverse name set. Most mail providers reject or spam-folder ' +
        'email from servers without one. Set it in your hosting provider\u2019s control panel.',
    };
  }

  if (!pointerName) {
    return {
      ok: false,
      pointerName: null,
      forwardConfirmed: false,
      matchesMailHostname: false,
      summary: 'Your server has no reverse name set.',
    };
  }

  let forwardConfirmed = false;
  try {
    const addresses = await resolver.resolve4(pointerName);
    forwardConfirmed = addresses.includes(ipAddress);
  } catch {
    forwardConfirmed = false;
  }

  const matchesMailHostname = pointerName.toLowerCase() === mailHostname.toLowerCase();

  if (!forwardConfirmed) {
    return {
      ok: false,
      pointerName,
      forwardConfirmed: false,
      matchesMailHostname,
      summary:
        `Your server's reverse name is "${pointerName}", but that name does not point ` +
        'back to this server. Receiving mail servers check both directions.',
    };
  }

  if (!matchesMailHostname) {
    return {
      ok: true,
      pointerName,
      forwardConfirmed: true,
      matchesMailHostname: false,
      summary:
        `Reverse name is "${pointerName}", which is valid but does not match your mail ` +
        `address "${mailHostname}". This usually still works, but matching them is better.`,
    };
  }

  return {
    ok: true,
    pointerName,
    forwardConfirmed: true,
    matchesMailHostname: true,
    summary: `Reverse name is correctly set to "${pointerName}".`,
  };
}

export interface RecordCheck {
  present: boolean;
  value: string | null;
  ok: boolean;
  summary: string;
}

/** Looks up and explains the SPF record. */
export async function checkSpf(
  domain: string,
  resolver: { resolveTxt: (host: string) => Promise<string[][]> } = dns,
): Promise<RecordCheck> {
  let records: string[][] = [];
  try {
    records = await resolver.resolveTxt(domain);
  } catch {
    return { present: false, value: null, ok: false, summary: 'No SPF record found.' };
  }

  const spf = records
    .map((parts) => parts.join(''))
    .find((value) => value.toLowerCase().startsWith('v=spf1'));

  if (!spf) {
    return {
      present: false,
      value: null,
      ok: false,
      summary:
        'No SPF record. Without one, other mail servers cannot tell that this server is ' +
        'allowed to send email for your domain.',
    };
  }

  // `+all` permits the entire internet to send as your domain, which is worse
  // than having no record at all.
  if (/[+]all/i.test(spf)) {
    return {
      present: true,
      value: spf,
      ok: false,
      summary: 'Your SPF record allows anyone to send email as your domain. Change +all to -all.',
    };
  }

  const strict = /[-~]all/i.test(spf);
  return {
    present: true,
    value: spf,
    ok: strict,
    summary: strict
      ? 'SPF record looks correct.'
      : 'Your SPF record does not say what to do with unauthorised senders. Add -all to the end.',
  };
}

export async function checkDmarc(
  domain: string,
  resolver: { resolveTxt: (host: string) => Promise<string[][]> } = dns,
): Promise<RecordCheck> {
  let records: string[][] = [];
  try {
    records = await resolver.resolveTxt(`_dmarc.${domain}`);
  } catch {
    return {
      present: false,
      value: null,
      ok: false,
      summary:
        'No DMARC record. This tells other mail servers what to do with email that fails ' +
        'the other checks.',
    };
  }

  const dmarc = records
    .map((parts) => parts.join(''))
    .find((value) => value.toLowerCase().startsWith('v=dmarc1'));

  if (!dmarc) {
    return { present: false, value: null, ok: false, summary: 'No DMARC record found.' };
  }

  const policy = /p=(none|quarantine|reject)/i.exec(dmarc)?.[1]?.toLowerCase();

  return {
    present: true,
    value: dmarc,
    ok: policy !== undefined,
    summary:
      policy === 'none'
        ? 'DMARC is set to monitor only. That is a fine starting point; tighten it later.'
        : `DMARC record found (policy: ${policy ?? 'unset'}).`,
  };
}

export async function checkMx(
  domain: string,
  expectedHost: string,
  resolver: { resolveMx: (host: string) => Promise<Array<{ exchange: string; priority: number }>> } = dns,
): Promise<RecordCheck> {
  let records: Array<{ exchange: string; priority: number }> = [];
  try {
    records = await resolver.resolveMx(domain);
  } catch {
    return {
      present: false,
      value: null,
      ok: false,
      summary: 'No MX record. Other servers have nowhere to deliver email for this domain.',
    };
  }

  if (records.length === 0) {
    return { present: false, value: null, ok: false, summary: 'No MX record found.' };
  }

  const value = records
    .sort((a, b) => a.priority - b.priority)
    .map((record) => `${record.priority} ${record.exchange}`)
    .join(', ');

  const pointsHere = records.some(
    (record) => record.exchange.toLowerCase().replace(/\.$/, '') === expectedHost.toLowerCase(),
  );

  return {
    present: true,
    value,
    ok: pointsHere,
    summary: pointsHere
      ? 'Email for this domain is delivered to this server.'
      : `Email for this domain goes to ${records[0]?.exchange}, not to this server.`,
  };
}

/**
 * Checks that a mail port offers encryption.
 *
 * Ports 465 and 993 are encrypted from the first byte; 25 and 587 start plain
 * and upgrade with STARTTLS.
 */
export async function checkMailTls(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; summary: string }> {
  const implicitTls = port === 465 || port === 993;

  if (!implicitTls) {
    const probe = await probeSmtp(host, port, timeoutMs);
    return {
      ok: probe.outcome === 'banner-received',
      summary:
        probe.outcome === 'banner-received'
          ? `Port ${port} is answering.`
          : `Port ${port} is not reachable from this server.`,
    };
  }

  return await new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const certificate = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.destroy();

        resolve({
          ok: authorized,
          summary: authorized
            ? `Port ${port} is encrypted with a valid certificate.`
            : `Port ${port} is encrypted, but the certificate is not trusted ` +
              `(${certificate.subject?.CN ?? 'unknown'}).`,
        });
      },
    );

    socket.once('error', () => {
      socket.destroy();
      resolve({ ok: false, summary: `Port ${port} is not reachable.` });
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, summary: `Port ${port} did not respond.` });
    });
  });
}
