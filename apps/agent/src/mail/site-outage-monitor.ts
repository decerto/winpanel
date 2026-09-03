import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { siteOutageStates, sites, users } from '../db/schema.js';
import { isPortAnswered, type PortProbe } from '../windows/service-probe.js';
import { siteServiceId } from '../windows/panel-services.js';
import { sitesMidDeploy } from '../windows/watched-services.js';
import { websiteOutageEmail } from './templates.js';
import type { MailAddress } from './webmail-client.js';

const PROCESS_RUNTIMES = new Set(['node', 'dotnet', 'php']);
const FAILURE_CONFIRMATION_COUNT = 2;
const DEFAULT_INTERVAL_MS = 60_000;

interface MonitorSite {
  id: string;
  slug: string;
  displayName: string;
  ownerUserId: string | null;
  runtime: string;
  enabled: boolean;
  activeColour: 'blue' | 'green';
  portBlue: number | null;
  portGreen: number | null;
  previewPort: number | null;
  domains: unknown;
}

interface MonitorRecipient {
  id: string;
  username: string;
  role: 'superadmin' | 'admin' | 'user';
  email: string | null;
  emailVerifiedAt: Date | null;
  outageNotifications: boolean;
}

export interface OutageMailMessage {
  to: MailAddress;
  subject: string;
  text: string;
  html: string;
}

export interface OutageMonitorMailer {
  send(message: OutageMailMessage): Promise<void>;
}

export interface SiteOutageMonitorOptions {
  db: DatabaseHandle;
  mailer: OutageMonitorMailer;
  probe?: PortProbe;
  /** True when the panel asked the site's Windows service to stay stopped. */
  isIntentionallyStopped?: (serviceId: string) => boolean;
  now?: () => Date;
  log?: (message: string, detail?: unknown) => void;
}

export interface OutageSweepResult {
  checked: number;
  ignored: number;
  failed: number;
  notifications: number;
}

function appPort(site: MonitorSite): number | null {
  if (!site.enabled) return null;
  if (PROCESS_RUNTIMES.has(site.runtime)) {
    return site.activeColour === 'blue' ? site.portBlue : site.portGreen;
  }
  return site.previewPort;
}

function firstDomain(site: MonitorSite): string | null {
  return Array.isArray(site.domains) && typeof site.domains[0] === 'string'
    ? site.domains[0]
    : null;
}

/**
 * Checks website liveness without depending on a panel request.
 *
 * Two failed sweeps are required before an outage is announced. The result
 * lives in SQLite so a panel restart neither forgets an active outage nor
 * announces it again. Only a change from healthy to confirmed-down, and back
 * again, produces mail.
 */
export class SiteOutageMonitor {
  readonly #db: DatabaseHandle;
  readonly #mailer: OutageMonitorMailer;
  readonly #probe: PortProbe;
  readonly #isIntentionallyStopped: (serviceId: string) => boolean;
  readonly #now: () => Date;
  readonly #log: (message: string, detail?: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #sweeping = false;
  #initialSweep = true;

