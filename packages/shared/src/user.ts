import { z } from 'zod';
import { GameServerAccountPolicy } from './game-server.js';

/**
 * Who someone is on this server.
 *
 * Three tiers, because a hosting panel has three genuinely different jobs to
 * do. `superadmin` owns the machine. `admin` runs it day to day but cannot
 * remove the panel or read the security trail. `user` is a customer: their own
 * websites and nothing else — no server settings, no runtimes, no other
 * people's sites.
 */
export const UserRole = z.enum(['superadmin', 'admin', 'user']);
export type UserRole = z.infer<typeof UserRole>;

/** Ordered strongest first, for "at least this much" comparisons. */
export const ROLE_RANK: Record<UserRole, number> = {
  superadmin: 3,
  admin: 2,
  user: 1,
};

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** What each role is called, and what it means, in one place. */
export const ROLE_LABELS: Record<UserRole, { label: string; description: string }> = {
  superadmin: {
    label: 'Owner',
    description:
      'Full control of this server, including updating and removing the panel itself.',
  },
  admin: {
    label: 'Administrator',
    description:
      'Can see and manage every website on the server, but cannot update or remove the panel.',
  },
  user: {
    label: 'Customer',
    description: 'Can only see and manage their own websites.',
  },
};

export const Username = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'Use letters, numbers, dots, dashes and underscores only.',
  );

export const User = z.object({
  id: z.string().uuid(),
  username: Username,
  role: UserRole,
  /** TOTP is mandatory; an account without it can only reach the setup flow. */
  totpEnrolled: z.boolean().default(false),
  disabled: z.boolean().default(false),
  lastLoginAt: z.coerce.date().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type User = z.infer<typeof User>;

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  /** Six-digit TOTP code. Required once enrolment is complete. */
  totp: z.string().regex(/^\d{6}$/).optional(),
  /**
   * Used instead of `totp` when the authenticator is gone. Accepted in any
   * case and with or without the dashes, because it is read off paper.
   */
  recoveryCode: z.string().min(8).max(64).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * Password policy. The panel is reachable from the internet, so this is
 * deliberately strict — but length is weighted over character-class rules,
 * which push people towards predictable substitutions.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH);

export const SetupRequest = z.object({
  /** One-time token printed by the installer. Proves physical/RDP access. */
  setupToken: z.string().min(16).max(128),
  username: Username,
  password: Password,
});
export type SetupRequest = z.infer<typeof SetupRequest>;

/**
 * What a customer account is allowed to consume.
 *
 * Null means "no limit", which is what an admin or the owner always gets. A
 * limit of 0 is a real answer too — an account that may hold no websites yet.
 */
export const AccountLimits = z.object({
  /** How many websites this account may own. Null for no limit. */
  siteLimit: z.number().int().min(0).max(1000).nullable().default(null),
  /** Total mailbox storage across their domains, in bytes. Null for no limit. */
  mailQuotaBytes: z.number().int().min(0).nullable().default(null),
  /** Disk given to each website they create. */
  siteDiskQuotaBytes: z.number().int().min(0).nullable().default(null),
  /**
   * How many databases this account may hold, across every engine and
   * whether or not they belong to one of their websites. Zero is the default
   * for a customer who was not sold databases, which is what keeps the whole
   * feature out of their panel until somebody decides otherwise.
   */
  databaseLimit: z.number().int().min(0).max(1000).nullable().default(null),
  ...GameServerAccountPolicy.shape,
});
export type AccountLimits = z.infer<typeof AccountLimits>;

export const CreateUserRequest = AccountLimits.extend({
  username: Username,
  password: Password,
  role: UserRole,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = AccountLimits.partial().extend({
  userId: z.string().uuid(),
  role: UserRole.optional(),
  disabled: z.boolean().optional(),
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const IpAllowlistEntry = z.object({
  id: z.string().uuid(),
  /** IPv4/IPv6 address or CIDR range. */
  cidr: z.string().min(3).max(64),
  note: z.string().max(200).default(''),
  createdAt: z.coerce.date(),
});
export type IpAllowlistEntry = z.infer<typeof IpAllowlistEntry>;

export const SecuritySettings = z.object({
  /** When false the panel serves plain HTTP — always surfaced as a warning. */
  httpsEnabled: z.boolean().default(true),
  ipAllowlistEnabled: z.boolean().default(false),
  /** Failed attempts from one IP before it is temporarily banned. */
  maxFailedLogins: z.number().int().min(3).max(50).default(8),
  banMinutes: z.number().int().min(1).max(1440).default(15),
  sessionIdleMinutes: z.number().int().min(5).max(10080).default(720),
});
export type SecuritySettings = z.infer<typeof SecuritySettings>;
