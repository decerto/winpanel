import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import {
  PANEL_EMAIL_LOCAL_PASSWORD_KEY,
  PanelMailer,
} from '../src/mail/panel-mailer.js';
import { SecretVault } from '../src/security/vault.js';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'drizzle');

let tmpDir: string;
let handle: DatabaseHandle;
let vault: SecretVault;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'winpanel-mailer-'));
  handle = createDatabase(path.join(tmpDir, 'test.db'));
  migrateDatabase(handle, MIGRATIONS);
  vault = new SecretVault(path.join(tmpDir, 'vault.key'));
  await vault.initialise();
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PanelMailer', () => {
  it('sends local mail through the dedicated encrypted mailbox', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const address = 'panel@example.com';
    const password = 'local-secret';

    handle.db
      .insert(schema.settings)
      .values({
        key: 'panel.email',
        value: {
          mode: 'local',
          fromAddress: address,
          fromName: 'WinPanel',
          smtpHost: null,
          smtpPort: null,
          smtpSecurity: null,
          smtpUsername: null,
        },
      })
      .run();
    handle.db
      .insert(schema.secrets)
      .values({
        key: PANEL_EMAIL_LOCAL_PASSWORD_KEY,
        ciphertext: vault.encrypt(password, PANEL_EMAIL_LOCAL_PASSWORD_KEY),
      })
      .run();

    const mailer = new PanelMailer(handle, vault, () => ({ send } as never));
    await mailer.send({
      to: { name: 'Sam', email: 'sam@example.com' },
      subject: 'Down',
      text: 'Plain',
      html: '<p>HTML</p>',
    });

    expect(send).toHaveBeenCalledWith({
      to: [{ name: 'Sam', email: 'sam@example.com' }],
      subject: 'Down',
      text: 'Plain',
      html: '<p>HTML</p>',
    });
  });

  it('keeps SMTP credentials out of settings and sends each recipient separately', async () => {
    const sent: unknown[] = [];
    const close = vi.fn();
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
      close,
    }));
    const mailer = new PanelMailer(handle, vault, undefined, createTransport as never);

    await mailer.configure({
      mode: 'external',
      fromAddress: 'panel@example.net',
      fromName: 'WinPanel',
      smtpHost: 'smtp.example.net',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUsername: 'panel@example.net',
      smtpPassword: 'secret',
    });

    const saved = JSON.stringify(mailer.getSettings());
    expect(saved).not.toContain('secret');
    expect(mailer.getSettings()?.smtpPasswordConfigured).toBe(true);

    await mailer.sendMany([
      { to: { name: null, email: 'a@example.net' }, subject: 'A', text: 'A' },
      { to: { name: null, email: 'b@example.net' }, subject: 'B', text: 'B' },
    ]);

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.net',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'panel@example.net', pass: 'secret' },
    });
    expect(sent).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('closes an SMTP transport when delivery fails', async () => {
    const close = vi.fn();
    const mailError = new Error('connection refused');
    const sendMail = vi.fn(async () => {
      throw mailError;
    });
    const mailer = new PanelMailer(
      handle,
      vault,
      undefined,
      vi.fn(() => ({ sendMail, close })) as never,
    );

    await mailer.configure({
      mode: 'external',
      fromAddress: 'panel@example.net',
      smtpHost: 'smtp.example.net',
      smtpPort: 587,
      smtpSecurity: 'starttls',
    });

    await expect(
      mailer.send({
        to: { name: null, email: 'owner@example.net' },
        subject: 'Test',
        text: 'Test',
      }),
    ).rejects.toBe(mailError);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
