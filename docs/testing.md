# Testing

```bash
pnpm test                       # everything
pnpm -C apps/agent test         # agent only (vitest)
pnpm -C apps/panel test         # panel only
```

The agent's suite runs against a temporary directory. `createAppContext` takes explicit
paths for the database, vault key and setup token precisely so a test can build a
complete, isolated instance - there are no module-level singletons to reset between
files.

`test/global-setup.ts` runs once before everything else and warms PowerShell's
`System.Security` assembly, which the vault reaches DPAPI through. On a cold CI runner
the first call can take over thirty seconds; paying it here rather than inside whichever
vault test happens to run first keeps the timeouts meaningful.

## Adversarial tests

Security-critical code is tested against the attack, not only the happy path. Two
examples to imitate:

- `test/path-containment.test.ts` creates a **real directory junction** pointing outside
  the site folder and asserts the read is refused. A test that only checks `../` string
  handling would pass while the code is broken.
- `test/components.test.ts` serves a **tampered download** and asserts nothing is left on
  disk afterwards - a partially written binary is worse than a failed install.

New code touching paths, process launching or downloads is expected to add tests in the
same style.

## Things that bite

- **Traffic fixtures need recent timestamps.** The collector prunes rows older than
  `RETAIN_DAYS` in the same sweep that inserts them, so a fixture log line dated last year
  vanishes immediately. Anchor fixtures to `bucketOf(Date.now())`.
- **`test/mail-service.test.ts` depends on the machine.** `setEnvironment` restarts a
  service only when it is running, and it asks Windows rather than its own config. On a
  machine that already has a real `winpanel-stalwart` service registered, three tests fail
  trying to restart it through a wrapper in the temporary directory. Clean machines and CI
  runners pass.
- **Windows-only paths.** Service, firewall and DPAPI code is guarded so the rest of the
  suite runs anywhere; if you add a Windows-only branch, add the guard too.

## Type checking

`pnpm typecheck` covers every package, including the panel's `vue-tsc` pass. `pnpm check`
is build, typecheck and test in one, and is what to run before opening a pull request.
