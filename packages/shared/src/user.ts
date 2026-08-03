import { z } from 'zod';

export const UserRole = z.enum(['owner', 'admin']);
export type UserRole = z.infer<typeof UserRole>;

export const User = z.object({
  id: z.string().uuid(),
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
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
  username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  password: Password,
});
export type SetupRequest = z.infer<typeof SetupRequest>;

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
