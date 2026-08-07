import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the authorisation posture of the API surface.
 *
 * A missing authorisation check is the easiest security bug to introduce and
 * the hardest to notice: everything still works, it just also works for people
 * who should not be able to do it. These tests read the router source and fail
 * if a new endpoint is added without a deliberate decision about who may call
 * it.
 */

const ROUTERS_DIR = path.join(import.meta.dirname, '..', 'src', 'api', 'routers');

/**
 * The complete list of endpoints that may be reached without a session.
 *
 * Adding to this list should be a conscious act, which is the point of
 * spelling it out here.
 */
const ALLOWED_PUBLIC = new Set([
  // The login screen needs to know whether to show setup or sign-in. Returns
  // no secrets and no user data.
  'state',
  // Creating the very first account, gated by the installer's one-time code.
  'completeSetup',
  // Signing in.
  'login',
]);

async function routerSources(): Promise<Array<{ file: string; source: string }>> {
  const files = await fs.readdir(ROUTERS_DIR);

  return await Promise.all(
    files
      .filter((file) => file.endsWith('.ts'))
      .map(async (file) => ({
        file,
        source: await fs.readFile(path.join(ROUTERS_DIR, file), 'utf8'),
      })),
  );
}

/** Finds `name: someProcedure` declarations. */
function findProcedures(source: string): Array<{ name: string; procedure: string }> {
  const matches = source.matchAll(
    /^\s{2}(\w+):\s*(publicProcedure|publicAuditedProcedure|protectedProcedure|adminProcedure|superadminProcedure)/gm,
  );

  return [...matches].map((match) => ({
    name: match[1]!,
    procedure: match[2]!,
  }));
}

/**
 * Endpoints a customer may reach that do not name a website.
 *
 * The site-scope middleware can only check a request that says which website
 * it is about. Anything else on `protectedProcedure` is reachable by every
 * signed-in account, so each one is listed here deliberately — either it is
 * about the caller's own account, or it is harmless on its own.
 *
 * A new unscoped `protectedProcedure` fails this test until somebody decides
 * which of those two it is, or moves it to `adminProcedure`.
 */
const UNSCOPED_FOR_CUSTOMERS = new Set([
  // The caller's own account and its two-factor settings.
  'me',
  'logout',
  'changePassword',
  'beginTotp',
  'confirmTotp',
  'cancelTotp',
  'disableTotp',
  'recoveryCodeStatus',
  'regenerateRecoveryCodes',
  // Their own websites; each of these filters or checks ownership itself.
  'list',
  'get',
  'logs',
  'cancel',
  'create',
  'overview',
  'ping',
  // Making a website: a keypair and a repository probe, neither of which
  // touches anything that already exists.
  'deployKey',
  'testRepository',
  'inspect',
  // Webmail, which authenticates against the mail server with its own
  // password and hands back a token that scopes everything after it.
  'signOut',
  'folders',
  'messages',
  'message',
  'setSeen',
  'setFlagged',
  'move',
  'destroy',
  'attachment',
  'send',
  // Reads a mailbox address back as IMAP/SMTP settings. No lookup involved.
  'clientSettings',
]);

/**
 * How a handler names the website it is about.
 *
 * Matched on the handler because most inputs are named zod schemas defined
 * elsewhere; if the body reads `input.slug`, the request carried a slug,
 * which is exactly what the middleware checks. An inline schema declaring one
 * of the keys counts too, for the handlers that pass `input` along whole.
 */
const SCOPE_KEYS = /\binput\??\.(slug|siteSlug|domain|address)\b/;
const SCOPE_FIELDS = /\b(slug|siteSlug|domain|address)\s*:/;