  constructor(options: SiteOutageMonitorOptions) {
    this.#db = options.db;
    this.#mailer = options.mailer;
    this.#probe = options.probe ?? isPortAnswered;
    this.#isIntentionallyStopped = options.isIntentionallyStopped ?? (() => false);
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => undefined);
  }

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.sweep(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async sweep(): Promise<OutageSweepResult> {
    if (this.#sweeping) return { checked: 0, ignored: 0, failed: 0, notifications: 0 };
    this.#sweeping = true;

    try {
      const rows = this.#db.db
        .select({
          id: sites.id,
          slug: sites.slug,
          displayName: sites.displayName,
          ownerUserId: sites.ownerUserId,
          runtime: sites.runtime,
          enabled: sites.enabled,
          activeColour: sites.activeColour,
          portBlue: sites.portBlue,
          portGreen: sites.portGreen,
          previewPort: sites.previewPort,
          domains: sites.domains,
        })
        .from(sites)
        .all() as MonitorSite[];
      const allowNotifications = !this.#initialSweep;
      this.#initialSweep = false;
      const deploying = sitesMidDeploy(this.#db);

      const result: OutageSweepResult = {
        checked: 0,
        ignored: 0,
        failed: 0,
        notifications: 0,
      };

      for (const site of rows) {
        /*
         * A deploy takes the site down on purpose for as long as it needs to
         * swap the folder and start the new version. Mailing the customer
         * that their website is down, and again when it comes back, for a
         * change they asked for teaches them to ignore the alert that
         * matters. The recorded state is left exactly as it was, so a site
         * that was already down before the deploy still gets its recovery
         * message once the deploy fixes it.
         */
        if (deploying.has(site.id)) {
          result.ignored++;
          continue;
        }

        const serviceId = PROCESS_RUNTIMES.has(site.runtime)
          ? siteServiceId(site.slug, site.activeColour)
          : null;
        if (serviceId && this.#isIntentionallyStopped(serviceId)) {
          this.saveIgnored(site.id);
          result.ignored++;
          continue;
        }

        const port = appPort(site);
        if (port === null) {
          this.saveIgnored(site.id);
          result.ignored++;
          continue;
        }

        result.checked++;
        let answered = false;
        try {
          answered = await this.#probe(port);
        } catch (error) {
          // A probe failure is not proof that a customer site is down. Leave
          // its confirmation counter alone and try again on the next sweep.
          result.failed++;
          this.#log(`Could not check website ${site.slug}.`, error);
          continue;
        }

        const notified = await this.record(site, answered, allowNotifications);
        result.notifications += notified;
      }

      return result;
    } finally {
      this.#sweeping = false;
    }
  }

  private saveIgnored(siteId: string): void {
    const now = this.#now();
    this.#db.db
      .insert(siteOutageStates)
      .values({
        siteId,
        state: 'up',
        consecutiveFailures: 0,
        checkedAt: now,
        notifiedState: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: siteOutageStates.siteId,
        set: {
          state: 'up',
          consecutiveFailures: 0,
          checkedAt: now,
          notifiedState: null,
          updatedAt: now,
        },
      })
      .run();
  }

  private async record(
    site: MonitorSite,
    answered: boolean,
    allowNotifications: boolean,
  ): Promise<number> {
    const now = this.#now();
    const previous = this.#db.db
      .select()
      .from(siteOutageStates)
      .where(eq(siteOutageStates.siteId, site.id))
      .get();

    if (answered) {
      const recovered = previous?.notifiedState === 'down';
      this.saveResult(site.id, 'up', 0, recovered ? 'up' : (previous?.notifiedState ?? null), now);
      if (!recovered || !allowNotifications) return 0;
      return await this.notify(site, true);
    }

    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const confirmed = consecutiveFailures >= FAILURE_CONFIRMATION_COUNT;
    const shouldNotify = allowNotifications && confirmed && previous?.notifiedState !== 'down';
    this.saveResult(
      site.id,
      confirmed ? 'down' : 'unknown',
      consecutiveFailures,
      previous?.notifiedState ?? null,
      now,
    );

    if (!shouldNotify) return 0;
    const sent = await this.notify(site, false);
    this.#db.db
      .update(siteOutageStates)
      .set({ notifiedState: 'down', updatedAt: this.#now() })
      .where(eq(siteOutageStates.siteId, site.id))
      .run();
    return sent;
  }

  private saveResult(
    siteId: string,
    state: 'unknown' | 'up' | 'down',
    consecutiveFailures: number,
    notifiedState: 'up' | 'down' | null,
    checkedAt: Date,
  ): void {
    this.#db.db
      .insert(siteOutageStates)
      .values({
        siteId,
        state,
        consecutiveFailures,
        checkedAt,
        notifiedState,
        updatedAt: checkedAt,
      })
      .onConflictDoUpdate({
        target: siteOutageStates.siteId,
        set: { state, consecutiveFailures, checkedAt, notifiedState, updatedAt: checkedAt },
      })
      .run();
  }

  private async notify(site: MonitorSite, recovered: boolean): Promise<number> {
    const recipients = this.recipients(site.ownerUserId);
    const domain = firstDomain(site);
    let sent = 0;

    for (const recipient of recipients) {
      if (!recipient.email) continue;
      const message = websiteOutageEmail({
        username: recipient.username,
        siteName: site.displayName,
        domain,
        recovered,
      });

      try {
        await this.#mailer.send({
          to: { name: recipient.username, email: recipient.email },
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        sent++;
      } catch (error) {
        this.#log(`Could not send a website ${recovered ? 'recovery' : 'outage'} email.`, error);
      }
    }

    return sent;
  }

  private recipients(ownerUserId: string | null): MonitorRecipient[] {
    const people = this.#db.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        outageNotifications: users.outageNotifications,
      })
      .from(users)
      .where(eq(users.disabled, false))
      .all() as MonitorRecipient[];

    const selected = people.filter(
      (person) =>
        person.email &&
        person.emailVerifiedAt !== null &&
        (person.role === 'superadmin' ||
          person.role === 'admin' ||
          (person.id === ownerUserId && person.outageNotifications)),
    );

    const seen = new Set<string>();
    return selected.filter((person) => {
      const address = person.email!.toLowerCase();
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
  }
}