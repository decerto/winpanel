# WinPanel

A self-hosted control panel for running websites, apps and email on **Windows Server 2025**.

It replaces the Plesk/cPanel workflow on Windows without using IIS: your Node and .NET
apps run as ordinary Windows Services on loopback ports, and **Caddy** sits in front
handling HTTPS, domains and traffic.

You reach the panel at **`https://<your-server-ip>:8443`** — no domain required.

---

## Why not IIS?

`iisnode`, the usual way of running Node under IIS, has not shipped a release in nine
years and still lists Windows Server 2012 as a prerequisite. Rather than build on that,
WinPanel runs each app as a supervised Windows Service and puts Caddy in front of them.

A practical consequence: **you never need a `web.config`.** That file is an IIS
artifact. The equivalent configuration here is generated for you — see
[Site configuration](#site-configuration) below.

---

## What it does

| Area | Capability |
| --- | --- |
| **Websites** | Deploy from Git or a zip upload, zero-downtime releases, one-click rollback |
| **HTTPS** | Free certificates, renewed automatically, using the DNS challenge |
| **DNS** | Manage records through Cloudflare, including the proxy toggle |
| **Email** | Self-hosted mailboxes you can use from Outlook |
| **Files** | Browse, upload, edit and download each site's files from the browser |
| **Server** | Detects and fixes the Windows settings that break Node hosting |

---

## Requirements

- Windows Server 2025 (or Windows Server 2022)
- Administrator access
- A Cloudflare account, if you want managed DNS and automatic certificates

Nothing else needs to be installed first. The installer bundles its own Node runtime,
and the panel downloads everything else itself.

---

## Installing

1. Download `WinPanel-Setup-x64.exe` onto the server.
2. Run it. It creates the folders, registers the service, opens the firewall port and
   generates a certificate.
3. The final screen shows your panel URL and a **one-time setup code**.
4. Open the URL, enter the setup code, and create your account.

Your browser will warn about the certificate the first time. That is expected: the
panel uses a self-signed certificate because it is reached by IP address rather than a
domain name. The panel shows you the certificate's fingerprint so you can confirm you
are trusting the right one.

---

## Repository layout

```
apps/
  agent/          The service that runs on the server: API, jobs, deployments
  panel/          The Vue 3 web interface
packages/
  shared/         Types and validation shared by both, defined once
```

### Key modules in `apps/agent`

| Path | Responsibility |
| --- | --- |
| `process/run-command.ts` | The only place a program may be launched |
| `files/path-containment.ts` | Keeps file operations inside a site's folder |
| `security/vault.ts` | Encrypts stored secrets |
| `checks/` | The status checks and their fixes |
| `caddy/` | Generates and applies web server configuration |
| `detect/` | Works out how to build a project |
| `jobs/queue.ts` | Runs deployments and other long tasks |

---

## Site configuration

Each site gets a `winpanel.json` describing how to build and run it. The panel works
this out by looking at your project and asks you to confirm; you can commit the file so
later deploys need no setup at all.

A repository with a `frontend/` and a `backend/`, where the frontend builds into the
backend and the backend serves it, is detected automatically and produces:

```json
{
  "runtime": "node",
  "packageManager": "pnpm",
  "steps": [
    { "name": "Install frontend packages", "cwd": "frontend", "command": "pnpm", "args": ["install"] },
    { "name": "Build the frontend",        "cwd": "frontend", "command": "pnpm", "args": ["run", "build"] },
    { "name": "Install backend packages",  "cwd": "backend",  "command": "pnpm", "args": ["install", "--prod"] }
  ],
  "app": { "cwd": "backend", "portEnvVar": "PORT", "healthCheckPath": "/" },
  "spaFallback": false
}
```

`command` is restricted to a known set of tools (`npm`, `pnpm`, `yarn`, `bun`, `node`,
`npx`, `dotnet`). Anything custom belongs in a `package.json` script, which those tools
then run — this file is read from your repository, so it is treated as untrusted input.

---

## Ports

| Port | Used by | Reachable from |
| --- | --- | --- |
| 8443 | The control panel | Anywhere |
| 80, 443 | Your websites | Anywhere |
| 25, 465, 587, 993 | Email | Anywhere |
| 2019 | Web server admin | This machine only |
| 8080 | Mail server admin | This machine only |
| 3001+ | Your apps | This machine only |

Port 8443 is permanently reserved, so a site can never be given it.

---

## Development

```bash
pnpm install
pnpm test          # run all tests
pnpm typecheck     # type-check every package
pnpm build         # build everything
```

The agent stores its data under `C:\WinPanel` and sites under `C:\Sites`. During
development set `WINPANEL_ROOT` and `WINPANEL_SITES_ROOT` to keep everything in a
scratch folder instead.

### Testing conventions

Security-critical code is tested adversarially rather than only for the happy path.
`test/path-containment.test.ts` creates a real directory junction pointing outside the
site folder and asserts the read is refused; `test/components.test.ts` serves a
tampered download and asserts nothing is left on disk. New code touching paths,
process launching, or downloads is expected to add tests in the same style.
