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

Mailbox Webmail uses the same loopback JMAP endpoint with the mail, submission, and Sieve
capabilities, authenticated as the mailbox rather than as the mail administrator.

## Mailboxes

Mailboxes belong to the website that owns the domain, so `mail.mailboxes` is site-scoped
and inherits the ownership check every site-scoped procedure gets. A customer sees their
own domains' mailboxes and nothing else.

| Procedure | Role |
| --- | --- |
| `mail.domains`, `mail.serverStatus`, `mail.provisionServer`, `mail.connectServer`, `mail.blockedIps`, `mail.blockIp`, `mail.unblockIp` | `admin` |
| `mail.mailboxes`, `mail.createMailbox`, `mail.setMailboxReceiving`, `mail.setMailboxQuota`, `mail.setMailboxDisplayName`, `mail.setMailboxAliases`, `mail.setMailboxPassword`, `mail.deleteMailbox`, `mail.addDomain` | site-scoped |
| `mail.testOutbound`, `mail.installCertificate`, `mail.recordUnblockRequested` | `admin` |
| `webmail.signIn`, `webmail.folders`, `webmail.messages`, `webmail.message`, `webmail.send`, `webmail.blockedSenders`, `webmail.blockSender`, `webmail.unblockSender` | protected by a mailbox session |

Each mailbox carries a receive mode, quota (`null` meaning no limit), aliases, a display name
(the mail server's `description` field, shown as the sender's name on outgoing mail) and a
password. A normal mailbox receives mail. A **No Reply** mailbox keeps `emailSend` enabled but
disables Stalwart's `emailReceive` permission, so it can authenticate and send while messages
addressed to it, or to one of its aliases, are refused. `mail.createMailbox` accepts the mode
with `receivesMail`; `mail.setMailboxReceiving` changes it for an existing mailbox.
Both `mail.createMailbox` and `mail.setMailboxPassword` take an optional `password`: supply
one to choose it, or omit it and the panel generates one. Either way it is returned once and
never stored here. A customer account additionally has a total mail allowance across all of
their domains - see [users-and-roles.md](users-and-roles.md). Opening Webmail still asks for
that mailbox password: an administrator can reset a mailbox password, but cannot silently read
the mailbox. Webmail keeps the password only in an in-memory session, and a newly generated or
chosen password is shown once before it can only be replaced.

### Panel sender

The owner configures the sender for outage alerts, password recovery and other panel mail in
Settings. **From this server** lists every existing mailbox address and alias; selecting one asks
for its mailbox password, which is stored encrypted on the server. When an alias is selected, the
panel signs in through the primary mailbox and sends with the alias as the visible sender.
**External SMTP** uses a separate SMTP provider. **Create New** makes a new send-only mailbox on
the local server with a generated password. A newly created sender appears under **From this
server** afterward, and an existing address should be selected there rather than created again.

### Sender blocks

Webmail can block an exact sender address from the open-message toolbar or its **Blocked
senders** list. The block belongs to that mailbox, not to the whole server or panel account.
New messages from a blocked address are moved to the mailbox's `Junk` folder by a managed Sieve
condition, so they remain recoverable. Adding or removing a block preserves the mailbox owner's
existing active Sieve rules; the panel only updates the conditions it owns. Sender addresses
are normalised to lowercase and are always scoped through the mailbox session.

### Aliases

`mail.setMailboxAliases` replaces the whole list rather than adding to it, so an address
removed in the panel is removed on the server. Every alias must be in a domain the mail
server already handles, and one that already has its own mailbox is refused - the mail
server's own complaint does not say which of the two addresses is at fault.

Aliases matter for sending, not only receiving. Stalwart rejects a message whose envelope
sender is not an address the authenticated account owns (`501 5.5.4 You are not allowed to
send from this address`), so an application that signs in once and sends as `noreply@`,
`support@` and `invoices@` needs the three to be one account with two aliases, not three
separate mailboxes.

On the wire an alias is `{ name, domainId, enabled }` in the account's index-keyed
`aliases` map; the read path composes `emails` as the primary address followed by the
aliases, which is why `mail.mailboxes` returns `aliases: emails.slice(1)`.

### Inbound access blocks

Administrators can block an exact IPv4 or IPv6 address, or a CIDR network, from the Email page.
These blocks are machine-wide: they stop inbound connections before Stalwart handles mail for
any domain on the server. Customers cannot view or change them. The panel keeps and sends the
opaque Stalwart rule ID when removing a block, rather than guessing from the address; the list
also shows the rule's reason and expiry when Stalwart provides them.

## Client ports

Defined once in `packages/shared/src/mail.ts` (`MAIL_CLIENT_PORTS`):

| Port | Protocol |
| --- | --- |
| 993 | IMAP, implicit TLS |
| 995 | POP3, implicit TLS |
| 465 | SMTP submission, implicit TLS - what Outlook picks |
| 587 | SMTP submission, STARTTLS |
| 25 | SMTP between servers |

Port 995 was added after the first releases, so installs older than that need the
`server.restore-firewall` fix on the Health page to open it.

## The certificate problem

Stalwart issues itself an `rcgen` self-signed certificate on first start and never
replaces it. The panel's own webmail works fine - it connects over loopback and validates
nothing - but Outlook, Apple Mail and phone clients refuse it, usually with a message that
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
timer re-copies. Expiry comparison has a ±60s tolerance - an exact millisecond comparison
eventually drifts and restarts the mail server twice a day. Each hostname has its own
try/catch, because one rejected hostname used to abort the loop and silently stop every
later domain renewing.

For Caddy to have a certificate to copy, the name has to be in its config:
`CaddyReconciler.buildConfig` adds `mail.<domain>` for every non-`www` site domain. There
is no "issue now" admin endpoint - listing the name and reloading the config *is* the
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
