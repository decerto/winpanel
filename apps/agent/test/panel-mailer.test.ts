import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src/db/index.js';
import {
  PANEL_EMAIL_LOCAL_PASSWORD_KEY,
  PanelMailer,
} from '../src/mail/panel-mailer.js';
import { storeMailAdminCredentials } from '../src/mail/credentials.js';
import { SecretVault } from '../src/security/vault.js';

const stalwart = vi.hoisted(() => ({
  listDomains: vi.fn(),
  listMailboxes: vi.fn(),
  createMailbox: vi.fn(),
}));

vi.mock('../src/mail/stalwart-client.js', () => ({
  StalwartClient: vi.fn(() => stalwart),
}));

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
  stalwart.listDomains.mockReset();
  stalwart.listMailboxes.mockReset();
  stalwart.createMailbox.mockReset();
});

afterEach(async () => {
  handle.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PanelMailer', () => {
  it('lists existing local senders and keeps the configured sender visible', async () => {
    handle.db
      .insert(schema.settings)
      .values({
        key: 'panel.email',
        value: {
          mode: 'local',
          fromAddress: 'panel@example.com',
          fromName: 'WinPanel',
          smtpHost: null,
          smtpPort: null,
          smtpSecurity: null,
          smtpUsername: null,
        },
      })
      .run();
    storeMailAdminCredentials(handle, vault, { username: 'admin', password: 'mail-admin' });

    stalwart.listDomains.mockResolvedValue(['Example.com', 'other.example']);
    stalwart.listMailboxes.mockImplementation(async (domain: string) =>
      domain === 'example.com'
        ? [
            { name: 'panel@example.com', emails: ['panel@example.com'] },
            { name: 'winpanel@example.com', emails: ['winpanel@example.com', 'alerts@example.com'] },
          ]
        : [{ name: 'panel@other.example', emails: ['panel@other.example'] }],
    );

    const mailer = new PanelMailer(handle, vault, () => ({ send: vi.fn() } as never));
    const options = await mailer.getLocalAddressOptions();

    expect(options.map((option) => option.value)).toEqual([
      'alerts@example.com',
      'panel@example.com',
      'panel@other.example',
      'winpanel@example.com',
    ]);
    expect(options.find((option) => option.value === 'panel@example.com')).toMatchObject({
      hint: 'Current sender',
    });
    expect(stalwart.listMailboxes).toHaveBeenCalledWith('example.com');
    expect(stalwart.listMailboxes).toHaveBeenCalledWith('other.example');
  });

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

  it('creates the local panel sender as a send-only mailbox', async () => {
    storeMailAdminCredentials(handle, vault, { username: 'admin', password: 'mail-admin' });
    stalwart.listMailboxes.mockResolvedValue([]);

    const mailer = new PanelMailer(handle, vault, () => ({ send: vi.fn() } as never));
    await mailer.configure({
      mode: 'new',
      fromAddress: 'noreply@example.com',
      fromName: 'WinPanel',
    });

    expect(stalwart.createMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'noreply@example.com',
        receivesMail: false,
      }),
    );
  });

  it('uses the primary mailbox login when an existing alias is selected', async () => {
    storeMailAdminCredentials(handle, vault, { username: 'admin', password: 'mail-admin' });
    stalwart.listMailboxes.mockResolvedValue([
      {
        name: 'primary@example.com',
        emails: ['primary@example.com', 'alerts@example.com'],
      },
    ]);

    const signIn = vi.fn(async () => ({ address: 'primary@example.com', accountId: 'account-1' }));
    const localClient = vi.fn(() => ({ signIn, send: vi.fn() } as never));
    const mailer = new PanelMailer(handle, vault, localClient);
    await mailer.configure({
      mode: 'local',
      fromAddress: 'alerts@example.com',
      fromName: 'WinPanel',
      localPassword: 'mailbox-secret',
    });

    expect(localClient).toHaveBeenCalledWith(
      'alerts@example.com',
      'mailbox-secret',
      'primary@example.com',
    );
    expect(signIn).toHaveBeenCalledWith();
    expect(mailer.getSettings()).toMatchObject({
      mode: 'local',
      fromAddress: 'alerts@example.com',
      localPasswordConfigured: true,
    });
  });

  it('rejects a create-new address already owned as a mailbox alias', async () => {
    storeMailAdminCredentials(handle, vault, { username: 'admin', password: 'mail-admin' });
    stalwart.listMailboxes.mockResolvedValue([
      {
        name: 'primary@example.com',
        emails: ['primary@example.com', 'alerts@example.com'],
      },
    ]);

    const mailer = new PanelMailer(handle, vault, () => ({ send: vi.fn() } as never));
    await expect(
      mailer.configure({
        mode: 'new',
        fromAddress: 'alerts@example.com',
        fromName: 'WinPanel',
      }),
    ).rejects.toThrow(/select it under from this server/i);
    expect(stalwart.createMailbox).not.toHaveBeenCalled();
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
