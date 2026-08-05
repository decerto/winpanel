import crypto from 'node:crypto';

/**
 * Who is signed in to webmail, and with what.
 *
 * In memory and nowhere else. A mailbox password read from this process can
 * read every message in that mailbox, so it is never written to the database,
 * never encrypted-at-rest-and-therefore-decryptable, and never survives a
 * restart. The browser holds an opaque token; the password stays here.
 *
 * That does mean signing in again after the agent restarts. That is the
 * intended trade: the alternative is a panel database that quietly contains
 * the keys to everybody's email.
 */

/** Long enough for an afternoon of use, short enough to matter if left open. */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** A bound, so a compromised panel session cannot exhaust memory here. */
const MAX_SESSIONS = 50;

interface StoredSession {
  address: string;
  password: string;
  expiresAt: number;
}

export interface WebmailCredentials {
  address: string;
  password: string;
}

export class WebmailSessions {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now();

    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  open(credentials: WebmailCredentials): { token: string; expiresAt: number } {
    this.sweep();

    if (this.sessions.size >= MAX_SESSIONS) {
      // Oldest first, since the map preserves insertion order and an idle
      // session is the one least likely to be missed.
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + IDLE_TIMEOUT_MS;

    this.sessions.set(token, { ...credentials, expiresAt });
    return { token, expiresAt };
  }

  /** Null when unknown or expired; the caller shows "sign in again" for both. */
  get(token: string): WebmailCredentials | null {
    this.sweep();
    const session = this.sessions.get(token);
    if (!session) return null;

    // Every use pushes the expiry out, so somebody reading their mail is not
    // signed out mid-message.
    session.expiresAt = this.now() + IDLE_TIMEOUT_MS;
    return { address: session.address, password: session.password };
  }

  close(token: string): void {
    this.sessions.delete(token);
  }
}

/** One store for the process, because the tokens have to outlive a request. */
export const webmailSessions = new WebmailSessions();
