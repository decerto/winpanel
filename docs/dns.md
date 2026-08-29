# DNS

WinPanel manages DNS through Cloudflare only. Everything lives in
`apps/agent/src/dns/` and is exposed by `apps/agent/src/api/routers/dns.ts`.

## Tokens

A Cloudflare API token reaches the zones of the account that issued it, and nothing else.
One server routinely hosts domains belonging to different people, so a single
machine-wide token would work for exactly one account and fail silently for every other.

So tokens are held **per root website**, with no shared fallback. A subdomain inherits the
token of its direct parent:

| Scope | Stored by | Used when |
| --- | --- | --- |
| Site token | `storeSiteCloudflareToken` | A root website has connected Cloudflare |
| Parent token | `site.cloudflareToken:<parentId>` | A subdomain needs its parent's account |

`cloudflareTokenForSite` resolves the pair. Both are encrypted by `SecretVault` and never
leave the server - the API returns zones, records and status, never the token.

`requireOwnSite` in the DNS router requires a `user` account to name one of its websites.
The router also limits zone and record operations to that website's configured domains.

Older installs stored one encrypted value under `cloudflare.token`. On startup, the agent
decrypts it with that legacy key as associated data and stages it under the only root site
when there is exactly one. Multiple root sites, an existing site token, or unreadable
ciphertext are left for an administrator to resolve by reconnecting each root site. The
legacy value is retained only until the current Caddy configuration has loaded, allowing an
autosaved configuration that still refers to `CF_API_TOKEN` to start during the upgrade.

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
- never touches `MX`, `TXT`, `SRV`, `NS` or existing `CAA` records - that is how mail and
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
authentication error that points at Cloudflare rather than at us. During an upgrade, the
legacy `CF_API_TOKEN` name is kept until the new configuration has loaded, then removed.

If the web server is not installed yet, `applyTokens` deliberately returns
"Certificates will start being issued once the web server is installed" rather than the
lower-level "could not reach the web server", because only one of the two says what to do
next.

## Certificates the user supplies

`ssl.uploadCertificate` stores a certificate and key the user obtained elsewhere - almost
always a Cloudflare Origin certificate, occasionally one from a company's own authority.
The certificate goes in `site_certificates`; the private key goes in the vault under
`site.certificateKey:<siteId>`, never in the table and never back over the API.

`writeCustomCertificateFiles` rewrites `<dataDir>\certificates\<siteId>.{crt,key}` from
the database on *every* reconcile rather than once at upload, and deletes files belonging
to sites that no longer have one. Caddy needs a path, and a config pointing at a file
that is not there fails the entire load - including every other website on the machine.
Rebuilding from the database means a restored backup or a half-finished write repairs
itself.

Three things follow from that same "one bad certificate takes everything down" property:

- `parseCertificateBundle` validates at upload, not at reload: the key must match the
  certificate, it must not carry a passphrase, and it must be inside its validity window.
- The names on the certificate are intersected with the site's own domains
  (`coveredDomains`), so nobody can take a domain out of automatic management by
  uploading a certificate that claims it.
- The subjects go into `automatic_https.skip_certificates`. Caddy will not manage a name
  it already holds, but saying so explicitly is what keeps the HTTP-to-HTTPS redirect
  alive - a name that fails issuance is otherwise dropped from the server entirely.

Nothing renews these, so `notAfter` is stored and shown rather than left inside the file.
A Cloudflare Origin certificate is flagged `originOnly`, because it is trusted by
Cloudflare's edge alone: grey-clouding the record afterwards gives every visitor a
full-page browser warning.

## Router surface

| Procedure | Notes |
| --- | --- |
| `dns.status` | Whether Cloudflare can be used, and with whose token |
| `dns.connect` / `dns.disconnect` | Store or clear a root website's token |
| `dns.zones` / `dns.records` | Read-only views |
| `dns.upsertRecord` / `dns.deleteRecord` | Direct record editing |
| `dns.previewPointDomain` | The plan, with no side effects |
| `dns.pointDomainHere` | Applies that plan, then syncs Caddy |
