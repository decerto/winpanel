# WinPanel documentation

The [README](../README.md) covers what WinPanel does and how to install it.

## Guides for people running a server

These two answer the questions people arrive with, and need no knowledge of the codebase.

| Guide | Who it is for |
| --- | --- |
| [nodejs-hosting-on-windows-server.md](nodejs-hosting-on-windows-server.md) | How to host a Node.js app on Windows Server 2022/2025 or Windows 11 without IIS or `iisnode` — as a Windows Service behind a reverse proxy, by hand or with the panel |
| [hosting-a-website-on-windows-server.md](hosting-a-website-on-windows-server.md) | The same subject with no jargon: what hosting a website on your own Windows PC or server involves, what it costs, and what the words mean |
| [wordpress-on-windows-server.md](wordpress-on-windows-server.md) | How WordPress runs on Windows — PHP, a web server and MariaDB — and the one-click install the panel does for you |
| [game-servers-on-windows.md](game-servers-on-windows.md) | How to enable, install and manage supported Minecraft and Steam dedicated servers on Windows |
| [game-servers-catalogue.md](game-servers-catalogue.md) | The config-file format for adding a game, the fields it carries, and how the panel loads it |

## Developer documentation

Written for people changing the code, not for people running the panel.

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
