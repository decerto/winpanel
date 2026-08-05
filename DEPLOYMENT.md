# Deploying WinPanel

How to go from a fresh OVH Windows Server 2025 box to your websites running with HTTPS.

Read the [Before you start](#before-you-start) section first — two of the steps have to be
requested from OVH and can take a day or two, so it's worth starting them early.

---

## Before you start

Have these ready:

| What | Where to get it | Needed for |
| --- | --- | --- |
| Administrator access to the server | OVH control panel | Everything |
| A Cloudflare account with your domains added | [dash.cloudflare.com](https://dash.cloudflare.com) | DNS and HTTPS certificates |
| A Cloudflare API token | See [step 5](#5-connect-cloudflare) | DNS and HTTPS certificates |
| A GitHub access token | See [step 7](#7-add-your-first-website) | Private repositories, if you cannot use a deploy key |

**Start these two now if you want email**, because OVH takes time to action them:

1. **Ask OVH to unblock outgoing email.** Open a support request asking them to unblock
   outbound port 25 for your server's IP. They block it by default to stop spam.
2. **Set your server's reverse name.** In the OVH panel, set the reverse DNS for your
   server's IP to `mail.yourdomain.com`. Mail providers reject or spam-folder email from
   servers without one.

Neither can be done from WinPanel — it can only check them, which it does automatically
and repeatedly.

---

## 1. Build the installer

On your development machine:

```powershell
cd "F:\Repos\Windows Web Server"
pnpm install
pnpm build
pnpm --filter @winpanel/installer bundle
```

The bundle step downloads a Node runtime, verifies it against the checksums published by
nodejs.org, and stages everything the installer needs.

Then compile the installer with [Inno Setup 6](https://jrsoftware.org/isdl.php):

```powershell
iscc "packages\installer\winpanel.iss"
```

Output: `dist\WinPanel-Setup-x64.exe`.

---

## 2. Prepare the server

Connect over Remote Desktop and check the basics:

```powershell
# Should report 2025
(Get-CimInstance Win32_OperatingSystem).Caption

# Note this - it's the address you'll use to reach the panel
(Invoke-RestMethod https://api.ipify.org?format=json).ip
```

> **If this server has ever had IIS enabled**, WinPanel will detect it and offer to turn it
> off in step 4. IIS holds ports 80 and 443, and your websites cannot start while it does.
> You don't need to do anything about it now.

---

## 3. Install

Copy `WinPanel-Setup-x64.exe` to the server and run it as administrator.

It will create the folders, register the service, open the firewall, and generate a
one-time setup code. **The final page shows your panel address and setup code — write the
code down.**

Nothing else needs installing first. The installer carries its own Node runtime.

---

## 4. First sign-in

Open `https://<your-server-ip>:8443` from your own machine.

> **Your browser will warn about the certificate.** This is expected. The panel is reached
> by IP address rather than a domain name, so its certificate is self-signed. Click through
> the warning — the panel shows you the certificate fingerprint so you can confirm you're
> trusting the right one.

Then:

1. Enter the **setup code** from the installer
2. Choose a username and password (12 characters minimum)
3. **Set up two-factor authentication** — scan the QR code with your authenticator app and
   enter a code, or choose **Skip for now**
4. If you turned it on, **save the ten recovery codes** shown on the next screen

Two-factor is optional but strongly recommended. The panel sits on a public IP and controls
every site and mailbox on the machine, so without it a leaked password is enough to lose all
of it. You can turn it on, replace it or turn it off at any time from **Security**.

> **Save the recovery codes.** They are stored hashed, so that screen is the only time they
> can be read. Each one signs you in once if you lose your phone. Run out of both the
> authenticator and the codes and the only way back is console access to the server.

### Fix anything the Health page flags

The Health page runs automatically. Work through anything red or amber — most have a
**Fix** button that tells you exactly what it will change before you press it, and can be
undone afterwards.

Expect to see at least:

- **Long file names** — turn this on. Node projects create very deeply nested folders and
  installs fail confusingly without it.
- **The built-in web server (IIS)** — turn it off if present, or Caddy cannot bind to
  ports 80 and 443.

---

## 5. Connect Cloudflare

Create a token at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

- **Use template:** Edit zone DNS
- **Permissions:** `Zone → Zone → Read` **and** `Zone → DNS → Edit`
- **Zone Resources:** include the domains you want WinPanel to manage

Paste it into **Settings → Cloudflare** in the panel. It's checked immediately, so a wrong
or wrongly-scoped token fails while you're still looking at the field.

Both permissions are required: DNS edit alone isn't enough, because certificate issuance
needs to read the zone first.

Saving the token also hands it to the web server and reloads its configuration, so
certificates begin issuing straight away. If you connect Cloudflare before installing the
web server, the panel says so and applies the token when you install it.

---

## 6. Install the web server

Go to **Components** and install **Caddy**. This is what serves your websites and obtains
HTTPS certificates.

Install **Git** too, which the panel uses to fetch your code.

---

## 7. Add your first website

Start with the simplest one. **Websites → Add a website**.

### Step 1 — Your code

Paste the address of your repository — either the **https://** one or the **SSH** one. The
panel converts it to whichever form the sign-in method needs.

Then say how the server should sign in:

- **It's public** — nothing to do.
- **With a deploy key** (recommended for a private repository) — the panel makes a key
  pair, keeps the private half encrypted on the server, and shows you the public half.
  Copy it, then on GitHub open the repository's **Settings → Deploy keys → Add deploy
  key**, give it any title, paste the key, and leave **Allow write access** unticked. The
  key reads that one repository, belongs to the server rather than to a person, and never
  expires. GitLab and Bitbucket call the same thing "deploy keys" and "access keys".
- **With an access token** — for hosts or company policies that do not allow deploy keys.
  For GitHub, create one at [github.com/settings/tokens](https://github.com/settings/tokens)
  with the **`repo`** scope. It's stored encrypted on the server and never written into
  your project files. Remember that tokens expire, and deployments stop working when they
  do.

Press **Test connection** before continuing — an unreachable repository is the most common
reason a first deployment fails.

### Step 2 — What we found

The panel clones your project and works out how to build it. Check the folder roles and
build steps it shows you.

For a repository with `frontend/` and `backend/`, where the frontend builds into the
backend, you should see three steps:

1. Install frontend packages — in `frontend`
2. Build the frontend — in `frontend`
3. Install backend packages — in `backend`

…and the app running from `backend`. If that's right, continue. If the confidence warning
appears, read the steps carefully before proceeding.

### Step 3 — Web address

Enter your domain, for example `diminished-studios.com, www.diminished-studios.com`.

### Step 4 — Secrets

Add any database URLs or API keys your app reads from the environment. These are stored
encrypted and are only ever visible to your app.

Press **Create and deploy**. Watch the live log on the site page.

---

## 8. Point your domain at the server

On the site page, use **Point this domain here**. This writes the DNS records through
Cloudflare:

- an `A` record for the domain
- a `CNAME` for `www`
- a `CAA` record restricting who may issue your certificates

**Leave "Route traffic through Cloudflare" off for your first deployment.** Turn it on once
the site is confirmed working — it's much easier to diagnose a problem with one moving part
rather than two.

Certificates are obtained automatically within a minute or two of DNS resolving.

### Check it worked

```powershell
curl.exe -I https://diminished-studios.com
```

You want `HTTP/2 200` and no certificate warning.

---

## 9. Add your remaining websites

Repeat step 7 for each. Notes for specific setups:

**Nuxt (kitora.io)** — detected automatically. The panel knows Nuxt reads `NITRO_PORT`
rather than `PORT` and runs `.output/server/index.mjs`.

**A site using WebSockets (the idle game)** — detected from your `socket.io` dependency.
Caddy passes WebSocket connections through with no extra configuration.

> **If you put this site behind Cloudflare's proxy**, set socket.io's `pingInterval` below
> 100 seconds. Cloudflare closes idle WebSocket connections at around that point, and the
> disconnects look like random client faults.

**Your .NET application** — publish it, then add it as a website with type **proxy**
pointing at the port Kestrel listens on. WinPanel handles the domain and HTTPS; you keep
running the app as you do now.

---

## 10. Email (optional, last)

Only start this once **Mail → Readiness** shows outgoing email working. If OVH hasn't
actioned your unblock request yet, everything else will fail confusingly.

1. **Components → Install the mail server**
2. **Mail → Readiness**, enter your domain
3. Publish the records it lists — MX, SPF, DKIM, DMARC — through the DNS page

> **Mail records must never be proxied through Cloudflare.** WinPanel enforces this and
> will refuse to write such a record. Cloudflare's proxy only handles web traffic, so
> proxying a mail hostname silently breaks email delivery.

4. Create mailboxes, and use the connection details on the mailbox page to set up Outlook

Send a test message to [mail-tester.com](https://www.mail-tester.com) and aim for 9/10 or
better before relying on it.

---

## Deploying updates

Press **Deploy now** on the site page, or use the API from CI.

Each deployment builds into a fresh folder and starts on the **spare port**, then only
switches traffic across once the new version answers a health check. If anything fails, the
version currently serving visitors is untouched — a failed deployment is a failed
deployment, not an outage.

### Zero-click deployments

Commit the `winpanel.json` the wizard offers you. When it's present in the repository it
overrides detection, so future deployments need no decisions at all.

---

## Updating WinPanel itself

Different thing from deploying a website. Settings → **Update WinPanel**, as the owner:
upload the new setup file from your computer, give the server an `https://` link to it, or
point at a copy already on the server's disk. Running the new
`WinPanel-Setup-x64.exe` on the server by hand does the same job, and is the fallback if
the panel is too broken to update itself.

It is an upgrade in place — sites, mailboxes, certificates, users and settings are all
kept. Every service is stopped while the files are replaced and started again afterwards,
so **websites and email are offline for a minute or two**. The record is in
`C:\WinPanel\logs\winpanel-update.log`.

There is no rollback and nothing checks for new versions on your behalf. Back up the two
files listed under [What to back up](#what-to-back-up) before updating, and watch the
releases page.

---

## If something goes wrong

| Symptom | Likely cause |
| --- | --- |
| Panel unreachable | Service stopped. RDP in: `Get-Service winpanel-agent` |
| Panel not back after an update | Read `C:\WinPanel\logs\winpanel-update.log`, then `Start-Service winpanel-agent`. If that fails, run the setup file on the server by hand |
| Websites still down after an update | The panel came back alone. Settings → Background programs → **Start everything** |
| Website shows 503 | Never deployed successfully. Check the deployment log |
| Certificate not issued | Domain isn't pointing here yet, or the Cloudflare token is missing `Zone → Zone → Read` or `Zone → DNS → Edit` |
| Deployment fails installing packages | Long file names not enabled — see the Health page |
| Blank page after deploying | Build output is gitignored; the panel should build on the server |
| Email not sending | OVH block not lifted yet. Mail → Readiness re-checks automatically |

**Logs**

```powershell
Get-Content C:\WinPanel\logs\winpanel-agent.out.log -Tail 50   # the panel
Get-Content C:\Sites\<site>\logs\*.out.log -Tail 50            # a website
```

**A failed deploy** — the previous version is put back automatically. The build
that failed is left in the site's hidden `.staging` folder so it can be
inspected, and the next deploy clears it.

---

## What to back up

WinPanel doesn't yet back itself up. Until it does, copy these somewhere off the server:

| Path | Contents |
| --- | --- |
| `C:\WinPanel\data\panel.db` | Sites, users, settings, history |
| `C:\WinPanel\data\vault.key` | Encryption key for all stored secrets |
| `C:\Sites\*\shared\` | Environment files and uploads |

> `vault.key` is tied to this machine. Restoring it to a different server will not decrypt
> your secrets — you'd re-enter them instead. Back it up anyway, so a rebuild of *this*
> machine can recover.

---

## Known limitations

Being straight about what hasn't been proven:

- **The installer hasn't been run on a real Windows Server.** Its logic is tested, but
  Inno Setup packaging and service registration are unverified until you try it.
- **No live Cloudflare, certificate or mail calls have been made.** Those paths are
  unit-tested against stubs, not against the real services.
- **Backups and monitoring aren't built yet.** Handle backups manually, as above.
- **Website builds run with the panel's permissions** if the restricted account couldn't be
  created during install. The Health page will tell you.
