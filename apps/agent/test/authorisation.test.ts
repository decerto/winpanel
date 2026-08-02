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
    /^\s{2}(\w+):\s*(publicProcedure|publicAuditedProcedure|authedProcedure|protectedProcedure)/gm,
  );

  return [...matches].map((match) => ({
    name: match[1]!,
    procedure: match[2]!,
  }));
}

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

  it('requires two-factor for everything except enrolment itself', async () => {
    // authedProcedure means "signed in but two-factor not finished". Only the
    // endpoints needed to finish enrolling should use it, or an interrupted
    // setup would leave a permanently single-factor account in charge.
    const allowedAuthedOnly = new Set(['confirmTotp', 'logout', 'ping']);
    const offenders: string[] = [];

    for (const { file, source } of await routerSources()) {
      for (const { name, procedure } of findProcedures(source)) {
        if (procedure === 'authedProcedure' && !allowedAuthedOnly.has(name)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('protects every website, file, DNS and mail endpoint', async () => {
    for (const file of ['sites.ts', 'files.ts', 'dns.ts', 'mail.ts', 'checks.ts']) {
      const source = await fs.readFile(path.join(ROUTERS_DIR, file), 'utf8');
      const procedures = findProcedures(source);

      expect(procedures.length, `${file} has no procedures`).toBeGreaterThan(0);

      for (const { name, procedure } of procedures) {
        expect(procedure, `${file}: ${name}`).toBe('protectedProcedure');
      }
    }
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
