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

Everything below happens once, from a browser. There is no command line involved, and
nothing on this page asks you to edit a file by hand before your first server is up.

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

WinPanel creates a managed profile inside the install folder and points the server at it with `-cachedir`, so everything the game writes — settings, saves, logs — stays with the install instead of landing in the service account's `%USERPROFILE%\Zomboid`. The server reads its settings from `<cachedir>\Server\<servername>.ini`, so the settings file is at `Server/<slug>.ini` inside the profile, which is mapped into the Files view and reachable from the **Server config** button.

The default bindings are UDP `16261` (`DefaultPort`, the port players connect to) and UDP `16262` (`UDPPort`, direct connection), allocated and firewalled like every other public port and also passed as `-port`/`-udpport` so the service cannot drift from the allocation. The seeded profile sets `Public=true` and `PublicName` to the server's display name; without those the server never announces itself and cannot be found in the in-game browser however open the ports are.

The first start creates the `admin` account with a password WinPanel generates and stores in the vault, supplied through `-adminpassword` — the batch file would otherwise block forever on a console prompt no service can answer. Reinstalling reuses the stored password rather than rotating it, and refreshes the service's launch arguments, which is the repair path for a server registered before these arguments were correct.

None of the above is Zomboid-specific code. The bundled JVM, the classpath, the heap, the generated password and the CRLF settings file are all fields in [its catalog file](https://github.com/decerto/winpanel/blob/main/game-servers/catalogue/zomboid.json) — which is what any other game with the same awkward shape can copy.

The heap is sized from the memory actually free on the machine at install time (between 1 GB and 4 GB), rather than the upstream launcher’s fixed 4 GB default — a small VM otherwise fails to start at all with an out-of-memory error. Because the heap is baked into the Windows service definition, resizing it later means deleting and recreating the server.

## Ownership and access

An administrator can give a customer:

- a provider-specific creation limit, such as one Minecraft server;
- an any-supported-provider limit, such as one server of any supported game; or
- explicit access to an existing server.

Customers see only servers they own or have been assigned. File, lifecycle, install, reinstall, and delete operations are checked on the server. Assignment grants control but does not grant permission to delete somebody else's server.

Steam credentials in Settings are a server-wide **administrator** installation credential, not a customer credential. They are encrypted in the vault, never returned by the API, and are not available to role-`user` accounts. A customer cannot trigger a Nomad install or reinstall using the administrator's Steam account; an administrator must perform that acquisition first. After installation, the customer can use the permissions granted for that server, including its files and lifecycle controls.

Customers can read the job log for their own server, because that is where a failed download explains itself — and SteamCMD announces the account it is signing in as in its first line of output. Every line SteamCMD produces is therefore scrubbed before it reaches a log or an error message: the account name is replaced with "the server Steam account", the password is masked in case anything ever echoes it, and the email address in a Steam Guard notice is removed. Steam's own error is kept intact, so "No subscription" or "Disk write failure" still reaches the person waiting on it. The same scrubbing covers the install, update and Workshop paths.

For isolation, use a dedicated Steam account owned by the hosting operator rather than a personal account. SteamCMD still places credentials in the command invocation while it logs in, so local Windows administrators with process-inspection rights should be treated as trusted. Remote WinPanel customers receive neither the account name, the password, nor any SteamCMD output containing them.

## Files and reinstall

The **Files** tab operates on the server's data folder. It supports browsing, editing, folders, deletion, uploads, downloads, quotas, and containment checks. Provider executables are kept outside this editable data root.

Opening any text file gives you the panel's editor: a full-window pane with line numbers, find and replace across the whole file (with match counts, case sensitivity and regular expressions), go-to-line, block indent, and Ctrl+S to save. Config files for these games run to hundreds or thousands of lines — Project Zomboid's is roughly a thousand — so this is a real editor rather than a text box.

When the catalog names a `configFile` for the game, the **Overview** tab shows an **Edit server config** button, and the Files header shows the same shortcut, which opens that file straight into the editor — Nomad's `Config/config.json`, Minecraft Java's `server.properties`, Zomboid's `Server/<slug>.ini`. Providers whose settings live outside the data folder, or that have no single obvious settings file, do not show the button; browse the file manager instead.

Minecraft Java exposes a live service log and an authenticated RCON console on its **Console** tab. Commands are sent only to the loopback RCON binding and the password remains in the vault. Providers without a tested console protocol show output status but do not expose a fake shell.

**Reinstall files** reacquires provider-managed files and preserves the data folder by default. It is not a backup and it cannot recover data that was deleted from the data folder. Deleting a server is explicit and removes its service, files, database record, allocated ports, and WinPanel firewall rules.

## Steam Workshop mods

Games whose catalog entry declares a `workshop` block get a **Workshop** tab on the server page. It answers the awkward question about mods on a rented server: whose Steam account does the downloading?

The answer is nobody's but the machine's. The customer picks a mod; the panel downloads it with the operator's own SteamCMD, in a job with a live log. Customers never sign in to Steam, never see the operator's account, and never touch the files by hand.

### Browsing

Add a **Steam Web API key** in Settings and the tab becomes a browser: search the game's Workshop, sort by *Popular this week*, *Most subscribed*, *Recently updated* or *Newest*, filter by clicking a tag on any result, and press **Add to server**. Items already on the server show as **Added** rather than offering to add them twice. Thumbnails are fetched by the agent and served from the panel, so a page of mods does not become a page of requests to Valve's CDN carrying every customer's address.

The key is optional and is not a sign-in. Valve issues one free to any Steam account at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey); it reads public Workshop listings and cannot sign in, buy, or change anything. It is stored encrypted in the vault, never returned by the API, and used only by the agent — searches are performed on the server and the panel receives results, not credentials. Identical searches are cached for a minute, because one key serves every customer on the machine.

