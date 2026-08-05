import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SQLite is the panel's own store. Deliberately local: the control panel has
 * to work when the network is down, which is exactly when you need it most.
 * (Hosted sites keep using whatever database they already use — MongoDB Atlas
 * and friends are unaffected by this choice.)
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['owner', 'admin'] })
      .notNull()
      .default('admin'),
    /** Encrypted with the vault. Null until enrolment completes. */
    totpSecret: text('totp_secret'),
    /*
     * An enrolment that has been started but not proven yet.
     *
     * Kept apart from the live secret so that replacing an authenticator
     * cannot lock anyone out: until a code from the new device is accepted,
     * sign-in still expects codes from the old one.
     */
    totpPendingSecret: text('totp_pending_secret'),
    totpEnrolled: integer('totp_enrolled', { mode: 'boolean' }).notNull().default(false),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_username_idx').on(table.username)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the cookie value. The raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

/**
 * Single-use codes for signing in when the authenticator is gone.
 *
 * Without these the second factor is also a single point of failure: a lost
 * phone locks the owner out of the machine their websites run on, and the
 * only way back is editing this database by hand over RDP.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the code. The code itself is shown once and never stored. */
    codeHash: text('code_hash').notNull(),
    /** Set the moment it is spent, so a code works exactly once. */
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

/** Failed login tracking, for progressive rate limiting and IP banning. */
export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ip: text('ip').notNull(),
    username: text('username'),
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull(),
    at: integer('at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('login_attempts_ip_at_idx').on(table.ip, table.at)],
);

export const ipBans = sqliteTable('ip_bans', {
  ip: text('ip').primaryKey(),
  until: integer('until', { mode: 'timestamp_ms' }).notNull(),
  reason: text('reason').notNull().default(''),
});

export const ipAllowlist = sqliteTable('ip_allowlist', {
  id: text('id').primaryKey(),
  cidr: text('cidr').notNull(),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/** Non-secret configuration, stored as JSON values. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/** Vault-encrypted values. The ciphertext is bound to its key as AAD. */
export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    runtime: text('runtime', { enum: ['node', 'static', 'dotnet', 'proxy'] }).notNull(),
    /** JSON array of hostnames. */
    domains: text('domains', { mode: 'json' }).notNull().default(sql`'[]'`),
    /** JSON, discriminated on `kind`. */
    source: text('source', { mode: 'json' }).notNull(),
    /** The parsed winpanel.json for this site. */
    manifest: text('manifest', { mode: 'json' }).notNull(),
    portBlue: integer('port_blue'),
    portGreen: integer('port_green'),
    /** Public port that reaches this site without a domain. */
    previewPort: integer('preview_port'),
    activeColour: text('active_colour', { enum: ['blue', 'green'] }).notNull().default('blue'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Whether `shared/` is published at `/shared`. Off for sites with nothing to put there. */
    sharedFolderEnabled: integer('shared_folder_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    diskQuotaBytes: integer('disk_quota_bytes').notNull().default(21474836480),
    ...timestamps,
  },
  (table) => [uniqueIndex('sites_slug_idx').on(table.slug)],
);

export const portAllocations = sqliteTable(
  'port_allocations',
  {
    port: integer('port').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    colour: text('colour', { enum: ['blue', 'green', 'preview'] }).notNull(),
    allocatedAt: integer('allocated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('port_allocations_site_idx').on(table.siteId)],
);

export const deployments = sqliteTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').notNull(),
    status: text('status').notNull(),
    commit: text('commit'),
    targetColour: text('target_colour', { enum: ['blue', 'green'] }).notNull(),
    jobId: text('job_id'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    errorMessage: text('error_message'),
  },
  (table) => [index('deployments_site_started_idx').on(table.siteId, table.startedAt)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    title: text('title').notNull(),
    progress: integer('progress'),
    payload: text('payload', { mode: 'json' }),
    siteId: text('site_id'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    /** Set when a cancellation has been requested by the user. */
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('jobs_status_created_idx').on(table.status, table.createdAt),
    index('jobs_site_idx').on(table.siteId),
  ],
);

export const jobLogs = sqliteTable(
  'job_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: integer('at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    level: text('level', { enum: ['debug', 'info', 'warn', 'error'] })
      .notNull()
      .default('info'),
    step: text('step'),
    message: text('message').notNull(),
  },
  (table) => [index('job_logs_job_seq_idx').on(table.jobId, table.seq)],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    at: integer('at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    userId: text('user_id'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
    detail: text('detail', { mode: 'json' }).notNull().default(sql`'{}'`),
  },
  (table) => [index('audit_events_at_idx').on(table.at)],
);

export const components = sqliteTable('components', {
  id: text('id').primaryKey(),
  state: text('state').notNull().default('not-installed'),
  installedVersion: text('installed_version'),
  availableVersion: text('available_version'),
  installPath: text('install_path'),
  serviceName: text('service_name'),
  lastError: text('last_error'),
  installedAt: integer('installed_at', { mode: 'timestamp_ms' }),
});

/**
 * Undo records for server hardening.
 *
 * Every change the panel makes to the machine records the previous value here
 * first, so "Undo" is a real capability rather than a promise. Without this,
 * a control panel that edits registry keys and firewall rules is a one-way
 * door.
 */
export const serverChanges = sqliteTable(
  'server_changes',
  {
    id: text('id').primaryKey(),
    checkId: text('check_id').notNull(),
    /** What kind of thing changed: registry, service, firewall, policy. */
    changeType: text('change_type').notNull(),
    /** Identifies the specific setting, e.g. a registry path. */
    targetKey: text('target_key').notNull(),
    /** JSON snapshot of the value before the change. Null means "did not exist". */
    previousValue: text('previous_value', { mode: 'json' }),
    newValue: text('new_value', { mode: 'json' }),
    undone: integer('undone', { mode: 'boolean' }).notNull().default(false),
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    undoneAt: integer('undone_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('server_changes_check_idx').on(table.checkId)],
);

/** Cached check results so the Health page is instant. */
export const checkResults = sqliteTable('check_results', {
  id: text('id').primaryKey(),
  category: text('category').notNull(),
  state: text('state').notNull(),
  detail: text('detail'),
  reason: text('reason'),
  siteSlug: text('site_slug'),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type SiteRow = typeof sites.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
