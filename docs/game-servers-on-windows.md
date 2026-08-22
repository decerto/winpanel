---
title: How to host a game server on Windows
description: >-
  Run Minecraft, Palworld, Project Zomboid and other Steam dedicated game servers on
  Windows Server 2022/2025 or Windows 11 without IIS - each server a supervised Windows
  Service with its own ports, firewall rules, file manager and customer login, managed by
  WinPanel.
image: /winpanel/screenshots/game-servers-library.png
---

# Game servers on Windows

WinPanel can host supported dedicated game servers as Windows Services. Game servers are separate from Websites: they do not use Caddy, web domains, blue/green deployments, or website traffic logs.

## Setup

1. Open **Settings** and enable **Game servers**.
2. Install **SteamCMD** from the Programs section if you want a Steam provider.
3. For Steam games that require ownership, enter the Steam account in the Game servers section. Credentials are encrypted in WinPanel and never shown back to the browser.
4. For Minecraft Java, install the supported 64-bit Java runtime from the Game servers section, then refresh Settings.
5. Open **Game Servers**, choose a supported provider, accept its EULA and publisher terms, and create the server.
6. Select **Install server**. WinPanel downloads the provider files, verifies what it can, creates the data folder, registers a Windows Service, and applies the server's public firewall rules.
7. Start the server from its detail page.

WinPanel never downloads or redistributes game content during installation setup. SteamCMD and Minecraft downloads remain subject to Valve, Mojang/Microsoft, and each game's licence terms.

## Supported providers

### Minecraft Java Edition

WinPanel reads Mojang's official version metadata, downloads the selected server JAR, verifies Mojang's SHA-1, writes `eula.txt` and `server.properties`, and runs the server through Java and WinSW.

The default game port is TCP `25565`, unless allocation moves it because another service already uses that port. The world, configuration, and logs are in the server's data folder. The JAR is kept in the provider-managed server folder.

### Minecraft Bedrock Edition

Bedrock uses the official Windows Dedicated Server archive and does not need Java. Its default game port is UDP `19132`. Bedrock and Java are different providers: their configuration, runtime, port protocol, and executable are not interchangeable.

The Bedrock distribution is publisher-controlled and may change. WinPanel checks the archive contents and requires `bedrock_server.exe` before registering the service.

### Steam: Palworld Dedicated Server

The first Steam catalog entry is Palworld Dedicated Server. WinPanel calls SteamCMD with a fixed App ID and fixed arguments:

```text
+force_install_dir <server-folder>
+login anonymous
+app_update 2394010 validate
+quit
```

Customers cannot enter arbitrary App IDs, executables, or shell commands. The expected executable is `PalServer.exe`. The default public bindings are UDP `8211` for game traffic and UDP `27015` for queries. A loopback-only RCON binding is reserved for future controlled administration.

SteamCMD may update itself from Valve when it first runs. SteamCMD's public bootstrap archive is mutable and does not have a stable publisher checksum, so WinPanel checks the archive payload and the expected executable rather than claiming a fixed hash that would become stale.

### Steam: Nomad

Nomad is supported from Steam App ID `378370`. WinPanel downloads the game files through SteamCMD, verifies that `Nomad.exe` exists, allocates the game port, and registers the equivalent of:

```text
Nomad.exe -port <allocated-port> -batchmode -nographics
```

Nomad is an owned game download rather than an anonymous dedicated-server depot, so configure the Steam account in Settings first. Steam Guard is handled during install: the job log tells you to approve the sign-in in the Steam mobile app, and the install continues once you approve it. If the account asks for a typed code instead of mobile approval, sign in once on the server itself by running `steamcmd.exe` in the WinPanel bin folder — SteamCMD caches that session, and later installs continue without prompting.

Nomad normally creates its editable server data under `Nomad Server` on first launch. WinPanel bootstraps that folder before registering the service and maps it into the Files view, so the main configuration is immediately available at `Config/config.json`. The panel preserves the JSON file and its settings during reinstall; deleting the server remains destructive.

### Steam: Project Zomboid Dedicated Server

