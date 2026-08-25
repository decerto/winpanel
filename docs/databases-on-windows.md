---
title: How to host MariaDB, PostgreSQL and MongoDB on Windows
description: >-
  Run your own MariaDB, PostgreSQL and MongoDB databases on Windows Server 2022/2025 or
  Windows 11 - each a one-click install, bound to loopback, with per-account limits, a
  built-in browser, and connection details you can point any application at.
---

# Databases on Windows

WinPanel can run three database servers for you, and treats them as one feature. Which
one a database is on is a choice you make when you create it, not three separate parts of
the panel to learn.

| Engine | What it is for |
| --- | --- |
| **MariaDB** | MySQL-compatible. What WordPress and most PHP applications expect. |
| **PostgreSQL** | The relational database most modern application frameworks default to. |
| **MongoDB** | Stores documents rather than rows. Common in Node.js and JavaScript projects. |

None of them are installed to begin with, and **nothing about an engine you have not
installed is shown anywhere in the panel** - not in a dropdown, not as a greyed-out
option. If you have installed only PostgreSQL, PostgreSQL is simply what "add a database"
means on your server.

## Installing one

1. Open **Settings**, and find the Programs section.
2. Press **Install** next to the database server you want.

That is the whole procedure. WinPanel downloads the pinned release, checks it against the
SHA-256 the publisher published, unpacks it, creates and initialises a data directory
under its own data folder, generates an administrative password and stores it encrypted,
registers a Windows Service, starts it, and adds it to the watchdog that restarts it if
its process ever dies behind Windows' back.

Each server listens on `127.0.0.1` only by default, on its standard port - 3306, 5432
and 27017. Nothing is exposed to the network and no firewall rule is opened, because a
hosted database is reached by applications on the same machine.

**Removing** a database server removes the program and leaves its data exactly where it
is. Reinstalling picks the same data back up.

## Creating a database

Once at least one server is installed, **Databases** appears in the sidebar, and a
**Databases** tab appears on every website.

Creating one asks for an engine, a name, a storage allowance, and - optionally - a website
to attach it to. A database does not have to belong to a website: plenty of what people
self-host is an application, a bot or a mobile backend rather than a site on this server,
and all of it still needs somewhere to keep its data. A database made for a website shows
up on that website's tab as well as on the main page. A storage allowance of **0** means
unlimited.

You are shown the name, username and password once, when the database is made. The
password is then only in WinPanel's encrypted vault; you can reveal it again, or set a new
one, from either page.

### Names

The name you type gets a prefix in front of it. Each server has one flat namespace shared
by everyone on the machine, so without a prefix the second person to ask for `shop` would
either be refused for no reason they could see or - much worse - handed the first one's
data. So `shop` becomes something like `wp_a1b2c3…_shop`, and that full name is what you
put in your connection string.

## Logins

Each database gets exactly one login, created with it, named the same as the database. You
do not create users separately, and there is no step where a database exists but nothing
can reach it.

That login can reach exactly that database and nothing else:

- **MariaDB**: a user granted privileges on that schema alone, and only from `127.0.0.1`.
- **PostgreSQL**: a role that owns the database, with `CONNECT` revoked from `PUBLIC`.
  This matters more than it sounds - PostgreSQL grants every role access to every database
  by default, so the default is not safe on a shared server and WinPanel changes it.
- **MongoDB**: a `dbOwner` created inside the database itself, so its credentials are
  meaningless anywhere else. Access control is on from the very first start, which is what
  keeps WinPanel's MongoDB out of the category the internet is famous for finding open.

## Connecting

Creating a database shows you a **connection string** with the password already in it,
along with the host, port, database name and username separately - and, for MongoDB, the
auth source. The host is this server's first reachable IPv4 address, so the same string
can be used from a developer's computer and by an application deployed back here. That is
the one moment the password is on screen, so copy it then.

```text
mysql://<name>:<password>@<server-ip>:3306/<name>
postgresql://<name>:<password>@<server-ip>:5432/<name>
mongodb://<name>:<password>@<server-ip>:27017/<name>?authSource=<name>
```

Afterwards, **Connect** on any database reopens the same block with `PASSWORD` left as a
placeholder, and **Show password** fills the real one back in. The password is never lost -
it is in WinPanel's encrypted vault - and **New password** replaces it if it ever escapes.

MongoDB's `authSource` is not optional. Its login lives inside its own database rather than
in `admin`, and a driver that is not told so looks in `admin`, finds nothing, and reports
the password as wrong.

