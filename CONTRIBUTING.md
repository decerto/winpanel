# Contributing

Thanks for taking an interest. WinPanel runs on other people's servers, so the bar for
changes is "would I be happy for this to run unattended on a machine I cannot reach".

If you want to talk something through before writing it, the
[Discord](https://discord.gg/wT6mnfAnUD) is the place - it saves finding out at review
time that an idea was already tried.

## Getting set up

See [docs/development.md](docs/development.md) for prerequisites and how to run a local
instance. In short:

```bash
pnpm install
pnpm build
pnpm dev
```

## Before you open a pull request

```bash
pnpm check      # build + typecheck + test
```

Everything should be green. If `test/mail-service.test.ts` fails on a machine that already
has WinPanel installed, that is [a known environmental
failure](docs/testing.md#things-that-bite) rather than your change.

## What a good change looks like

- **One thing at a time.** A pull request that fixes a bug and reformats four files is
  hard to review and harder to revert.
- **Comments explain why, not what.** The code already says what it does. Existing
  comments in this repository describe the failure that made the code necessary - keep to
  that style.
- **Errors are written for the person reading them.** They will be a system administrator
  at the end of a long day, not a developer with the source open. Say what happened and
  what to do next.
- **No new dependency without a reason.** Every package is something that has to be
  audited, updated and shipped in the installer.

## Adding a game to the library

The game server catalog is data, not code. Adding a supported game means adding one JSON
file to `game-servers/catalogue/` - no TypeScript, no rebuild. The file format, the merge
rules, and the checklist a review follows are in
[docs/game-servers-catalogue.md](docs/game-servers-catalogue.md), including how to test a
config on your own install before opening the pull request.

## Tests

New code touching file paths, process launching, downloads or authorisation is expected to
come with tests written against the attack rather than the happy path - see
[docs/testing.md](docs/testing.md) for the two examples worth imitating.

## Reporting bugs

Open an issue with the template. Include the WinPanel version, the Windows build, and what
the panel said - the exact wording usually identifies the code path immediately.

If you are not sure it is a bug, ask on [Discord](https://discord.gg/wT6mnfAnUD) first.

Security issues do **not** go in the issue tracker, and not on Discord either. See
[SECURITY.md](SECURITY.md).

## Licence

WinPanel is under [PolyForm Perimeter 1.0.1](LICENSE.md) - free to use and change,
including commercially, but not to be sold or rebranded as a competing panel.

**By opening a pull request, you agree to two things:**

1. The work is yours to give - you wrote it, or you have the right to contribute it, and it
   is not copied from anywhere with incompatible terms.
2. You grant the maintainers a perpetual, worldwide, irrevocable, royalty-free licence to
   use, change, distribute and sublicense your contribution **under any terms, including
   commercial or proprietary ones**.

The second point exists because a project with a hundred part-owners can never change its
licence again - every contributor would have to be found and asked. You keep the copyright
in what you wrote; this only means the project can keep making decisions about itself.

A practical consequence: **do not paste in code under a licence that conflicts with that**,
which includes anything GPL, LGPL or AGPL. New dependencies need a permissive licence -
MIT, BSD, ISC or Apache-2.0. What is already in use is listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