Without a key nothing is lost: **Open on Steam** opens Valve's own Workshop page, and pasting an item's address into the **Workshop link or id** field does the same job. Several links can be pasted at once, separated by spaces or commas, which is how a mod list moves across from another host. Either way the panel asks Steam what the item is — the title, the size, and whether it is even for the right game — before downloading anything.

### What happens after

Once an item is downloaded, its mod folders are copied to wherever the game looks for them, and the game's settings file has its mod list rewritten — for Project Zomboid, `WorkshopItems=` and `Mods=` in `Server/<slug>.ini`. No other line in that file is touched. **Update** re-downloads an item, which is how a mod gets its latest version; **Update all** does the lot. Removing an item deletes its files and takes it back out of the mod list. Restart the server for any of it to take effect.

Most Workshop content downloads anonymously and needs no account at all. Where Steam refuses, the panel falls back to the Steam account configured in Settings — the same one that installed the game files — and the tab says so plainly if neither is available. That account's name never appears in the log the customer is watching; see [Ownership and access](#ownership-and-access).

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

A file dropped into the panel's data folder wins over a built-in with the same ID, so a local tweak does not need a fork. The shipped configs are refreshed on each update unless you have edited them, which is how a correction reaches an install that already has the old copy. The schema is validated at startup; an invalid file is skipped and logged rather than loaded. The panel reports how many configs it has loaded on the library page.

### Writing a config

The fields a config carries:

| Field | What it does |
| --- | --- |
| `id` | Unique catalog ID. Lowercase, stable, used to merge overrides. |
| `provider` | How the files are fetched: `steam`, `download`, or `minecraft-java`. |
| `name` / `description` | Shown in the library and on the server card. |
| `status` | `ready` or `planned`. Only `ready` can be created. |
| `genre` / `art` | Genre label and local fallback art theme. |
| `requiresEula` | Whether the creation form demands an EULA tick. |
| `steamRequiresOwnership` | Whether the game needs a Steam account that owns it. |
| `steamAppId` / `steamArtAppId` | The install ID and the retail ID used for library artwork. |
| `executable` / `launchExecutable` | The file that proves a download completed, and the binary the service actually runs. |
| `runtime` | `native`, or `java` to use the panel's own Java runtime. |
| `launchArgs` | The service's arguments, with placeholders expanded at install time. |
| `workingDirectory` | `install`, `data`, or `executable`. |
| `seedFiles` | Config files written before the first start, so the game learns its ports and passwords. |
| `secrets` | Passwords the panel generates, vaults, and expands as `{secret:name}`. |
| `heap` | Heap floor, cap and reserve for JVM games; enables `{heapMb}`. |
| `classpathDirectory` | Folder of jars joined into `{classpath}`. |
| `downloadUrl` / `downloadSha256` | Official download and optional checksum for non-Steam providers. |
| `console` | `rcon` (log tail plus commands), `logs` (read-only tail), or `none`. |
| `dataDirectory` | The provider's data folder, mapped into the Files view. |
| `ports` | Named bindings with `protocol`, `purpose`, `visibility`, and a default `port`. |

