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
export type PanelEmailSetupMode = PanelEmailMode | 'new';
export type PanelEmailSecurity = 'none' | 'starttls' | 'tls';

export interface PanelEmailSettings {
  mode: PanelEmailMode;
  fromAddress: string;
  fromName: string;
  localPasswordConfigured: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: PanelEmailSecurity | null;
  smtpUsername: string | null;
  smtpPasswordConfigured: boolean;
}

export interface PanelEmailAddressOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ConfigurePanelEmailInput {
  mode: PanelEmailSetupMode;
  fromAddress: string;
  fromName?: string;
  localPassword?: string | null;
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

interface StoredPanelEmailSettings {
  mode: PanelEmailMode;
  fromAddress: string;
  fromName: string;
  localLoginAddress: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: PanelEmailSecurity | null;
  smtpUsername: string | null;
}

function settingsFromValue(value: unknown): StoredPanelEmailSettings | null {
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
    localLoginAddress:
      typeof entry.localLoginAddress === 'string' && entry.localLoginAddress.trim().length > 0
        ? entry.localLoginAddress.trim().toLowerCase()
        : null,
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
    private readonly localClient: (
      senderAddress: string,
      password: string,
      loginAddress?: string,
    ) => WebmailClient = (senderAddress, password, loginAddress = senderAddress) =>
      new WebmailClient(senderAddress, password, undefined, undefined, loginAddress),
    private readonly smtpTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
  ) {}

  private getStoredSettings(): StoredPanelEmailSettings | null {
    const row = this.db.db.select().from(settings).where(eq(settings.key, PANEL_EMAIL_SETTINGS_KEY)).get();
    return settingsFromValue(row?.value);
  }

