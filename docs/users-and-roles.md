# Users, roles and sign-in

## Roles

Defined once in `packages/shared/src/user.ts` and used by both sides.

| Role | Label in the UI | Can reach |
| --- | --- | --- |
| `superadmin` | Owner | Everything, including updating and removing the panel and the security trail |
| `admin` | Administrator | Every website, mailbox and server setting, but not the panel's own lifecycle |
| `user` | Customer | Their own websites and nothing else |

`ROLE_RANK` and `roleAtLeast` express "at least this much" comparisons; `ROLE_LABELS`
holds the wording, so the panel never invents its own.

## Enforcement

Three procedure builders in `apps/agent/src/api/trpc.ts`:

| Builder | Requires |
| --- | --- |
| `protectedProcedure` | A valid session, plus site ownership when the input names one |
| `adminProcedure` | `admin` or above |
| `superadminProcedure` | `superadmin` |

`enforceSiteScope` is the interesting one. When the caller is a `user` and the raw input
carries a `slug` or a `domain`, it checks that the site is theirs — and answers
`NOT_FOUND` rather than `FORBIDDEN`, so the panel cannot be used to enumerate which slugs
and domains exist on the server.

Because it runs as middleware on `protectedProcedure`, any new site-scoped procedure is
covered the moment it accepts a `slug`. `sites.traffic` and `mail.mailboxes` get their
ownership check this way, with no code of their own.

There is deliberately **no** tier gated on two-factor enrolment. Two factors are optional,
so an account without them is a supported state rather than a half-finished one, and a
middleware refusing those accounts would lock them out of the panel entirely.

Endpoints that take the site as *optional* and fall back to server-wide data need one
extra guard, because the fallback is the owner's data. `dns.ts` has `requireOwnSite` for
exactly this: a customer must name one of their own websites rather than be shown every
zone in the server owner's Cloudflare account.

## Limits

`AccountLimits` in `packages/shared/src/user.ts`:

| Limit | Meaning |
| --- | --- |
| `siteLimit` | How many websites the account may own |
| `mailQuotaBytes` | Total mailbox storage across all of their domains |
| `siteDiskQuotaBytes` | Disk given to each website they create |

`null` means no limit, which is what an `admin` and the owner always get. `0` is a real
answer too — an account that may hold no websites yet.

## Passwords and second factors

- Minimum length 12, maximum 1024. Length is weighted over character-class rules, which
  push people towards predictable substitutions.
- Hashed with Argon2id (`@node-rs/argon2`), with parameters at the upper end of the OWASP
  recommendations.
- TOTP: 6 digits, 30-second period, ±1 step validation window. The pending secret is held
  encrypted until the first correct code confirms enrolment.
- Ten recovery codes are issued when two-factor is turned on, 64 bits each, spendable
  once. They are stored under a fast hash rather than Argon2 — the same as session tokens
  — so the entropy has to do the work. They are accepted in any case and with or without
  dashes, because they are read off paper.

## Sessions

`SESSION_TTL_MS` is 12 hours. The session token lives in the `winpanel_session` cookie.
The owner can list every live session with its address and device, end one, or end all
except the current browser.

## Failed sign-ins and IP bans

`apps/agent/src/security/throttle.ts` runs two layers over a 15-minute sliding window:

1. an escalating delay that grows with each failure, so casual guessing and slow
   distributed grinds both become expensive well before anything is blocked, and
2. a time-boxed ban once failures pass the threshold.

A correct password clears both the ban and the failure counter for that address. Clearing
only the ban would leave the escalating delay in place for someone who has just proved who
they are.

Bans are per address, and the Sign-in activity page says so — a whole office usually shares
one address, so unblocking is one click.

## Secrets

`SecretVault` (`apps/agent/src/security/vault.ts`) encrypts stored secrets with AES-GCM.
The master key is wrapped with Windows DPAPI at machine scope. On non-Windows — tests and
CI only — the key is stored unwrapped and the panel shows a warning; production is always
Windows.
