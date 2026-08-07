# Updating the panel

The user-facing instructions are in the [README](../README.md#updating). This is what
happens underneath, and why.

## The route in

| Piece | Where |
| --- | --- |
| `system.update` (`superadminProcedure`) | `apps/agent/src/api/routers/system.ts` |
| Job handler | `apps/agent/src/components/panel-update.ts` |
| Upload endpoint `POST /api/panel-update/installer` | `apps/agent/src/api/installer-upload.ts` |
| The UI | `apps/panel/src/pages/SettingsPage.vue`, owner only |

`system.update` takes either a `url` or a `filePath`, never both, plus an optional
`sha256`. It queues a job; the panel then follows the job log live, which matters because
the process serving that log is about to be stopped.

The upload is a plain streamed `POST` rather than a tRPC procedure. A browser hands over a
file's contents and never its path, and an installer is far too large to hold in memory
while also serving the panel. It is written straight to
`bin\.downloads\winpanel-upload.exe` — a fixed path, so an upload can only ever replace the
last one — and refused past 400 MB or if the first two bytes are not `MZ`.

## Order of operations

The order is the whole point:

1. **Fetch.** A URL must be `https:` (`validateUpdateUrl`). `file:` or a UNC path would
   turn this into a way to run whatever is on a share. A `filePath` is copied into the
   panel's own download folder rather than run where it lies.
2. **Verify.** The SHA-256 is checked if one was given, and the file is sniffed for the
   `MZ` header either way. An HTML error page saved by mistake is caught here.
3. **Only then, stop things.** Everything above happens while the panel is still running,
   so a bad download leaves a working server.

## Why a scheduled task

The installer's first act is to stop every WinPanel service — including the one that
started it. WinSW stops a service by killing its process *and everything below it*, so an
installer launched as a child of the agent is killed halfway through replacing the program
files. That is the one outcome worse than not updating at all.

So the handler registers a one-off task, `WinPanelUpdate`, running as `SYSTEM` with highest
privileges, and triggers it. The task belongs to Windows, so nothing that happens to the
agent process can touch it. Its `ONCE` trigger is dated 01/01/2099 — far enough ahead that
Windows can never decide to fire it on its own.

If `schtasks.exe` refuses, the installer is started directly as a detached process and the
job log says so. Worse, but a server that cannot schedule a task can usually still finish
an install, and the alternative is an update that cannot be applied at all.

Silent flags: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /LOG=...`. `/NORESTART`
matters — the installer must never decide on its own to reboot a server hosting other
people's websites.

## What the installer does

`PrepareToInstall` in `packages/installer/winpanel.iss`:

1. runs the bundled agent's `stop-all`, which stops Caddy, Stalwart and every website
   service and records what was running to `data\services-stopped-for-update.json`,
2. `net stop winpanel-agent`,
3. replaces the program files,
4. runs `install`, which re-registers the agent service, starts it, and resumes exactly the
   services listed in that file.

`stop-all` visits services that already report **stopped** as well as running ones, and
ends any leftover process it finds on their ports. That is not belt and braces: every
Node site runs `bin\node\node.exe`, so a single orphaned site process holds a file inside
the folder Inno Setup is about to replace, and reports it as a folder in use by nothing
the user can see. The panel's own orphan does the same. See
[Orphaned processes](architecture.md#orphaned-processes) for the shape of that failure and
the rules about what may be ended.

A service that does not come back afterwards is named in the wizard's final page, along
with the program holding the port it needed if something else has taken it.

That file is the reason the panel does not come back alone. Everything is set to start
automatically, so a reboot would bring it all back — but an in-place update never reboots,
and without the record every site on the server would stay dark until somebody noticed.

The installer keeps a stable `AppId`, so Windows treats this as an upgrade. `C:\WinPanel\data`
and `C:\Sites` are untouched, which is why sessions, secrets and site files survive.

## Afterwards

On its next start-up the agent calls `cleanUpAfterUpdate`, which deletes the scheduled task
and both temporary installers. A registered task that runs a file out of a download folder
as `SYSTEM` should not outlive the minute it was needed for.

## What does not exist

Say so plainly when asked:

- **No update check.** Nothing polls for a newer release, and the panel makes no outbound
  call to find out one exists. The version shown in Settings comes from `readVersion`,
  which reads the agent's own `package.json`.
- **No rollback.** There is no snapshot of the previous install. Blue/green rollback
  applies to *website* deployments, not to the panel.
- **No signature check on the installer.** Verification is HTTPS transport, the optional
  caller-supplied SHA-256, and the `MZ` sniff. Authenticode is verified when *building* the
  installer (for the Inno Setup download), not when applying one.
