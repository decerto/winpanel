# Architecture

## The pieces

```
                         browser
                            │  https://<server-ip>:8443
                            ▼
┌──────────────────────────────────────────────────────────┐
│ apps/agent  (Fastify + tRPC, one Windows Service)        │
│   serves the built panel, the API, and runs the jobs     │
└───┬───────────────┬──────────────────┬───────────────────┘
    │ admin API     │ JMAP             │ SCM / WinSW
    ▼               ▼                  ▼
  Caddy          Stalwart        Your sites' apps
  :80 :443       :25 :465        :3001, :3003, …
  :2019 (local)  :587 :993 :995  (loopback only)
```

- **`apps/agent`** is the only thing with privileges. It owns the database, the vault,
  the job queue, and every call out to Windows.
- **`apps/panel`** is a static Vue 3 bundle. In production the agent serves it; in
  development Vite serves it and proxies `/api` to the agent.
- **`packages/shared`** holds the zod schemas both sides validate against, so a rule is
  written once and enforced on both ends.
- **Caddy** terminates TLS and routes hostnames to sites. The panel never edits a Caddy
  file by hand: it builds a whole JSON config and POSTs it to Caddy's admin API on
  `127.0.0.1:2019`.
- **Stalwart** is the mail server, managed only over JMAP on `127.0.0.1:8080`.

## Composition root

`apps/agent/src/app-context.ts` constructs everything once and passes it explicitly.
There are no module-level singletons, which is what lets a test build a complete,
isolated instance against a temporary directory.

```ts
const app = await createAppContext({ databasePath, vaultKeyPath, setupTokenPath });
```

`AppContext` carries `db`, `vault`, `auth`, `jobs`, `caddy`, `routing`, `services`,
`sites` and `traffic`.

## Modules in `apps/agent/src`

| Path | Responsibility |
| --- | --- |
| `api/` | tRPC routers; the whole HTTP surface except static files |
| `process/run-command.ts` | The only place a program may be launched |
| `files/path-containment.ts` | Keeps file operations inside a site's folder |
| `security/vault.ts` | Encrypts stored secrets (Cloudflare tokens, deploy keys, mail credentials) |
| `checks/` | The status checks on the Server health page, and their fixes |
| `caddy/config-builder.ts` | Turns the database's view of sites into a Caddy JSON config |
| `caddy/reconciler.ts` | Pushes that config into Caddy and retries while it is starting |
| `detect/` | Works out how to build a project, producing `winpanel.json` |
| `jobs/queue.ts` | Runs deployments, installs and other long tasks |
| `sites/` | Site lifecycle, deployments, port allocation, command running |
| `traffic/` | Reads Caddy's access logs into hourly per-site counters |
| `mail/` | Stalwart client, readiness probes, certificate sync |
| `dns/` | Cloudflare client and the record planner |
| `windows/` | Services (WinSW), firewall, stray-process watchdog |
| `components/` | Downloading and installing Caddy, Git, Stalwart, Node |
| `bootstrap/` | First-run setup: folders, firewall rules, certificate, setup token |

## Data

SQLite through Drizzle, at `<root>/data/panel.db`. Migrations live in
`apps/agent/drizzle/` and are applied at startup, so a new build of the agent upgrades
its own database.

Secrets are never stored in the database in plain text. `SecretVault` encrypts them with
a key file held outside the database, and the browser is never sent a decrypted secret —
API responses carry the *effects* of a token (zones, records, status), not the token.

## Routing and websites

`CaddyReconciler` is the boundary between "what the panel believes" and "what is being
served". It:

1. reads every enabled site and its domains from the database,
2. builds one complete Caddy JSON config, including the per-site access loggers and the
   `preview_<slug>` servers that make `http://<ip>:7000+` work,
3. POSTs it to Caddy's admin API, and
4. retries while Caddy is still starting — but not a config Caddy actively rejected.

Caddy runs with `--resume`, so a config the panel loaded survives a service restart.

## Processes

Node and .NET sites run as Windows Services through WinSW. Each site gets two ports
(blue/green): a deploy starts the new release on the standby port, health-checks it, and
only then repoints Caddy. A failed build or a failed start leaves the live site
untouched.

The pair is allocated once, when the site is created, and reused for the life of the
site — deploys alternate between the two numbers rather than taking new ones. Static
sites get no pair at all, because Caddy serves them from disk. Allocation scans from
`3001` upward and takes the first free numbers, so anything a deleted site gave back is
reused before the range grows; `PortAllocator.reclaimStalePorts()` runs at startup to
return rows that outlived their site. If a new site still starts higher than expected,
the usual cause is Windows having reserved a block for Hyper-V, WSL or Docker — the
`server.website-port-ranges` health check reports exactly which numbers those are.

`windows/service-watchdog.ts` exists because a WinSW wrapper killed without a clean stop
(sleep/wake is the usual cause) orphans its child. An orphaned `caddy.exe` keeps
`:80`/`:443` bound and every restart then fails. The watchdog kills the stray and starts
the service — but only when a stopped service's ports are held by a process matching its
own image, so a deliberate stop is left alone.

## Traffic

Caddy writes a JSON access log per site. `traffic/collector.ts` sweeps every 60 seconds
with a byte cursor per file, folds requests into hourly rows in `site_traffic`, and
prunes anything older than the retention window. The panel reads it through
`sites.traffic`, which is scoped to the site so ownership is enforced automatically.
