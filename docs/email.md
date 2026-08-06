# Email

Mail is served by [Stalwart](https://stalw.art/). WinPanel installs it as a Windows
Service (`winpanel-stalwart`) and manages it entirely over JMAP.

## Talking to Stalwart

The only management surface is JMAP on `http://127.0.0.1:8080/jmap`, with

```
using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']
```

and these object types: `x:Domain`, `x:Account`, `x:NetworkListener`, `x:Certificate`.
The client lives in `apps/agent/src/mail/`. There is no config-file editing path; if
something cannot be expressed over JMAP, it is not supported.

## Mailboxes

Mailboxes belong to the website that owns the domain, so `mail.mailboxes` is site-scoped
and inherits the ownership check every site-scoped procedure gets. A customer sees their
own domains' mailboxes and nothing else.

| Procedure | Role |
| --- | --- |
| `mail.domains`, `mail.serverStatus`, `mail.provisionServer`, `mail.connectServer` | `admin` |
| `mail.mailboxes`, `mail.createMailbox`, `mail.setMailboxQuota`, `mail.setMailboxDisplayName`, `mail.setMailboxPassword`, `mail.deleteMailbox`, `mail.addDomain` | site-scoped |
| `mail.testOutbound`, `mail.installCertificate`, `mail.recordUnblockRequested` | `admin` |

Each mailbox carries a quota (`null` meaning no limit), aliases, a display name (the mail
server's `description` field, shown as the sender's name on outgoing mail) and a password.
Both `mail.createMailbox` and `mail.setMailboxPassword` take an optional `password`: supply
one to choose it, or omit it and the panel generates one. Either way it is returned once and
never stored here. A customer account additionally has a total mail allowance across all of
their domains — see [users-and-roles.md](users-and-roles.md).

## Client ports

Defined once in `packages/shared/src/mail.ts` (`MAIL_CLIENT_PORTS`):

| Port | Protocol |
| --- | --- |
| 993 | IMAP, implicit TLS |
| 995 | POP3, implicit TLS |
| 465 | SMTP submission, implicit TLS — what Outlook picks |
| 587 | SMTP submission, STARTTLS |
| 25 | SMTP between servers |

Port 995 was added after the first releases, so installs older than that need the
`server.restore-firewall` fix on the Health page to open it.

## The certificate problem

Stalwart issues itself an `rcgen` self-signed certificate on first start and never
replaces it. The panel's own webmail works fine — it connects over loopback and validates
nothing — but Outlook, Apple Mail and phone clients refuse it, usually with a message that
never mentions certificates ("Something went wrong while setting up your account"). This
is *the* cause of "webmail works, Outlook doesn't".

`syncMailCertificates()` in `apps/agent/src/mail/service.ts` fixes it:

1. find the certificate Caddy issued, under
   `<caddyDir>/caddy/certificates/<issuer>/<subject>/` (skipping the `local` issuer),
2. install it through `StalwartClient.installCertificate` (`x:Certificate/set`, matched by
   exact lowercase SAN),
3. restart `winpanel-stalwart` **only if** something changed.

It runs at startup and every six hours, and is also exposed as `mail.installCertificate`.
Renewal is the same code path: Caddy renews on disk and nothing tells Stalwart, so the
timer re-copies. Expiry comparison has a ±60s tolerance — an exact millisecond comparison
eventually drifts and restarts the mail server twice a day. Each hostname has its own
try/catch, because one rejected hostname used to abort the loop and silently stop every
later domain renewing.

For Caddy to have a certificate to copy, the name has to be in its config:
`CaddyReconciler.buildConfig` adds `mail.<domain>` for every non-`www` site domain. There
is no "issue now" admin endpoint — listing the name and reloading the config *is* the
mechanism.

## Readiness checks

`apps/agent/src/mail/readiness.ts` powers the "Will your email arrive?" panel. It
separates `reachable` from `certificateTrusted`, because a port that answers with a
certificate no client trusts is a different problem from a port that does not answer.

`probeMailPort` returns `certificateDaysRemaining` measured **at the port**, which is the
only proof a renewal actually reached mail clients. At or below the warning threshold
(14 days) it reports a warning rather than an error.

Checks cover: outbound delivery on port 25, reverse DNS, MX, SPF, DKIM, DMARC, submission,
IMAP, and the certificate clients see. `mail.dnsStatus` produces the records that would
fix the failing ones, and `mail.setUpDns` publishes them through the site's Cloudflare
token.

When probing certificate subjects, note that Node's `getPeerCertificate()` DN fields can
be `string | string[]`; normalise before assigning to `string | null`.
