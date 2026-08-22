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
  Caddy          Stalwart        Your sites' apps       Game servers
  :80 :443       :25 :465        :3001, :3003, ...     TCP/UDP ports
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
- **PHP** sites run as a small pool of `php-cgi` workers, supervised by a Node script
  (`sites/php-pool.ts`) that WinSW owns; Caddy talks to the pool with its built-in
  FastCGI transport.
- **MariaDB** is the database server, on loopback only. Per-site databases and users are
  provisioned by `sites/databases.ts`; the browser-based editor is Adminer, run on a
  private loopback-only PHP server and proxied by the panel at `/db/…`
  (`api/db-browser.ts`) behind the panel's own sign-in, never on a public domain.
- **Game servers** are stateful resources separate from `sites`. Provider adapters acquire
  Minecraft or allowlisted Steam files, register one WinSW service per instance, expose a
  contained data folder to the file manager, and apply typed public firewall bindings.

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
| `sites/` | Site lifecycle, deployments, port allocation, command running; also `php-pool.ts` (the PHP worker supervisor), `databases.ts` (MariaDB provisioning) and `wordpress.ts` (the WordPress install job) |
| `game-servers/` | Provider catalogue, installation jobs, lifecycle metadata, data files and provider-specific Windows services |
| `traffic/` | Reads Caddy's access logs into hourly per-site counters |
| `mail/` | Stalwart client, readiness probes, certificate sync |
| `dns/` | Cloudflare client and the record planner |
| `windows/` | Services (WinSW), firewall, and recovery from orphaned processes |
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
(sleep/wake is the usual cause) orphans its child. See
[Orphaned processes](#orphaned-processes) below.

## Orphaned processes

A WinSW wrapper that dies without running its stop path leaves the process below it
running. Windows then reports the service as **stopped** while the program is still
there: still bound to its port, still holding its files open. Sleep/wake is the usual
cause; ending the wrapper in Task Manager does it too.

For Caddy that is a plain outage — `:80` and `:443` stay bound, so every restart fails to
bind and the service flaps on the failure-action interval until somebody intervenes.

For a website it is worse, because nothing looks wrong from outside:

- Caddy proxies to `127.0.0.1:<port>` and does not care which process answers, so the
  site stays up;
- the panel reports the service stopped, because Windows says it is;
- every Start appears to work and is gone a second later, `EADDRINUSE` in the log;
- a deploy's health check asks whether *something* answers on the port, so the orphan
  answers on the new release's behalf. The deploy is declared healthy, Caddy goes on
  proxying to the old process, and the code being served is however many releases old.

### Two rules

Everything below obeys both, and they are what keep this from being dangerous:

1. **A stopped service with no stray is left alone.** Somebody stopped it deliberately,
   and a control panel that restarts services behind your back is worse than one that
   does nothing.
2. **Only a process holding one of the service's own ports *and* running one of its own
   executables is ended.** Anything else on the port is named in the error and left
   running. The panel allocated the port; it does not own the machine.

`windows/watched-services.ts` is what makes the second rule checkable: it maps a service
id to the ports and executables it owns. The components are a fixed list; websites are
read from the database every time, because the panel allocated their ports and so knows
them exactly — guessing a port out of the app's own environment would eventually match
something like `SMTP_PORT` and aim a kill at the wrong process.

### Where recovery happens

| Moment | What it does |
| --- | --- |
| Every 60 seconds | `ServiceWatchdog` sweeps every component and website, clears strays under a stopped service, and starts it |
| Start, Restart | Clears the port and tries once more, but only after a real failure and only if something was actually cleared |
| Stop, Stop everything | Ends the leftover after the service reports stopped, so "stopped" means the program is gone and its files are released |
| Deploy | `claimPort` frees the port *before* the new process starts, so the health check cannot be satisfied by an impostor |
| Site deleted, component removed | The service's process is ended before the service is unregistered, which Windows will not do while it is running |
| Update, uninstall | `stop-all` visits services already reporting stopped — the state an orphan hides behind — and ends what it finds |
| Panel start-up | `listenClearingStrays` clears a previous copy of the panel off the panel's own port before giving up on `EADDRINUSE` |

### Deliberate gaps

- **The panel is never watched.** The watchdog runs inside the panel, so the only process
  it could find on the panel's port while that service reads as stopped is itself. It is
  unblockable — stopping it before an update has to release `bin\node\node.exe` — but it
  is not in the swept list.
- **Sites mid-deploy are skipped.** A deploy stops the service on purpose and swaps the
  folder underneath it. Anything else starting it in the middle is fighting the deploy
  over the same files, and the deploy is the one that knows what it is doing.
- **Foreign programs are never ended**, only reported. Quietly proxying a customer's
  website to a stranger's process is a worse outcome than a start that stops and explains
  itself.

### Where the code is

| Path | Responsibility |
| --- | --- |
| `windows/stray-processes.ts` | `netstat` / `tasklist` / `taskkill`, and the split into "ours" and "foreign" |
| `windows/watched-services.ts` | Which ports and executables each service owns |
| `windows/service-watchdog.ts` | The 60-second sweep |
| `windows/service-manager.ts` | `ServiceRecovery`, applied inside start, stop, restart and uninstall |
| `windows/panel-services.ts` | The `sc.exe` view of every `winpanel-*` service, used by the Settings page and the installer |

Two details worth knowing before editing any of it. `netstat` output is matched on the
port and a zero foreign port rather than on the word `LISTENING`, and service state is
read from `sc.exe`'s numeric `STATE` code rather than the word beside it — both are
translated strings on a server installed in another language, and searching the whole
output for `RUNNING` also matches a site whose slug contains it.

## Traffic

Caddy writes a JSON access log per site. `traffic/collector.ts` sweeps every 60 seconds
with a byte cursor per file, folds requests into hourly rows in `site_traffic`, and
prunes anything older than the retention window. The panel reads it through
`sites.traffic`, which is scoped to the site so ownership is enforced automatically.
