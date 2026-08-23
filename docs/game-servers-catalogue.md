---
title: Add a game to WinPanel with a config file
description: >-
  The game server catalog is data, not code — add Minecraft-style or Steam dedicated
  servers to WinPanel on Windows by dropping a JSON config file into a folder. The
  fields, the merge order, and the validation rules.
---

# Game server catalog files

The library is data, not code. Each supported game is a JSON file in
`game-servers/catalogue/` in the repository, and the panel reads the same folder from its
data directory at runtime. Adding a game means adding a file, not editing TypeScript.

## How the panel loads the catalog

Two folders are merged at startup:

- `game-servers/catalogue/` in the repo — the seed set that ships with the installer.
- `<data>/game-servers/catalogue/` in the installed panel — where an administrator drops
  or overrides configs without a rebuild.

A file in the data folder with a built-in ID replaces the built-in. That is how a local
tweak wins without forking the release. Every file is validated against the shared schema
before it can influence anything; an invalid one is skipped with its name logged, not
loaded.

## The fields a config carries

| Field | What it does |
| --- | --- |
| `id` | Unique catalog ID. Lowercase, stable, used to merge overrides. |
| `provider` | How the files are fetched: `steam`, `download` (a zip from `downloadUrl`), or `minecraft-java` (Mojang's signed manifest). `minecraft-bedrock` is an older name for `download`. |
| `name` / `description` | Shown in the library and on the server card. |
| `status` | `ready` or `planned`. Only `ready` can be created. |
| `genre` / `art` | Genre label and local fallback art theme. |
| `requiresEula` | Whether the creation form demands an EULA tick. |
| `steamRequiresOwnership` | Whether the game needs a Steam account that owns it. |
| `steamAppId` / `steamArtAppId` | The install ID and the retail ID used for library artwork. |
| `artUrl` | Official cover art URL for games that are not on Steam. Proxied and cached by the panel. |
| `configFile` | The main settings file, relative to the server's data folder. Adds an edit shortcut on the server page. Omit it to hide the shortcut. |
| `executable` / `launchExecutable` | The file that proves a download completed, and the binary the service actually runs. |
| `runtime` | `native`, or `java` to run the panel's own Java runtime instead of a binary from the download. |
| `launchArgs` | The service's arguments, with placeholders expanded at install time. |
| `workingDirectory` | `install` (default), `data`, or `executable` — the folder the service runs from. |
| `seedFiles` | Config files written before the first start, so the game learns its allocated ports and generated passwords. |
| `secrets` | Passwords the panel generates, stores in the vault, and expands as `{secret:name}`. |
| `heap` | `minMb` / `maxMb` / `reserveMb` for JVM games. Enables `{heapMb}`, sized from the memory free at install time. |
| `classpathDirectory` | Folder of jars joined into `{classpath}`, for games launched through their own bundled JVM. |
| `downloadUrl` / `downloadSha256` | Official download and optional checksum for non-Steam providers. |
| `console` | `rcon` (log tail plus commands), `logs` (read-only tail), or `none`. |
| `dataDirectory` | The provider's data folder, relative to the install root, mapped into the Files view. Omit it to use the panel's own data folder; `.` means the install root itself. |
| `ports` | Named bindings with `protocol`, `purpose`, `visibility`, and a default `port`. |

## Placeholders

The same tokens work in `launchArgs`, in `seedFiles` values, and in a seed file's own
`path`. Nothing else in the panel knows what any of them mean for a particular game.

| Token | Expands to |
| --- | --- |
| `{port:<name>}` | The port allocated to the binding with that `name`, or that `purpose`. |
| `{gamePort}` | Shorthand for `{port:game}`. |
| `{secret:<name>}` | A generated password declared in `secrets`. |
| `{slug}` / `{displayName}` | The server's slug and the name its owner gave it. |
| `{installPath}` / `{dataDir}` | Absolute paths to the install root and the resolved data folder. |
| `{version}` | The version installed, where the provider resolves one. |
| `{classpath}` | Every jar in `classpathDirectory`, joined for the JVM. |
| `{heapMb}` | The heap size chosen from `heap` and the machine's free memory. |

A `{port:...}` or `{secret:...}` the config never declared stops the install with a clear
message rather than reaching the command line. A typo that silently got through would
start a server bound to nothing and look like a firewall problem. Braces that are not
tokens are left alone, so a game whose own arguments use them still works.

## Seeding a config file

Most games need to be told which port they were given, and every one of them keeps that
somewhere different. `seedFiles` describes the file instead of the installer knowing
about it:

```json
"seedFiles": [
  {
    "path": "Server/{slug}.ini",
    "format": "ini",
    "mode": "create",
    "eol": "crlf",
    "values": { "DefaultPort": "{port:game}", "PublicName": "{displayName}" }
  }
]
```

- `format` is `properties`, `ini`, `json`, or `text`. `text` writes `content` verbatim.
- `mode: "create"` writes the file only when it is absent, so a server its owner has
  since configured by hand is not reset by a reinstall. `mode: "merge"` keeps every other
  line and rewrites only the keys listed — which is what a port allocation needs to do to
  a file the game owns.
- `eol: "crlf"` for games that only parse their own settings file with Windows line
  endings.
- A value that is *only* a port token lands in JSON as a number, not a string, because
  games that parse their config strictly reject the quoted form.
- `path` is relative to the data folder. Absolute paths and `..` are rejected: a catalog
  file is contributed content, and it does not get to write outside the server's folder.

## Ports are defaults, not assignments

The `port` field in a config is the starting point, not a guarantee. WinPanel allocates
from the shared safety domain, so two people can run the same game and each gets a free
port. The config tells the panel where to begin looking; the allocator walks from there.
If the default is taken by a website, another game server, or Windows, the next free one
is used instead. The actual binding is shown on the server's Connection panel.

Some games let you set player limits in launch arguments; others, like Nomad, keep them
in the config file. A config can describe either shape, because `launchArgs` and
`dataDirectory` are separate. The panel does not enforce a universal max-players field —
that is provider-specific, and pretending otherwise would produce a setting that does
nothing on half the catalog.

## An example

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
  "launchArgs": ["-port", "{port:game}", "-batchmode"],
  "console": "none",
  "ports": [
    { "name": "game", "protocol": "udp", "purpose": "game", "visibility": "public", "port": 25000 }
  ]
}
```

The panel validates the file at startup, and the game appears in the library the next
time it loads. A bad file is skipped with its name in the log, so a typo never takes the
catalog down.

Everything the built-in games do is expressible this way. Project Zomboid — a Steam
download, run through its own bundled JVM, with a generated admin password, a sized heap
and a CRLF settings file in a folder the game insists on — is a catalog file and no
TypeScript at all. If a game needs something the schema cannot describe, that is a gap in
the schema worth reporting, not a reason to special-case the installer.

## Trying one without a rebuild

The catalog folders are read at startup and again whenever you ask, so writing a config is
a normal edit-and-check loop rather than a release cycle:

1. Drop the `.json` file into `<data>/game-servers/catalogue/` on the machine.
2. Open **Game Servers → Add a server** and press **Reload configs**.
3. The game appears in the library. If it does not, the page says which file was skipped
   and why, in plain words from the schema.

There is no build step and no restart. A file that fails validation is skipped on its own;
the rest of the library keeps working.

## What the panel does for you

Only `id`, `provider`, `name`, `description`, `genre`, `requiresEula`, `executable` and
`ports` are required. Everything else has a default, so a straightforward Steam server is a
short file. Whatever the config declares, the panel handles the parts that are the same for
every game:

- allocating and firewalling each declared port, and reallocating on a collision
- registering a Windows Service that restarts on failure, with a scoped Files view
- generating and vaulting each declared secret, and showing it to the server's owner on
  the **Credentials** panel
- writing the declared config files before the first start, and not overwriting one its
  owner has since edited
- Steam branch selection, updates, reinstalls and per-customer access, for any Steam entry

## Sharing a config

A config that works on your server works on everyone's. If you have written one for a
game that is not in the library, open a pull request that adds the file to
`game-servers/catalogue/` — nothing else. No TypeScript, no release notes; the loader
finds it and the next release carries it.

Before opening it, check the file against the list below. These are the things a review
will ask about, in the order it will ask them:

- **The download is official and verifiable.** A Steam `steamAppId` from the publisher's
  own depot, or a `downloadUrl` on the publisher's own domain. A config that points at a
  re-upload or a third-party mirror is a supply-chain problem, not a contribution.
- **The executable check matches what the download actually contains.** `executable` is
  how the panel knows an install completed; a wrong name produces a server that installs
  and then cannot start.
- **Ports are the provider's documented defaults.** WinPanel reallocates them on
  collision, so the catalog value is the well-known one, not a random high port.
- **`launchArgs` are complete enough to start unattended.** A server that needs a console
  answer on first launch cannot run as a service. Use the documented batch/dedicated
  flags (`-batchmode`, `-nographics`, headless JVM options) rather than leaving the
  prompt for a person who is not there. If the game insists on a password at that prompt,
  declare it in `secrets` and pass it as an argument.
- **The server is reachable, not just running.** Start it and connect from another
  machine. A game that has to announce itself to a public browser usually needs a flag in
  its settings file — seed it, or the server will look healthy and be invisible.
- **The config has been run.** Install it through the panel on a real machine, start it,
  and connect to it. A config that has never been run is a guess.

Artwork is optional. Steam games get cover art from their `steamArtAppId` automatically.
For anything else, `artUrl` points at the publisher's official image and the panel
proxies it; the themed letter fallback is fine without one.
