# Third-party notices

WinPanel is licensed under [PolyForm Perimeter 1.0.1](LICENSE.md). This file records the
third-party software it uses, and under what terms, so that the notice requirements of
those licences are met.

Nothing distributed *inside* the installer is under a copyleft licence, so none of it
places conditions on how WinPanel itself is licensed. Two components the panel can
download afterwards - Stalwart and Git for Windows - are copyleft; see [Downloaded by the
panel, not distributed with it](#downloaded-by-the-panel-not-distributed-with-it) for what
that does and does not mean here.

---

## Bundled in the installer

Distributed inside `WinPanel-Setup-x64.exe` and installed to `C:\WinPanel`.

| Component | Licence | Notice shipped |
| --- | --- | --- |
| Node.js 22 runtime | MIT, with the notices of its own bundled components | `bin\node\LICENSE` |
| WinSW service wrapper | MIT | `bin\WinSW.LICENSE.txt` |
| The agent's npm dependencies | MIT, ISC, BSD, Apache-2.0 and Blue Oak 1.0.0 | Each package's own file under `agent\node_modules\` |
| The panel's npm dependencies | MIT and ISC | This file - Vite minifies them into one bundle, so per-package files cannot travel with them |

The panel bundle contains Vue (with `@vue/*` runtime, `vue-demi` and `csstype`), Vue Router,
Pinia, TanStack Query (`@tanstack/vue-query`, `@tanstack/query-core`,
`@tanstack/match-sorter-utils`, `remove-accents`), `@trpc/client`, `superjson` (with
`copy-anything` and `is-what`), `zod`, `uqr`, `lucide-vue-next`, and the stylesheet
Tailwind CSS generates. All are MIT except `lucide-vue-next`, which is ISC.

That list is checked against `pnpm --filter @winpanel/panel licenses list --prod` when a
dependency is added or removed, since a bundle nobody re-reads is how a notice goes stale.

### Dual-licensed packages, and the choice made

| Package | Offered as | WinPanel uses it under |
| --- | --- | --- |
| `node-forge` | BSD-3-Clause **or** GPL-2.0 | **BSD-3-Clause** |
| `rc` | BSD-2-Clause **or** MIT **or** Apache-2.0 | **MIT** |
| `expand-template` | MIT **or** WTFPL | **MIT** |

The GPL-2.0 option on `node-forge` is deliberately **not** taken. Taking it would make the
agent a derivative work under GPL terms and would be incompatible with the licence above.

---

## Downloaded by the panel, not distributed with it

These are fetched from their own publishers, at the user's request, onto the user's own
server. WinPanel starts and supervises them as separate processes; it does not link
against them, embed them or redistribute them, so they are separate works rather than part
of WinPanel.

| Component | Licence | Source |
| --- | --- | --- |
| Caddy | Apache-2.0 | `caddyserver.com` |
| `caddy-dns/cloudflare` module | Apache-2.0 | Built into the Caddy download |
| Stalwart mail server | AGPL-3.0 | `github.com/stalwartlabs/stalwart` |
| Git for Windows (MinGit) | GPL-2.0, plus the licences of its components | `github.com/git-for-windows/git` |
| Node.js (additional versions) | MIT | `nodejs.org` |
| pnpm | MIT | `github.com/pnpm/pnpm` |
| Yarn | BSD-2-Clause | `github.com/yarnpkg/yarn` |
| Bun | MIT | `github.com/oven-sh/bun` |

**On Stalwart and Git.** Both carry copyleft licences, and both are reached only by
running them as ordinary Windows Services and talking to them over the network or the
command line. No Stalwart or Git code is compiled into, linked with, or shipped inside
WinPanel. The obligations of AGPL-3.0 and GPL-2.0 attach to those programs and to whoever
distributes them, which here is their own publisher rather than this project.

If that ever changes - if a future version bundles either binary in the installer - the
position has to be looked at again before it ships.
