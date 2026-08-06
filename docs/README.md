# WinPanel developer documentation

Written for people changing the code, not for people running the panel. The
[README](../README.md) covers what WinPanel does and how to install it.

| Document | What is in it |
| --- | --- |
| [architecture.md](architecture.md) | How the agent, panel, Caddy and Stalwart fit together, and what each module owns |
| [development.md](development.md) | Running a local instance, environment variables, known gotchas |
| [dns.md](dns.md) | Cloudflare tokens, the record planner, certificate issuance |
| [email.md](email.md) | Stalwart over JMAP, mailboxes, aliases, DKIM, and the certificate sync |
| [users-and-roles.md](users-and-roles.md) | Roles, limits, ownership enforcement, sessions and IP bans |
| [updating.md](updating.md) | How the panel updates itself, and why the installer is run by the task scheduler |
| [testing.md](testing.md) | Testing conventions, including the adversarial ones |

`screenshots/` holds the images used by the README. They are captured from a local
instance seeded with invented data — no real domain, mailbox or customer appears in them.
