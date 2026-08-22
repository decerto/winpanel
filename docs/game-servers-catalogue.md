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
| `provider` | `minecraft-java`, `minecraft-bedrock`, or `steam`. |
| `name` / `description` | Shown in the library and on the server card. |
| `status` | `ready` or `planned`. Only `ready` can be created. |
| `genre` / `art` | Genre label and local fallback art theme. |
| `requiresEula` | Whether the creation form demands an EULA tick. |
| `steamRequiresOwnership` | Whether the game needs a Steam account that owns it. |
| `steamAppId` / `steamArtAppId` | The install ID and the retail ID used for library artwork. |
| `artUrl` | Official cover art URL for games that are not on Steam. Proxied and cached by the panel. |
| `configFile` | The main settings file, relative to the server's data folder. Adds an edit shortcut on the server page. `{slug}` expands to the server slug. Omit it to hide the shortcut. |
| `executable` / `launchExecutable` | The file that proves a download completed, and the binary the service actually runs. |
| `launchArgs` | Fixed arguments; `{gamePort}`, `{slug}`, `{classpath}`, and `{heapMb}` are expanded at install time. |
| `downloadUrl` / `downloadSha256` | Official download and optional checksum for non-Steam providers. |
| `console` | `rcon`, `stdin`, or `none`. `none` until a protocol is proven. |
| `dataDirectory` | The provider's data folder, mapped into the Files view. |
| `ports` | Named bindings with `protocol`, `purpose`, `visibility`, and a default `port`. |

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
  "launchArgs": ["-port", "{gamePort}", "-batchmode"],
  "console": "none",
  "ports": [
    { "name": "game", "protocol": "udp", "purpose": "game", "visibility": "public", "port": 25000 }
  ]
}
```

The panel validates the file at startup, and the game appears in the library the next
time it loads. A bad file is skipped with its name in the log, so a typo never takes the
catalog down.