  getSettings(): PanelEmailSettings | null {
    const parsed = this.getStoredSettings();
    if (!parsed) return null;

    return {
      mode: parsed.mode,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      localPasswordConfigured: parsed.mode === 'local' && this.hasSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY),
      smtpHost: parsed.smtpHost,
      smtpPort: parsed.smtpPort,
      smtpSecurity: parsed.smtpSecurity,
      smtpUsername: parsed.smtpUsername,
      smtpPasswordConfigured: this.hasSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY),
    };
  }

  async getLocalAddressOptions(): Promise<PanelEmailAddressOption[]> {
    const current = this.getSettings();
    const credentials = loadMailAdminCredentials(this.db, this.vault);
    if (!credentials) {
      return current?.mode === 'local'
        ? [{ value: current.fromAddress, label: current.fromAddress, hint: 'Current sender' }]
        : [];
    }

    const admin = new StalwartClient(credentials.username, credentials.password);
    const domains = (await admin.listDomains())
      .map((domain) => domain.toLowerCase())
      .filter((domain, index, values) => values.indexOf(domain) === index)
      .sort();
    const options = new Map<string, PanelEmailAddressOption>();

    for (const domain of domains) {
      try {
        const mailboxes = await admin.listMailboxes(domain);
        for (const mailbox of mailboxes) {
          const primary = mailbox.name.toLowerCase();
          for (const email of mailbox.emails) {
            const value = email.trim().toLowerCase();
            if (value.length === 0) continue;
            options.set(value, {
              value,
              label: value,
              hint: value === primary ? mailbox.description || 'Mailbox' : `Alias for ${primary}`,
            });
          }
        }
      } catch {
        continue;
      }
    }

    if (current?.mode === 'local') {
      options.set(current.fromAddress, {
        value: current.fromAddress,
        label: current.fromAddress,
        hint: 'Current sender',
      });
    }

    return [...options.values()].sort((left, right) => left.value.localeCompare(right.value));
  }

  async configure(input: ConfigurePanelEmailInput): Promise<PanelEmailSettings> {
    const fromAddress = input.fromAddress.trim().toLowerCase();
    const current = this.getStoredSettings();
    let localLoginAddress: string | null = null;

    if (input.mode === 'local') {
      localLoginAddress = await this.configureExistingLocalMailbox(
        fromAddress,
        input.localPassword,
        current,
      );

      this.deleteSecret(PANEL_EMAIL_SMTP_PASSWORD_KEY);
    } else if (input.mode === 'new') {
      localLoginAddress = await this.createLocalMailbox(fromAddress);
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
      this.deleteSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY);
    }

    const mode: PanelEmailMode = input.mode === 'new' ? 'local' : input.mode;
    const value = {
      mode,
      fromAddress,
      fromName: input.fromName?.trim() ?? '',
      localLoginAddress: mode === 'local' ? localLoginAddress : null,
      smtpHost: input.mode === 'external' ? input.smtpHost!.trim() : null,
      smtpPort: input.mode === 'external' ? input.smtpPort ?? 587 : null,
      smtpSecurity: input.mode === 'external' ? input.smtpSecurity ?? 'starttls' : null,
      smtpUsername:
        input.mode === 'external' ? input.smtpUsername?.trim() || null : null,
    } satisfies StoredPanelEmailSettings;

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
    const configured = this.getStoredSettings();
    if (!configured) {
      throw new Error('Panel email is not configured. Set it up on the Settings page first.');
    }

    if (configured.mode === 'local') {
      const password = this.loadSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY);
      if (!password) throw new Error('The panel mailbox password is unavailable. Save its address again.');

      await this.localClient(
        configured.fromAddress,
        password,
        configured.localLoginAddress ?? configured.fromAddress,
      ).send({
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

  private async configureExistingLocalMailbox(
    address: string,
    suppliedPassword: string | null | undefined,
    current: StoredPanelEmailSettings | null,
  ): Promise<string> {
    const credentials = loadMailAdminCredentials(this.db, this.vault);
    if (!credentials) {
      throw new Error('Connect the local mail server on the Settings page before using it here.');
    }

    const admin = new StalwartClient(credentials.username, credentials.password);
    const [, domain] = address.split('@');
    const mailbox = domain
      ? (await admin.listMailboxes(domain)).find((entry) =>
          entry.emails.some((email) => email.toLowerCase() === address),
        )
      : undefined;

    if (!mailbox) {
      throw new Error('Choose a mailbox that already exists on this server.');
    }

    const loginAddress =
      current?.mode === 'local' && current.fromAddress === address
        ? current.localLoginAddress ?? mailbox.name
        : mailbox.name;
    const enteredPassword = suppliedPassword && suppliedPassword.length > 0 ? suppliedPassword : null;
    const password =
      enteredPassword ??
      (current?.mode === 'local' && current.fromAddress === address
        ? this.loadSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY)
        : null);

    if (!password) {
      throw new Error(`Enter the password for ${address}.`);
    }

    if (enteredPassword) {
      await this.localClient(address, password, loginAddress).signIn();
    }

    this.storeSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY, password);
    return loginAddress.toLowerCase();
  }

  private async createLocalMailbox(address: string): Promise<string> {
    const credentials = loadMailAdminCredentials(this.db, this.vault);
    if (!credentials) {
      throw new Error('Connect the local mail server on the Settings page before using it here.');
    }

    const admin = new StalwartClient(credentials.username, credentials.password);
    const [, domain] = address.split('@');
    const existing = domain
      ? (await admin.listMailboxes(domain)).some((mailbox) =>
          mailbox.emails.some((email) => email.toLowerCase() === address),
        )
      : false;

    if (existing) {
      throw new Error(
        'That address already belongs to a mailbox. Select it under From this server instead.',
      );
    }

    const password = generateToken(24);
    await admin.createMailbox({
      address,
      password,
      displayName: 'WinPanel notifications',
      quotaBytes: 0,
      receivesMail: false,
    });
    this.storeSecret(PANEL_EMAIL_LOCAL_PASSWORD_KEY, password);
    return address;
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
