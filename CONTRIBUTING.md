# Contributing

Thanks for taking an interest. WinPanel runs on other people's servers, so the bar for
changes is "would I be happy for this to run unattended on a machine I cannot reach".

If you want to talk something through before writing it, the
[Discord](https://discord.gg/wT6mnfAnUD) is the place — it saves finding out at review
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
  comments in this repository describe the failure that made the code necessary — keep to
  that style.
- **Errors are written for the person reading them.** They will be a system administrator
  at the end of a long day, not a developer with the source open. Say what happened and
  what to do next.
- **No new dependency without a reason.** Every package is something that has to be
  audited, updated and shipped in the installer.

## Tests

New code touching file paths, process launching, downloads or authorisation is expected to
come with tests written against the attack rather than the happy path — see
[docs/testing.md](docs/testing.md) for the two examples worth imitating.

## Reporting bugs

Open an issue with the template. Include the WinPanel version, the Windows build, and what
the panel said — the exact wording usually identifies the code path immediately.

If you are not sure it is a bug, ask on [Discord](https://discord.gg/wT6mnfAnUD) first.

Security issues do **not** go in the issue tracker, and not on Discord either. See
[SECURITY.md](SECURITY.md).
