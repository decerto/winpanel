# Development

## Prerequisites

- Node 22 or newer (Node 24 works, with one caveat — see [Gotchas](#gotchas))
- pnpm 10
- Windows, for anything touching services, the firewall or the mail server. The API,
  database and detection layers run fine on other platforms; those parts are what the
  test suite exercises.

```bash
pnpm install
pnpm build         # build every package
pnpm test          # run all tests
pnpm typecheck     # type-check every package
pnpm check         # typecheck + test
```

## Running a local instance

Point the agent at a scratch folder so it never touches `C:\WinPanel` or `C:\Sites`:

```powershell
$env:WINPANEL_ROOT       = "$PWD\.devroot"
$env:WINPANEL_SITES_ROOT = "$PWD\.devsites"
$env:WINPANEL_HOST       = "127.0.0.1"

pnpm build
node apps/agent/dist/index.js
```

The agent listens on `https://127.0.0.1:8443` and prints its **setup code** on first
start. The code is also written to `<WINPANEL_ROOT>\data\setup-token.txt`.

In a second terminal:

```bash
pnpm -C apps/panel dev
```

Vite serves the panel on `http://localhost:5173` and proxies `/api` to the agent with
certificate verification disabled, so the self-signed panel certificate is not in the
way. Open `http://localhost:5173`, enter the setup code, and create the first account.

Both `.devroot/` and `.devsites/` are gitignored. Deleting them resets everything,
including the account and the vault key.

## Environment variables

| Variable | Default | What it changes |
| --- | --- | --- |
| `WINPANEL_ROOT` | `C:\WinPanel` | Installation root; every other path defaults under it |
| `WINPANEL_SITES_ROOT` | `C:\Sites` | Where hosted sites live, and the file manager's containment boundary |
| `WINPANEL_BIN_DIR` | `<root>\bin` | Downloaded component binaries |
| `WINPANEL_DATA_DIR` | `<root>\data` | Database, vault key, panel certificate, setup token |
| `WINPANEL_CADDY_DIR` | `<root>\caddy` | Caddy's own storage and issued certificates |
| `WINPANEL_ACCESS_LOG_DIR` | `<root>\logs\access` | Per-site access logs the traffic figures are read from |
| `WINPANEL_HOST` | `0.0.0.0` | Bind address |
| `WINPANEL_PORT` | `8443` | Panel port |
| `WINPANEL_HTTPS` | `true` | Set `false` to serve the panel over HTTP locally |
| `WINPANEL_LOG_LEVEL` | `info` | pino log level |

## Gotchas

**`pnpm -C apps/agent dev` fails on Node 24.** The watch script uses
`--experimental-strip-types`, and the source imports its own modules with `.js`
specifiers that resolve to `.ts` files on disk. Node cannot resolve them and exits with
`ERR_MODULE_NOT_FOUND`. Build first and run `node apps/agent/dist/index.js` instead.

**Native modules on Windows.** Node 24 forces the ClangCL toolset in its bundled
`common.gypi`, which breaks anything node-gyp actually has to compile. This repository
only depends on packages that ship prebuilt binaries (`better-sqlite3` via
`prebuild-install`, `@node-rs/argon2` via napi-rs), so no compiler is involved. Keep it
that way when adding dependencies.

**"This server is not set up yet."** The panel shows this banner while `caddy` or `git`
are missing from `<WINPANEL_BIN_DIR>`, because `components.list` decides a component is
installed by finding `<binDir>\<id>\<id>.exe`. Install them from the Components page, or
accept the banner in a scratch environment.

**Mail tests.** `test/mail-service.test.ts` fails on a machine without the
`winpanel-stalwart` WinSW wrapper registered. That is environmental, not a regression.

## Screenshots

The images in `docs/screenshots/` are captured from a local instance seeded with invented
data, at a 1440×900 viewport, in the panel's dark theme. If a screenshot needs replacing,
recapture the whole page (`fullPage`) at the same viewport so the set stays consistent.
