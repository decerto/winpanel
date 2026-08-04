import { z } from 'zod';

export const JobStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * Every long-running or privileged operation becomes a job so it can be
 * streamed, cancelled, retried, and audited. The panel calls these "Activity".
 */
export const JobKind = z.enum([
  'deploy',
  'rollback',
  'install-component',
  'uninstall-component',
  'issue-certificate',
  'apply-server-fix',
  'apply-dns-records',
  'create-site',
  'delete-site',
  'mail-readiness-check',
  'backup',
  'health-check',
  /** A package-manager or Node command the user asked to run against a site. */
  'run-command',
  /** Installing a newer WinPanel over the running one. */
  'update-panel',
]);
export type JobKind = z.infer<typeof JobKind>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const JobLogLine = z.object({
  seq: z.number().int().nonnegative(),
  at: z.coerce.date(),
  level: LogLevel,
  message: z.string(),
  /** Which build step or sub-task produced this line. */
  step: z.string().optional(),
});
export type JobLogLine = z.infer<typeof JobLogLine>;

export const Job = z.object({
  id: z.string().uuid(),
  kind: JobKind,
  status: JobStatus,
  /** Plain-English summary shown in the Activity list. */
  title: z.string().min(1).max(200),
  /** 0..100, or null when the job cannot report meaningful progress. */
  progress: z.number().min(0).max(100).nullable().default(null),
  /** Free-form payload, validated per job kind by the handler. */
  payload: z.unknown(),
  siteId: z.string().uuid().nullable().default(null),
  /** Set when the job failed — plain English, with a fix hint where possible. */
  errorMessage: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(1),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable().default(null),
  finishedAt: z.coerce.date().nullable().default(null),
});
export type Job = z.infer<typeof Job>;

export const AuditEvent = z.object({
  id: z.string().uuid(),
  at: z.coerce.date(),
  /** Null for actions taken by the system itself (scheduled checks, renewals). */
  userId: z.string().uuid().nullable(),
  /** Dotted action name, e.g. `site.delete`, `server.fix.long-paths`. */
  action: z.string().min(1).max(120),
  /** What was acted on, e.g. a site slug or component id. */
  target: z.string().max(200).nullable().default(null),
  /** Source IP of the request, for logins and mutations. */
  ip: z.string().max(64).nullable().default(null),
  outcome: z.enum(['success', 'failure']),
  /** Structured detail; must never contain secret values. */
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