describe('API authorisation', () => {
  it('exposes nothing publicly beyond the documented list', async () => {
    const offenders: string[] = [];

    for (const { file, source } of await routerSources()) {
      for (const { name, procedure } of findProcedures(source)) {
        const isPublic =
          procedure === 'publicProcedure' || procedure === 'publicAuditedProcedure';

        if (isPublic && !ALLOWED_PUBLIC.has(name)) {
          offenders.push(`${file}: ${name} is ${procedure}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('audits every public endpoint that changes something', async () => {
    // A brute-force attempt against an internet-facing panel must leave a
    // trail even though it never authenticates.
    for (const { file, source } of await routerSources()) {
      for (const { name, procedure } of findProcedures(source)) {
        if (procedure !== 'publicProcedure') continue;

        // Plain publicProcedure is only acceptable for reads.
        const isQuery = new RegExp(`${name}:\\s*publicProcedure[\\s\\S]{0,200}?\\.query`).test(
          source,
        );

        expect(isQuery, `${file}: ${name} must be a query or use publicAuditedProcedure`).toBe(
          true,
        );
      }
    }
  });

  it('re-authenticates before anything that changes how the account is protected', async () => {
    /*
     * A session cookie is not enough to alter the account's own defences.
     * Without this, a stolen cookie could silently repoint two-factor at the
     * attacker's device, or strip it off entirely, and the real owner would
     * find out at their next sign-in.
     */
    const source = await fs.readFile(path.join(ROUTERS_DIR, 'auth.ts'), 'utf8');

    // Each procedure runs to the start of the next one.
    const starts = [...source.matchAll(/^ {2}(\w+):/gm)];
    const bodyOf = (name: string): string => {
      const at = starts.findIndex((match) => match[1] === name);
      if (at === -1) return '';
      return source.slice(starts[at]!.index, starts[at + 1]?.index ?? source.length);
    };

    const offenders = [
      'beginTotp',
      'disableTotp',
      'regenerateRecoveryCodes',
      'changePassword',
    ].filter((name) => !bodyOf(name).includes('reauthenticate'));

    expect(offenders).toEqual([]);
  });

  it('protects every website, file, DNS and mail endpoint', async () => {
    for (const file of ['sites.ts', 'files.ts', 'dns.ts', 'mail.ts', 'checks.ts']) {
      const source = await fs.readFile(path.join(ROUTERS_DIR, file), 'utf8');
      const procedures = findProcedures(source);

      expect(procedures.length, `${file} has no procedures`).toBeGreaterThan(0);

      for (const { name, procedure } of procedures) {
        expect(
          ['protectedProcedure', 'adminProcedure', 'superadminProcedure'],
          `${file}: ${name}`,
        ).toContain(procedure);
      }
    }
  });

  it('keeps the whole machine away from customers', async () => {
    // Nothing that describes or changes the server may sit on the tier every
    // signed-in account can reach.
    for (const file of ['checks.ts', 'components.ts', 'system.ts']) {
      const source = await fs.readFile(path.join(ROUTERS_DIR, file), 'utf8');
      const procedures = findProcedures(source);

      expect(procedures.length, `${file} has no procedures`).toBeGreaterThan(0);

      for (const { name, procedure } of procedures) {
        expect(['adminProcedure', 'superadminProcedure'], `${file}: ${name}`).toContain(procedure);
      }
    }
  });

  it('leaves nothing a customer can reach without naming their own website', async () => {
    /*
     * The single check that makes the customer role safe. Ownership is
     * enforced centrally by reading the slug or domain out of the request, so
     * an endpoint that takes neither is reachable by anybody signed in.
     */
    const offenders: string[] = [];

    for (const { file, source } of await routerSources()) {
      const starts = [...source.matchAll(/^ {2}(\w+):\s*\w+Procedure/gm)];

      for (const [index, match] of starts.entries()) {
        const name = match[1]!;
        const body = source.slice(match.index, starts[index + 1]?.index ?? source.length);

        if (!/^ {2}\w+:\s*protectedProcedure/.test(body)) continue;
        if (UNSCOPED_FOR_CUSTOMERS.has(name)) continue;
        if (SCOPE_KEYS.test(body)) continue;

        const input = /\.input\(([\s\S]*?)\)\s*\.(query|mutation)/.exec(body);
        if (!input || !SCOPE_FIELDS.test(input[1]!)) offenders.push(`${file}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps sign-in activity to the owner alone', async () => {
    // Sessions, attempts and blocked addresses describe the whole machine and
    // every account on it. Not even an administrator sees these: the trail is
    // how the owner checks up on their administrators.
    const source = await fs.readFile(path.join(ROUTERS_DIR, 'access.ts'), 'utf8');
    const procedures = findProcedures(source);

    expect(procedures.length).toBeGreaterThan(0);

    for (const { name, procedure } of procedures) {
      expect(procedure, `access.ts: ${name}`).toBe('superadminProcedure');
    }
  });

  it('keeps removing the panel away from administrators', async () => {
    // "Admins are like owners but cannot delete the panel."
    const source = await fs.readFile(path.join(ROUTERS_DIR, 'system.ts'), 'utf8');
    const byName = new Map(findProcedures(source).map((entry) => [entry.name, entry.procedure]));

    for (const name of ['update', 'restartPanel', 'shutdown']) {
      expect(byName.get(name), `system.${name}`).toBe('superadminProcedure');
    }
  });

  it('gates the streamed routes that sit outside tRPC', async () => {
    // A download, an upload and an installer all move bytes that a browser
    // will only hand to a stream, so each is a plain Fastify handler and gets
    // none of the middleware above. Every guard has to be written out by hand,
    // and nothing breaks visibly if one is left out — hence checking here.
    const apiDir = path.join(import.meta.dirname, '..', 'src', 'api');
    const siteFiles = await fs.readFile(path.join(apiDir, 'site-files.ts'), 'utf8');
    const installer = await fs.readFile(path.join(apiDir, 'installer-upload.ts'), 'utf8');

    for (const [name, source] of [
      ['site-files.ts', siteFiles],
      ['installer-upload.ts', installer],
    ] as const) {
      expect(source, `${name}: session`).toContain('resolveSession');
      expect(source, `${name}: network`).toContain('isIpAllowed');
    }

    // A slug is guessable, so a session alone would let any customer read
    // another's source code.
    expect(siteFiles, 'site-files.ts: ownership').toContain('userMayAccessSite');

    // What lands here is later run as SYSTEM by system.update, which is the
    // owner's alone; anyone else able to write it would inherit that.
    expect(installer, 'installer-upload.ts: owner only').toContain("user.role !== 'superadmin'");
  });
});

describe('process execution', () => {
  it('spawns processes from exactly one module', async () => {
    // Everything else must route through the safe executor, which forbids a
    // shell and takes arguments as an array.
    const srcDir = path.join(import.meta.dirname, '..', 'src');
    const importers: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = await fs.readFile(full, 'utf8');
          if (source.includes("from 'node:child_process'")) {
            importers.push(path.relative(srcDir, full));
          }
        }
      }
    };

    await walk(srcDir);

    expect(importers).toEqual([path.join('process', 'run-command.ts')]);
  });

  it('never enables a shell', async () => {
    const srcDir = path.join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = await fs.readFile(full, 'utf8');
          if (/shell:\s*true/.test(source)) offenders.push(path.relative(srcDir, full));
        }
      }
    };

    await walk(srcDir);

    expect(offenders).toEqual([]);
  });
});