Zomboid is supported from Steam App ID `380870` and downloads anonymously — no Steam account is needed. WinPanel runs the server directly through the bundled `jre64/bin/java.exe` rather than the `StartServer64.bat` wrapper, because a Windows service cannot answer the batch file's first-run console prompt.

WinPanel creates a managed profile inside the install folder and starts the server with `-servername <slug>`. The server settings file — `<slug>.ini` — lives in the profile, which is mapped into the Files view so it can be edited there. The default bindings are UDP `16261` (game) and UDP `16262` (direct connection), allocated and firewalled like every other public port. On first start, the server creates its admin account using a password WinPanel generates and stores in the vault; it is not printed in logs.

The heap is sized from the memory actually free on the machine at install time (between 1 GB and 4 GB), rather than the upstream launcher’s fixed 4 GB default — a small VM otherwise fails to start at all with an out-of-memory error. Because the heap is baked into the Windows service definition, resizing it later means deleting and recreating the server.

## Ownership and access

An administrator can give a customer:

- a provider-specific creation limit, such as one Minecraft server;
- an any-supported-provider limit, such as one server of any supported game; or
- explicit access to an existing server.

Customers see only servers they own or have been assigned. File, lifecycle, install, reinstall, and delete operations are checked on the server. Assignment grants control but does not grant permission to delete somebody else's server.

Steam credentials in Settings are a server-wide **administrator** installation credential, not a customer credential. They are encrypted in the vault, never returned by the API, and are not available to role-`user` accounts. A customer cannot trigger a Nomad install or reinstall using the administrator's Steam account; an administrator must perform that acquisition first. After installation, the customer can use the permissions granted for that server, including its files and lifecycle controls.

For isolation, use a dedicated Steam account owned by the hosting operator rather than a personal account. SteamCMD still places credentials in the command invocation while it logs in, so local Windows administrators with process-inspection rights should be treated as trusted. Remote WinPanel customers do not receive the password or SteamCMD output containing it.

## Files and reinstall

The **Files** view operates on the server's data folder. It supports browsing, editing, folders, deletion, uploads, downloads, quotas, and containment checks. Provider executables are kept outside this editable data root.

When the catalog names a `configFile` for the game, the server page also shows a **Server config** button in the Files header that opens that file straight into the editor — Nomad's `Config/config.json`, Minecraft Java's `server.properties`, Zomboid's `<slug>.ini`. Providers whose settings live outside the data folder, or that have no single obvious settings file, do not show the button; browse the file manager instead.

Minecraft Java exposes a live service log and an authenticated RCON console on its detail page. Commands are sent only to the loopback RCON binding and the password remains in the vault. Providers without a tested console protocol show output status but do not expose a fake shell.

**Reinstall files** reacquires provider-managed files and preserves the data folder by default. It is not a backup and it cannot recover data that was deleted from the data folder. Deleting a server is explicit and removes its service, files, database record, allocated ports, and WinPanel firewall rules.

## Updates and branches

Every installed Steam server shows an **Update** action on its detail page. Updating reruns the provider's download — `app_update <id> validate` — which pulls the latest build of whatever branch the server is on. A running server is stopped first, the files are replaced, and it starts again on the new build; the job log says when each happens. WinPanel keeps one job log per operation, so a failed update says exactly what Steam reported and leaves the server stopped rather than half-updated.

The **Updates** section also carries a branch field. Leave it blank for the default branch, or enter a Steam beta branch name such as `legacy41` and press **Save branch**. The next Update then pulls that branch instead. Changing the branch alone does nothing to the files on disk; the update that follows is what downloads the new build, which is why the two are separate actions rather than one hidden save.

Some games publish no public branch list, and Steam will reject a name that does not exist for that app. If an update on a new branch fails, the error in the job log is the answer — revert to blank and update again to return to the default build.

## Networking

WinPanel allocates ports across its shared safety domain and checks reserved Windows ports. Public bindings receive instance-owned Windows Firewall rules named for the server. Loopback bindings do not receive public allow rules.

A server can still be unreachable from the internet when:

