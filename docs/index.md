---
title: Hosting Node.js and websites on Windows Server
description: >-
  How to host Node.js apps, .NET apps and websites on Windows Server 2022/2025
  without IIS or iisnode - plus WinPanel, a free control panel that does it for you.
---

# Hosting websites and Node.js apps on Windows Server

**You can host Node.js on Windows Server. You do not need IIS, you do not need `iisnode`,
and you do not need a `web.config`.** Run each app as a Windows Service on a loopback port,
and put a reverse proxy in front of it for the domain and the HTTPS certificate. That is
the same architecture every Linux host uses — only the names of the parts differ.

These pages explain how to do that by hand, and how
**[WinPanel](https://github.com/decerto/winpanel)** — a free, self-hosted control panel for
Windows Server 2022 and 2025 — does it for you, per site, from a web page.

<p>
  <a href="https://github.com/decerto/winpanel/releases">Download the installer</a> ·
  <a href="https://github.com/decerto/winpanel">The repository</a> ·
  <a href="https://github.com/decerto/winpanel/wiki">The wiki</a> ·
  <a href="https://discord.gg/wT6mnfAnUD">Ask on Discord</a>
</p>

---

## The guides

### [How to host a Node.js app on Windows Server](nodejs-hosting-on-windows-server.html)

For developers and sysadmins. Why the "it's impossible" and "use `iisnode`" answers are
wrong, the four ways to do it ranked, a by-hand walkthrough with WinSW and Caddy, and the
eight Windows-specific failures that catch everybody — `EADDRINUSE :443`, the orphaned
process that keeps a stopped service's port, long paths, `spawn EINVAL`.

### [How to put a website on your own Windows server](hosting-a-website-on-windows-server.html)

For everyone else. What hosting a website actually involves, what it costs, what each word
means, and what goes wrong — with no jargon and no command line.

---

## What WinPanel is

A free control panel for Windows Server that manages websites, HTTPS, DNS, email and
customer accounts from one interface. Static sites, Node.js apps and ASP.NET Core apps are
all first-class; each runs as a supervised Windows Service, with [Caddy](https://caddyserver.com/)
in front handling domains, certificates and traffic.

- **Websites** — from Git or managed by hand, with builds that swap in only if they start
- **HTTPS** — free certificates, renewed automatically, over the DNS challenge
- **DNS** — Cloudflare records per website, including a reviewed "point this domain here"
- **Email** — self-hosted mailboxes with quotas, aliases, DKIM and webmail
- **People** — owner, administrator and customer roles, each with site, disk and mail limits
- **Server health** — detects and fixes the Windows settings that quietly break Node hosting

![The websites list](screenshots/websites.png)

It is free and self-hosted, and it runs real commercial sites. Full detail, screenshots and
installation instructions are in the
[README](https://github.com/decerto/winpanel#readme).

---

## More, on the wiki

- [Run a Node.js app as a Windows Service](https://github.com/decerto/winpanel/wiki/Run-a-Node.js-App-as-a-Windows-Service)
- [iisnode alternatives in 2026](https://github.com/decerto/winpanel/wiki/iisnode-Alternatives)
- [Fix "port 443 already in use"](https://github.com/decerto/winpanel/wiki/Fix-Port-443-Already-in-Use-on-Windows-Server)
- [SSL certificates without IIS](https://github.com/decerto/winpanel/wiki/SSL-Certificates-on-Windows-Server-Without-IIS)
- [Host your own email on Windows Server](https://github.com/decerto/winpanel/wiki/Host-Your-Own-Email-on-Windows-Server)
- [Free Plesk alternative for Windows Server](https://github.com/decerto/winpanel/wiki/Free-Plesk-Alternative-for-Windows-Server)
- [Windows Server vs Linux for web hosting](https://github.com/decerto/winpanel/wiki/Windows-Server-vs-Linux-for-Web-Hosting)