Because the servers are bound to loopback by default, the database is still local-only until
you enable remote access. A website WinPanel hosts can use `127.0.0.1` while it remains local;
once remote access is enabled, the displayed server-address URI works both from your own
computer and from an application running here. See [Remote connections](#remote-connections).

## Looking inside

Each database has an **Open** button, and you do not need pgAdmin, MySQL Workbench or
MongoDB Compass to see what is in it.

- **MariaDB and PostgreSQL** open in [Adminer](https://www.adminer.org/), already signed
  in - tables, rows, editing, and a SQL console. Adminer never sits on a public domain:
  WinPanel runs it on a private, loopback-only PHP server and proxies it behind the panel's
  own sign-in. The password never reaches your browser either - opening it mints a one-shot
  ticket that a small plugin swaps for the real credentials on the server side. Install
  **Database browser (Adminer)** from Settings to get this.
- **MongoDB** opens a browser built into the panel: collections, document counts, and the
  documents themselves with a JSON filter box. It **reads only**. MongoDB has no Adminer
  driver that works on Windows - the one it has needs a PECL extension PHP does not ship -
  so rather than leave MongoDB the one engine you cannot see into, WinPanel reads it
  directly.

Desktop tools still work if you prefer them, or if you want to write to MongoDB rather than
just read it. Paste the connection string into Compass, pgAdmin, DBeaver or `psql` and they
will connect from the server itself.

### Remote connections

Each database decides for itself, and the decision belongs to whoever owns it rather than
to whoever owns the server - the person who needs to connect is the customer or the
developer they hired, and an administrator has no way of knowing what address that is.

Press **Remote access** next to a database on the **Databases** page and choose one of:

- **This server only** - the default. Nothing off this machine can reach it.
- **Any IP** - anyone who can reach the server may try to sign in. Only the password stands
  in the way.
- **Chosen addresses** - only the IP addresses or CIDR ranges you list, plus this server's
  first reachable IPv4 address, which WinPanel always includes for applications running here.

**Add my IP** fills in the address your browser reached the panel from, so you do not have
to look it up. It is not offered when you are signed in on the server itself, because
loopback would let nothing new in.

Databases on one engine share a port, so the first database to want remote access opens it
for that engine. That does not put anybody else's data within reach: the login is
restricted to the same addresses the owner chose, and a database that asked for nothing
stays reachable only from this machine.

| Engine | What holds the line |
| --- | --- |
| **MariaDB** | The account exists only for the listed addresses - `user@203.0.113.42`, or a netmask for a range. There is no `user@%` unless the owner asked for Any IP. |
| **PostgreSQL** | A `pg_hba.conf` line naming that one database, that one role and that one source. Never `host all all`. |
| **MongoDB** | An authentication restriction on the login itself, so it answers only to the listed addresses. |

The listeners are IPv4, so an IPv6 entry is allowed through the firewall but still will not
connect. A cloud-provider firewall, router port-forward or NAT rule may also be needed -
those are outside the panel's control. Use the server's reachable public address as the
connection host; never `0.0.0.0`, which is a listener address and not a destination.

Once a database is reachable remotely, the connection details shown in the panel use the
server's first non-loopback address as a convenience. Replace it with the public address or
DNS name when the server is behind NAT.

## Moving a database to a website

A database does not have to be tied to a website, and the one it is tied to can be changed
at any time from the **Used by** column on the **Databases** page. Nothing moves and
nothing is rewritten - the database keeps its name, its login and its contents, and only
the website it is listed under changes.

Handing a website to another account takes its databases with it, so the new owner can see
the password their own site is using and the previous owner can no longer reach it.

## Allowances

Databases are something you sell, so they are something you can limit.

- **Per account** - on the **People** page, each customer has a *Databases* number. It
  counts every database they hold, across every engine, whether or not it belongs to one
  of their websites. New customers start at **0**, which keeps the whole feature out of
  their panel until you decide otherwise.
- **Per website** - a website can additionally be capped, so a customer with an allowance
  of ten cannot spend all ten on one site.
- **Storage per account** - *Database storage* on the **People** page is the total that may
  be allocated across the customer's databases. **0** means unlimited.
- **Storage per database** - each database receives part of that account total when it is
  created, and its allowance can be changed later from the main **Databases** page. The
  panel refuses an unlimited database inside a finite account quota, or any allocation
  that would take the account total over its quota. Current engine-reported usage appears
  beside the allowance.

Leave either blank for no limit. Administrators and the owner are never limited.

The storage figure is an allocation enforced by the panel when databases are created,
resized or transferred. MariaDB, PostgreSQL and MongoDB do not share a native hard-quota
mechanism, so it is not a write-time disk boundary; usage above an allocation is reported
and the allowance cannot be reduced below current usage.

## WordPress

Nothing changes. A WordPress site still creates its own MariaDB database during setup and
writes `wp-config.php` for it. Under a finite account storage quota, that database receives
the unallocated remainder. It appears alongside every other one, and changing its password
from the panel rewrites `wp-config.php` in the same breath - so the site does not go offline
waiting for somebody to edit a file.

## If something goes wrong

- **"Installed but did not finish setting up"** - the program is on disk but WinPanel does
  not hold an administrative password for it, so it cannot manage anything. Reinstall it
  from Settings; existing data is left alone.
- **A database vanishes from the list** - WinPanel checks the server before listing, and
  drops its record for a database that is no longer there. A database server that is *down*
  is never mistaken for one whose databases are gone; nothing is removed in that case.
- **The server keeps stopping** - check **Server health**. WinPanel watches each database
  service, and can tell "somebody stopped this" from "an orphaned process is holding the
  port so it can never start", which is the failure that otherwise looks like nothing at
  all.
