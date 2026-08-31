import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { secrets, settings } from '../db/schema.js';
import { generateToken } from '../security/password.js';
import type { SecretVault } from '../security/vault.js';
import { loadMailAdminCredentials } from './credentials.js';
import { StalwartClient } from './stalwart-client.js';
import { WebmailClient, type MailAddress } from './webmail-client.js';

export const PANEL_EMAIL_SETTINGS_KEY = 'panel.email';
export const PANEL_EMAIL_LOCAL_PASSWORD_KEY = 'panel.email.localPassword';
export const PANEL_EMAIL_SMTP_PASSWORD_KEY = 'panel.email.smtpPassword';

export type PanelEmailMode = 'local' | 'external';
export type PanelEmailSecurity = 'none' | 'starttls' | 'tls';

export interface PanelEmailSettings {
  mode: PanelEmailMode;
  fromAddress: string;
  fromName: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: PanelEmailSecurity | null;
  smtpUsername: string | null;
  smtpPasswordConfigured: boolean;
}

export interface ConfigurePanelEmailInput {
  mode: PanelEmailMode;
  fromAddress: string;
  fromName?: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecurity?: PanelEmailSecurity | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
}

export interface PanelMessage {
  to: MailAddress;
  subject: string;
  text: string;
  html?: string;
}

function settingsFromValue(value: unknown): Omit<PanelEmailSettings, 'smtpPasswordConfigured'> | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (entry.mode !== 'local' && entry.mode !== 'external') return null;
  if (typeof entry.fromAddress !== 'string' || typeof entry.fromName !== 'string') return null;

  const smtpSecurity = entry.smtpSecurity;
  if (
    smtpSecurity !== null &&
    smtpSecurity !== 'none' &&
    smtpSecurity !== 'starttls' &&
    smtpSecurity !== 'tls'
  ) {
    return null;
  }

  return {
    mode: entry.mode,
    fromAddress: entry.fromAddress,
    fromName: entry.fromName,
    smtpHost: typeof entry.smtpHost === 'string' ? entry.smtpHost : null,
    smtpPort: typeof entry.smtpPort === 'number' ? entry.smtpPort : null,
    smtpSecurity,
    smtpUsername: typeof entry.smtpUsername === 'string' ? entry.smtpUsername : null,
  };
}

export class PanelMailer {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly vault: SecretVault,
    private readonly localClient: (address: string, password: string) => WebmailClient =
      (address, password) => new WebmailClient(address, password),
    private readonly smtpTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
  ) {}

  getSettings(): PanelEmailSettings | null {
    const row = this.db.db.select().from(settings).where(eq(settings.key, PANEL_EMAIL_SETTINGS_KEY)).get();
    const parsed = settingsFromValue(row?.value);
    if (!parsed) return null;

    return {
      ...parsed,
      smtpPasswordConfigured: this.hasSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY),
    };
  }

  async configure(input: ConfigurePanelEmailInput): Promise<PanelEmailSettings> {
    const fromAddress = input.fromAddress.trim().toLowerCase();
    const current = this.getSettings();

    if (input.mode === 'local') {
      await this.configureLocalMailbox(fromAddress, current);
      this.deleteSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY);
    } else {
      if (!input.smtpHost?.trim()) throw new Error('Enter the external mail server address.');
      if (input.smtpUsername?.trim() && input.smtpPassword === undefined && !this.hasSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY)) {
        throw new Error('Enter the password for the external mail server.');
      }
      if (input.smtpPassword !== undefined) {
        if (input.smtpPassword) {
          this.storeSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY, input.smtpPassword);
        } else {
          this.deleteSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY);
        }
      }
    }

    const value = {
      mode: input.mode,
      fromAddress,
      fromName: input.fromName?.trim() ?? '',
      smtpHost: input.mode === 'external' ? input.smtpHost!.trim() : null,
      smtpPort: input.mode === 'external' ? input.smtpPort ?? 587 : null,
      smtpSecurity: input.mode === 'external' ? input.smtpSecurity ?? 'starttls' : null,
      smtpUsername:
        input.mode === 'external' ? input.smtpUsername?.trim() || null : null,
    } satisfies Omit<PanelEmailSettings, 'smtpPasswordConfigured'>;

    this.db.db
      .insert(settings)
      .values({ key: PANEL_EMAIL_SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      })
      .run();

    return this.getSettings()!;
  }

  async send(message: PanelMessage): Promise<void> {
    const configured = this.getSettings();
    if (!configured) {
      throw new Error('Panel email is not configured. Set it up on the Settings page first.');
    }

    if (configured.mode === 'local') {
      const password = this.loadSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY);
      if (!password) throw new Error('The panel mailbox password is unavailable. Save its address again.');

      await this.localClient(configured.fromAddress, password).send({
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      return;
    }

    if (!configured.smtpHost || !configured.smtpPort || !configured.smtpSecurity) {
      throw new Error('The external mail settings are incomplete.');
    }

    const password = this.loadSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY);
    const transport = this.smtpTransport({
      host: configured.smtpHost,
      port: configured.smtpPort,
      secure: configured.smtpSecurity === 'tls',
      requireTLS: configured.smtpSecurity === 'starttls',
      ...(configured.smtpUsername
        ? { auth: { user: configured.smtpUsername, pass: password ?? '' } }
        : {}),
    });

    try {
      await transport.sendMail({
        from: { address: configured.fromAddress, name: configured.fromName },
        to: message.to.name ? { address: message.to.email, name: message.to.name } : message.to.email,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
    } finally {
      transport.close();
    }
  }

  async sendMany(messages: readonly PanelMessage[]): Promise<void> {
    for (const message of messages) await this.send(message);
  }

  private async configureLocalMailbox(
    address: string,
    current: PanelEmailSettings | null,
  ): Promise<void> {
    const existingPassword = this.loadSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY);
    if (current?.mode === 'local' && current.fromAddress === address && existingPassword) return;

    const credentials = loadMailAdminCredentials(this.db, this.vault);
    if (!credentials) {
      throw new Error('Connect the local mail server on the Settings page before using it here.');
    }

    const admin = new StalwartClient(credentials.username, credentials.password);
    const [, domain] = address.split('@');
    const existing = domain
      ? (await admin.listMailboxes(domain)).some(
          (mailbox) => mailbox.name.toLowerCase() === address,
        )
      : false;

    if (existing) {
      throw new Error(
        'That address already belongs to a mailbox. Choose an unused address for panel mail.',
      );
    }

    const password = generateToken(24);
    await admin.createMailbox({
      address,
      password,
      displayName: 'WinPanel notifications',
      quotaBytes: 0,
    });
    this.storeSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY, password);
  }

  private hasSecret(key: string): boolean {
    return this.db.db.select().from(secrets).where(eq(secrets.key, key)).get() !== undefined;
  }

  private loadSecret(key: string): string | null {
    const row = this.db.db.select().from(secrets).where(eq(secrets.key, key)).get();
    if (!row) return null;
    try {
      return this.vault.decrypt(row.ciphertext, key);
    } catch {
      return null;
    }
  }

  private storeSecret(key: string, value: string): void {
    const ciphertext = this.vault.encrypt(value, key);
    this.db.db
      .insert(secrets)
      .values({ key, ciphertext, updatedAt: new Date() })
      .onConflictDoUpdate({ target: secrets.key, set: { ciphertext, updatedAt: new Date() } })
      .run();
  }

  private deleteSecret(key: string): void {
    this.db.db.delete(secrets).where(eq(secrets.key, key)).run();
  }
}
