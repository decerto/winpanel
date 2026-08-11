# How to host a Node.js app on Windows Server

**Short answer: yes, you can host Node.js on Windows Server, and you do not need IIS,
`iisnode` or a `web.config` to do it.** Run the app as a Windows Service on a local port
and put a reverse proxy in front of it for the domain and the HTTPS certificate. That is
the whole pattern. This page explains it, shows you how to do it by hand, and then shows
what [WinPanel](../README.md) automates.

Applies to Windows Server 2022 and 2025. The same approach works for Express, Fastify,
Next.js, Nuxt, NestJS, Astro, SvelteKit, Remix, Strapi, Socket.IO, Bun-style servers and
anything else that listens on a port.

---

## Why people tell you it is impossible

Search for "Node.js hosting on Windows Server" and you will be told, roughly in this
order, that:

- it cannot be done, because Node is a Linux thing;
- it can be done, but only through `iisnode`;
- you should give up and rent a Linux box.

None of that is true. Node.js has been a first-class Windows citizen since 2011 — the
official installer is an `.msi`, and `node.exe` is a normal Windows program. What is
genuinely missing on Windows is not the runtime. It is the **hosting furniture**: the
thing that keeps the app running, the thing that maps a domain to it, and the thing that
gets it a certificate. On Linux that is systemd plus nginx or Caddy, and every tutorial
assumes it. On Windows nobody wrote the equivalent chapter, so people conclude the
platform cannot do it.

It can. The pieces just have different names.

| On Linux | On Windows |
| --- | --- |
| systemd unit | A Windows Service (via WinSW, NSSM or `sc.exe`) |
| nginx / Caddy / Apache | Caddy — the same program, it runs natively on Windows |
| Certbot / Let's Encrypt | Caddy again; it obtains and renews certificates itself |
| `ufw` / `iptables` | Windows Defender Firewall |
| cPanel / Plesk / aaPanel | WinPanel, or Plesk for Windows |

---

## The four ways to run Node on Windows Server, ranked

### 1. As a Windows Service behind a reverse proxy — recommended

Your app listens on `127.0.0.1:3001`. A reverse proxy owns ports 80 and 443, terminates
HTTPS, and forwards requests to the app based on the hostname. A service wrapper starts
the app at boot and restarts it if it dies.

This is the same architecture used by every serious Linux host, it works with any Node
framework, it supports WebSockets, and it needs nothing from IIS. It is what this page
recommends and what WinPanel builds for you.

### 2. IIS with `HttpPlatformHandler` or Application Request Routing

IIS can launch a process and forward to it (`HttpPlatformHandler`), or proxy to a port you
started yourself (ARR + URL Rewrite). Both work. Both mean hand-writing a `web.config`,
installing modules that are barely documented, and debugging application-pool identities
and recycling behaviour that exist for ASP.NET rather than for Node. If IIS is already
hosting your .NET applications and you only want to add one Node app, this is a reasonable
choice. Otherwise it is a lot of ceremony for a reverse proxy.

### 3. `iisnode` — do not start here in 2026

`iisnode` is the answer most search results still give. It has not had a release in nine
years, still lists Windows Server 2012 as a prerequisite, and pre-dates most of what
modern Node applications assume. Existing installations keep working; nothing about it
recommends it for something you are building today.

### 4. `pm2` on its own — not enough by itself

`pm2` is a fine process manager and it runs on Windows, but on its own it does not survive
a reboot: it needs a service wrapper underneath it, and `pm2-windows-service` /
`pm2-windows-startup` are unmaintained. You also still need something in front of it for
the domain and the certificate. If you are going to register a Windows Service anyway,
register the app itself and skip the extra layer.

---

## Doing it by hand

Four steps. Roughly thirty minutes the first time, and you should do it once even if you
end up using a panel, because then you know what the panel is doing.

### Step 1 — Make the app listen on a port it is given

```js
const port = process.env.PORT || 3001;
app.listen(port, "127.0.0.1");
```

Binding to `127.0.0.1` rather than `0.0.0.0` means the app cannot be reached from outside
the machine except through the proxy. Reading the port from the environment means you can
run two copies during a deploy.

### Step 2 — Run it as a Windows Service

Node itself has no "run me at boot" facility, and a scheduled task or an open PowerShell
window is not a substitute. Use a service wrapper:

- **[WinSW](https://github.com/winsw/winsw)** — an XML file next to a renamed `.exe`. This
  is what WinPanel uses.
- **[NSSM](https://nssm.cc/)** — an interactive dialog for people who prefer one.
- **`sc.exe create`** — built in, but it can only run a real service binary, so on its own
  it will not run `node.exe`.

A minimal WinSW configuration:

```xml
<service>
  <id>my-app</id>
  <name>My App</name>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>server.js</arguments>
  <workingdirectory>C:\Sites\my-app</workingdirectory>
  <env name="PORT" value="3001" />
  <env name="NODE_ENV" value="production" />
  <onfailure action="restart" delay="10 sec" />
  <log mode="roll-by-size" />
</service>
```

Then `my-app.exe install` and `my-app.exe start`.

### Step 3 — Put a reverse proxy in front

Install [Caddy](https://caddyserver.com/) — it is a single `.exe`, it runs as a Windows
Service too, and it obtains and renews Let's Encrypt certificates without being asked.

```caddyfile
example.com, www.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

That is the entire configuration, HTTPS included. WebSockets and Socket.IO are upgraded
and proxied with nothing extra to write.

nginx for Windows works too, but it has no certificate automation and its Windows build
carries long-standing performance caveats.

### Step 4 — Open the firewall and point DNS

Allow inbound 80 and 443 in Windows Defender Firewall, then create an `A` record for your
domain pointing at the server's public IP address, and a `www` record beside it. Port 80
must be reachable for the certificate to be issued, unless you use the DNS challenge
instead.

---

## The Windows-specific things that will bite you

These are the failures that make people conclude Windows "cannot" host Node. Every one of
them is a five-minute fix once you know the name of it.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EADDRINUSE :443` when the proxy starts | IIS installed and holding 80/443 by default | Stop and disable the *W3SVC* / Default Web Site, or uninstall IIS |
| Service says **stopped**, but the site is still up | The wrapper was killed without a clean stop — usually a sleep/wake — and the app underneath survived, still holding the port | End the orphaned `node.exe`, then start the service. WinPanel detects and clears this automatically |
| `ENAMETOOLONG` / `EPERM` during `npm install` | The 260-character path limit | Enable long paths: `LongPathsEnabled` = 1 in `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` |
| `spawn EINVAL` when your code runs `npm`/`pnpm` | Node 20.12+ refuses to spawn `.cmd`/`.bat` without a shell | Invoke the CLI's `.js` entry point with `node`, or pass `shell: true` |
| Certificate issuance fails every time | Port 80 blocked at the firewall or by your host | Use the DNS-01 challenge instead — no inbound port needed |
| Everything is slow, or TLS fails intermittently | The Windows Time service is stopped, so the clock has drifted | Start `W32Time` and set it to automatic |
| App runs from your session but not as a service | The service account has a different `PATH` and no user profile | Set absolute paths and the environment explicitly in the service definition |
| Deploy overwrites files that are in use | The old process still has the folder open | Build into a second folder and swap, rather than writing over a running app |

---

## Doing it with WinPanel instead

Everything above, for every site, from a web interface:

- allocates the loopback port and registers the Windows Service;
- writes and reloads the Caddy configuration when domains change;
- obtains and renews certificates, over DNS-01 if you connect Cloudflare, so port 80 does
  not have to be open;
- deploys from Git — builds into a staging folder, swaps it in only if it starts, and
  rolls back if it does not;
- watches for the orphaned-process failure above every minute and clears it;
- checks the Windows settings in that table and fixes the safe ones for you;
- and adds DNS, mailboxes, a file manager and customer logins on top.

Install instructions are in the [README](../README.md#installing). It is free and
self-hosted, and your apps keep running whether or not the panel is.

---

## Frequently asked questions

### Can Node.js run on Windows Server?

Yes. Node has shipped official Windows builds since 2011 and runs as a normal Windows
program. What needs setting up is not Node but the hosting around it — a service to keep
it running, and a reverse proxy for the domain and the certificate.

### Do I need IIS to host a Node app on Windows?

No. IIS is a web server for ASP.NET; a Node app is its own web server already. You only
need something that owns port 443 and forwards to it, and Caddy does that in three lines.
If IIS is installed, it just has to stop holding ports 80 and 443.

### Do I need a `web.config` for a Node app?

No. `web.config` is an IIS file. If you are not using IIS, there is nothing to write.

### Is `iisnode` still maintained?

No. Its last release was nine years ago and it lists Windows Server 2012 as a
prerequisite. Do not start a new deployment on it.

### How do I keep a Node app running on Windows Server after logout or reboot?

Register it as a Windows Service with WinSW or NSSM. Services start at boot, run without
anybody signed in, and restart on failure. A scheduled task or a leftover terminal window
will not survive a reboot reliably.

### Can I host several Node apps on one Windows Server?

Yes. Give each one its own port and its own service, and let the reverse proxy route by
hostname. That is exactly what a hosting panel automates — WinPanel allocates ports from
3001 upwards and keeps the routing in step.

### Do WebSockets and Socket.IO work behind the proxy?

Yes. Caddy upgrades and proxies the connection with no configuration.

### Does ASP.NET Core work the same way?

Yes — Kestrel is a web server in exactly the same shape as a Node HTTP server, so it is
published, run as a service on a loopback port, and proxied identically.

### Is Windows Server hosting slower than Linux for Node?

For real applications the difference is dominated by your database, your I/O and your
code, not by the platform. File-system-heavy work (large `npm install` runs, thousands of
small files) is measurably slower on NTFS with Defender scanning it — excluding your sites
folder and your Node installation from real-time scanning is the single biggest win
available.

### Should I just use Linux?

If you have no reason to be on Windows, Linux hosting has more tutorials written for it.
But if you are on Windows because of Active Directory, an existing .NET estate, licensing,
a client's requirement or simply because that is the server you have, you are not stuck
and you do not have to migrate. The architecture above is the same one you would use over
there.

---

Related: [architecture.md](architecture.md) for how WinPanel puts these pieces together ·
[hosting-a-website-on-windows-server.md](hosting-a-website-on-windows-server.md) for the
same subject without the jargon.