- the Windows Firewall rule could not be created because the panel lacks administrator rights;
- the machine is behind a router or NAT and the router does not forward the port;
- the provider uses a protocol or query port that is not configured in the catalog; or
- the game is still starting or is stopped.

Router port forwarding and upstream security groups remain outside WinPanel.

## Game catalog files

The library is data, not code. Each supported game is a JSON file in `game-servers/catalogue/` in the repository, and the panel reads the same folder from its data directory at runtime. Adding a game means adding a file, not editing TypeScript.

A file dropped into the panel's data folder wins over a built-in with the same ID, so a local tweak does not need a fork. The schema is validated at startup; an invalid file is skipped and logged rather than loaded. The panel reports how many configs it has loaded on the library page.

### Writing a config

The fields a config carries:

| Field | What it does |
| --- | --- |
| `id` | Unique catalog ID. Lowercase, stable, used to merge overrides. |
| `provider` | `minecraft-java`, `minecraft-bedrock`, or `steam`. |
| `name` / `description` | Shown in the library and on the server card. |
| `status` | `ready` or `planned`. Only `ready` can be created. |
| `genre` / `art` | Genre label and local fallback art theme. |
| `requiresEula` | Whether the creation form demands an EULA tick. |
| `steamRequiresOwnership` | Whether the game needs a Steam account that owns it. |
| `steamAppId` / `steamArtAppId` | The install ID and the retail ID used for library artwork. |
| `executable` / `launchExecutable` | The file that proves a download completed, and the binary the service actually runs. |
| `launchArgs` | Fixed arguments; `{gamePort}`, `{slug}`, `{classpath}`, and `{heapMb}` are expanded at install time. |
| `downloadUrl` / `downloadSha256` | Official download and optional checksum for non-Steam providers. |
| `console` | `rcon`, `stdin`, or `none`. `none` until a protocol is proven. |
| `dataDirectory` | The provider's data folder, mapped into the Files view. |
| `ports` | Named bindings with `protocol`, `purpose`, `visibility`, and a default `port`. |

### Ports are defaults, not assignments

The `port` field in a config is the *starting point*, not a guarantee. WinPanel allocates from the shared safety domain, so two people can run the same game and each gets a free port. The config tells the panel where to begin looking; the allocator walks from there. If the default is taken by a website, another game server, or Windows, the next free one is used instead. The actual binding is shown on the server's Connection panel.

Some games let you set player limits in launch arguments; others, like Nomad, keep them in the config file. A config can describe either shape, because `launchArgs` and `dataDirectory` are separate. The panel does not enforce a universal max-players field — that is provider-specific, and pretending otherwise would produce a setting that does nothing on half the catalog.

### An example

A minimal Steam config for a game that downloads anonymously:

```json
{
  "id": "my-game-dedicated",
  "provider": "steam",
  "name": "My Game",
  "description": "My Game dedicated server for Windows.",
  "status": "ready",
  "genre": "Survival",
  "art": "steel",
  "requiresEula": true,
  "steamRequiresOwnership": false,
  "steamAppId": 12345,
  "executable": "MyServer.exe",
  "launchArgs": ["-port", "{gamePort}", "-batchmode"],
  "console": "none",
  "ports": [
    { "name": "game", "protocol": "udp", "purpose": "game", "visibility": "public", "port": 25000 }
  ]
}
```

The panel validates the file at startup, and the game appears in the library the next time it loads. A bad file is skipped with its name in the log, so a typo never takes the catalog down.

## Updates and limitations

Reinstalling or installing again runs the provider's acquisition path. A normal update workflow will be exposed per provider once its data migration and graceful-stop behavior are tested.

The library shows a small roadmap of popular games while their adapters are tested. Planned titles cannot be created yet. The first release does not support arbitrary Steam App IDs, arbitrary launch commands, Linux servers, generic mod-loader installation, scheduled backups, or raw game traffic analytics. A game is promoted to Ready only after its Windows executable, ports, launch arguments, health behavior, EULA flow, console behavior, and reinstall behavior are tested.
