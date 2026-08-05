# DNS

WinPanel manages DNS through Cloudflare only. Everything lives in
`apps/agent/src/dns/` and is exposed by `apps/agent/src/api/routers/dns.ts`.

## Tokens

A Cloudflare API token reaches the zones of the account that issued it, and nothing else.
One server routinely hosts domains belonging to different people, so a single
machine-wide token would work for exactly one account and fail silently for every other.

So tokens are held **per website**, falling back to a shared one:

| Scope | Stored by | Used when |
| --- | --- | --- |
| Site token | `storeSiteCloudflareToken` | A request names a `slug` and that site has one |
| Shared token | `storeCloudflareToken` | A request names no site, or the site has no token |

`cloudflareTokenForSite` resolves the pair. Both are encrypted by `SecretVault` and never
leave the server — the API returns zones, records and status, never the token.

`requireOwnSite` in the DNS router refuses to let a `user` account fall back to the shared
token: several endpoints take the site as optional and answer for the shared token when it
is left out, which would otherwise let a customer list every zone in the server owner's
Cloudflare account.

## Pointing a domain at the server

`planWebsiteRecords` reads the **whole zone** and reconciles it, rather than upserting the
two records a website wants. Upserting is only correct on an empty zone; a domain moved
from another host arrives with a full set, and every one of these failures is silent:

- a second apex `A` record round-robins half the visitors back to the old machine
- an `AAAA` record sends every IPv6 visitor there permanently
- a `CNAME` at the apex or at `www` blocks the write entirely
- `mail`, `ftp`, `webmail` still resolve to a server that is being switched off

What the planner does:

- writes the apex `A` and the `www` `CNAME`, deleting duplicates and conflicting types
- adds a `CAA` record for Let's Encrypt **only if** no `issue "letsencrypt.org"` CAA
  already exists, because CAA is additive and overwriting someone else's would break
  their renewals
- never touches `MX`, `TXT`, `SRV`, `NS` or existing `CAA` records — that is how mail and
  domain verification keep working
- optionally (`repointStale`, on by default) moves any other `A` record whose content is
  one of the addresses the apex used to resolve to. That is what makes offering to
  repoint `mail`/`ftp`/`webmail` a fact rather than a guess. The proxy setting on those
  records is preserved, because mail hostnames must not be proxied.

Every change carries an `action` (`create` / `update` / `delete` / `unchanged`), a `was`
value where one applies, and a `reason` written for the person approving it.

`dns.previewPointDomain` and `dns.pointDomainHere` call the **same** `planFor` helper.
What the user is shown before committing has to be produced by the code that then runs,
or the preview describes a different operation.

## Certificates

The same token drives the DNS-01 ACME challenge, so certificates are issued and renewed
without opening port 80 or waiting on HTTP propagation.

`syncCaddyEnvironment` writes the tokens into Caddy's environment, then the config is
applied. The order matters: the generated config refers to each token by environment
variable, so the variable has to exist before a config mentioning it is loaded. Reversed,
Caddy resolves the token to an empty string and fails every certificate request with an
authentication error that points at Cloudflare rather than at us.

If the web server is not installed yet, `applyTokens` deliberately returns
"Certificates will start being issued once the web server is installed" rather than the
lower-level "could not reach the web server", because only one of the two says what to do
next.

## Router surface

| Procedure | Notes |
| --- | --- |
| `dns.status` | Whether Cloudflare can be used, and with whose token |
| `dns.connect` / `dns.disconnect` | Store or clear a token, site-scoped or shared |
| `dns.zones` / `dns.records` | Read-only views |
| `dns.upsertRecord` / `dns.deleteRecord` | Direct record editing |
| `dns.previewPointDomain` | The plan, with no side effects |
| `dns.pointDomainHere` | Applies that plan, then syncs Caddy |
