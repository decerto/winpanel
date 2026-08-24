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
installed is shown anywhere in the panel** — not in a dropdown, not as a greyed-out
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

Each server listens on `127.0.0.1` only, on its standard port — 3306, 5432 and 27017.
Nothing is exposed to the network and no firewall rule is opened, because a hosted
database is reached by applications on the same machine.

**Removing** a database server removes the program and leaves its data exactly where it
is. Reinstalling picks the same data back up.

## Creating a database

Once at least one server is installed, **Databases** appears in the sidebar, and a
**Databases** tab appears on every website.

Creating one asks for three things: which engine, a name, and — optionally — a website to
attach it to. A database does not have to belong to a website: plenty of what people
self-host is an application, a bot or a mobile backend rather than a site on this server,
and all of it still needs somewhere to keep its data. A database made for a website shows
up on that website's tab as well as on the main page.

You are shown the name, username and password once, when the database is made. The
password is then only in WinPanel's encrypted vault; you can reveal it again, or set a new
one, from either page.

### Names

The name you type gets a prefix in front of it. Each server has one flat namespace shared
by everyone on the machine, so without a prefix the second person to ask for `shop` would
either be refused for no reason they could see or — much worse — handed the first one's
data. So `shop` becomes something like `wp_a1b2c3…_shop`, and that full name is what you
put in your connection string.

## Logins

Each database gets exactly one login, created with it, named the same as the database. You
do not create users separately, and there is no step where a database exists but nothing
can reach it.

That login can reach exactly that database and nothing else:

- **MariaDB**: a user granted privileges on that schema alone, and only from `127.0.0.1`.
- **PostgreSQL**: a role that owns the database, with `CONNECT` revoked from `PUBLIC`.
  This matters more than it sounds — PostgreSQL grants every role access to every database
  by default, so the default is not safe on a shared server and WinPanel changes it.
- **MongoDB**: a `dbOwner` created inside the database itself, so its credentials are
  meaningless anywhere else. Access control is on from the very first start, which is what
  keeps WinPanel's MongoDB out of the category the internet is famous for finding open.

## Connecting

Creating a database shows you a **connection string** with the password already in it,
along with the host, port, database name and username separately — and, for MongoDB, the
auth source. That is the one moment the password is on screen, so copy it then.

```text
mysql://<name>:<password>@127.0.0.1:3306/<name>
postgresql://<name>:<password>@127.0.0.1:5432/<name>
mongodb://<name>:<password>@127.0.0.1:27017/<name>?authSource=<name>
```

Afterwards, **Connect** on any database reopens the same block with `PASSWORD` left as a
placeholder, and **Show password** fills the real one back in. The password is never lost —
it is in WinPanel's encrypted vault — and **New password** replaces it if it ever escapes.

MongoDB's `authSource` is not optional. Its login lives inside its own database rather than
in `admin`, and a driver that is not told so looks in `admin`, finds nothing, and reports
the password as wrong.

Because the servers are bound to loopback, these work from anything running on the same
machine — a website WinPanel hosts, a service you installed yourself, a scheduled task.
To reach one from another machine, put it behind something that authenticates; do not
open the port.

## Looking inside

Each database has an **Open** button, and you do not need pgAdmin, MySQL Workbench or
MongoDB Compass to see what is in it.

- **MariaDB and PostgreSQL** open in [Adminer](https://www.adminer.org/), already signed
  in — tables, rows, editing, and a SQL console. Adminer never sits on a public domain:
  WinPanel runs it on a private, loopback-only PHP server and proxies it behind the panel's
  own sign-in. The password never reaches your browser either — opening it mints a one-shot
  ticket that a small plugin swaps for the real credentials on the server side. Install
  **Database browser (Adminer)** from Settings to get this.
- **MongoDB** opens a browser built into the panel: collections, document counts, and the
  documents themselves with a JSON filter box. It **reads only**. MongoDB has no Adminer
  driver that works on Windows — the one it has needs a PECL extension PHP does not ship —
  so rather than leave MongoDB the one engine you cannot see into, WinPanel reads it
  directly.

Desktop tools still work if you prefer them, or if you want to write to MongoDB rather than
just read it. Paste the connection string into Compass, pgAdmin, DBeaver or `psql` and they
will connect — but only from the server itself, since the databases do not answer the
network.

## Allowances

Databases are something you sell, so they are something you can limit.

- **Per account** — on the **People** page, each customer has a *Databases* number. It
  counts every database they hold, across every engine, whether or not it belongs to one
  of their websites. New customers start at **0**, which keeps the whole feature out of
  their panel until you decide otherwise.
- **Per website** — a website can additionally be capped, so a customer with an allowance
  of ten cannot spend all ten on one site.

Leave either blank for no limit. Administrators and the owner are never limited.

## WordPress

Nothing changes. A WordPress site still creates its own MariaDB database during setup and
writes `wp-config.php` for it. That database now appears alongside every other one, and
changing its password from the panel rewrites `wp-config.php` in the same breath — so the
site does not go offline waiting for somebody to edit a file.

## If something goes wrong

- **"Installed but did not finish setting up"** — the program is on disk but WinPanel does
  not hold an administrative password for it, so it cannot manage anything. Reinstall it
  from Settings; existing data is left alone.
- **A database vanishes from the list** — WinPanel checks the server before listing, and
  drops its record for a database that is no longer there. A database server that is *down*
  is never mistaken for one whose databases are gone; nothing is removed in that case.
- **The server keeps stopping** — check **Server health**. WinPanel watches each database
  service, and can tell "somebody stopped this" from "an orphaned process is holding the
  port so it can never start", which is the failure that otherwise looks like nothing at
  all.