Placeholders are the same wherever they appear — launch arguments, seeded config values,
and a seed file's own path: `{port:<name>}`, `{secret:<name>}`, `{slug}`, `{displayName}`,
`{installPath}`, `{dataDir}`, `{version}`, `{classpath}`, `{heapMb}`. A token the config
never declared stops the install rather than reaching the command line. The full
reference, including how to seed a settings file, is in
[the catalogue guide](game-servers-catalogue.md).

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
  "genre": "Survival",
  "requiresEula": true,
  "steamAppId": 12345,
  "executable": "MyServer.exe",
  "launchArgs": ["-port", "{port:game}", "-batchmode"],
  "ports": [
    { "name": "game", "protocol": "udp", "purpose": "game", "visibility": "public", "port": 25000 }
  ]
}
```

That is the whole file — everything else has a default. Drop it into `<data>/game-servers/catalogue/` on the machine, open **Game Servers → Add a server**, and press **Reload configs**. The game appears in the library immediately; there is no rebuild and no restart. A file that does not match the schema is skipped on its own, with the reason shown on that page, so a typo never takes the catalog down.

Games that need more — a settings file seeded with the allocated port, a generated admin password, a sized JVM heap, a bundled runtime — describe that in the same file with `seedFiles`, `secrets`, `heap` and `classpathDirectory`. Project Zomboid needs all four and is still just a config.

Configs are shared through the repository. If you write one for a game that is not in the library, a pull request adding the file is the whole change — see [docs/game-servers-catalogue.md](game-servers-catalogue.md) for the review checklist and how to test it on your own install first.

## Setting up a server that works

The panel takes care of the service, the ports and the firewall. The game inside is still
yours — these are the settings that decide whether anyone can actually play on it.

**Names and passwords first.** Every game shows a server name in its browser list, and
most take a password. Set both before inviting anyone: a server called `server` with no
password is open to whoever finds it. The file manager's **Server config** button opens
the right file for the games that name one; the rest keep the setting in their own config
under the data folder.

**Passwords the panel generated are on the server's Credentials panel.** Where a game's
config declares one — Project Zomboid's admin account, for instance — WinPanel generates
it at install, keeps it in the vault, and shows it on request from the server's page.
Reinstalling reuses it rather than rotating it, so the account the game created still
works.

**Match the player count to the machine.** A server's default max-players is often far
above what a small VM holds comfortably. Player slots cost memory before they cost CPU,
and a server that runs out of memory does not lag — it stops. Start lower than the
default and raise it once you have seen what a full evening does to the machine.

**Game ports are already allocated and firewalled; the rest of the path is not.** The
Connection panel shows the exact bindings. If players cannot connect, the cause is almost
always upstream: the router has no port forwarding, the cloud security group has no rule,
or the game is still starting. Check those in that order before touching the panel.

**Updates replace files, not settings.** An update pulls the current build from the
provider and keeps the data folder. Settings, worlds and saves survive it; a setting the
provider renamed between versions does not, so read the provider's patch notes before
updating a server people are playing on.

## Updates and limitations

Reinstalling or installing again runs the provider's acquisition path. A normal update workflow will be exposed per provider once its data migration and graceful-stop behavior are tested.

The library shows a small roadmap of popular games while their adapters are tested. Planned titles cannot be created yet. The first release does not support arbitrary Steam App IDs, arbitrary launch commands, Linux servers, generic mod-loader installation, scheduled backups, or raw game traffic analytics. A game is promoted to Ready only after its Windows executable, ports, launch arguments, health behavior, EULA flow, console behavior, and reinstall behavior are tested.
