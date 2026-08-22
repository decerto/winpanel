---
title: How to host WordPress on Windows
description: >-
  Run WordPress on Windows Server 2022/2025 or Windows 11 without IIS - PHP behind a
  web server, MariaDB for its data, and a one-click install with WinPanel.
image: /winpanel/banner.png
---

# How to host WordPress on Windows

WordPress is three things: some PHP code, a web server to run it, and a database to store
its content. None of that needs IIS, and none of it needs Linux. On Windows it runs the
same way it runs everywhere else — you just need the three parts and a way to start them
again after a reboot.

This page explains how WordPress actually runs on Windows, and the much shorter way to do
it with **[WinPanel](https://github.com/decerto/winpanel)**, a free control panel that sets
the whole thing up for you.

## The three parts

**PHP.** WordPress is written in PHP. On Windows the right build is the *Non-Thread-Safe*
one, run through FastCGI — which is what PHP's own documentation recommends for exactly
this. One thing to know: a single PHP process on Windows answers one request at a time,
so a real site runs a small pool of them and the web server shares requests across the
pool. PHP also needs Microsoft's Visual C++ runtime installed, or it will not start at all.

**A web server.** Something has to take the request for a page and hand it to PHP, then
serve the images, CSS and JavaScript straight off disk. That is all a "reverse proxy" or
"web server" means here. WinPanel uses Caddy, which also sorts out the free HTTPS
certificate and renews it for you.

**A database.** WordPress keeps every post, page and setting in a MySQL-compatible
database. MariaDB is the free, drop-in one, and it runs happily as a Windows service.

## The hard way

Doing it by hand means: download and unpack PHP, install the C++ runtime it needs, write a
`php.ini`, work out how to keep a pool of `php-cgi` processes running across reboots,
configure a web server to route PHP to them, install and initialise MariaDB, create a
database and a login that can only reach that one database, download WordPress, and write
a `wp-config.php` that ties it together. Every one of those is a place to get it subtly
wrong, and none of them is the website you actually wanted.

## The WinPanel way

WinPanel does all of it from one button.

1. [Install WinPanel](https://github.com/decerto/winpanel#installing) and open it.
2. Press **Add a website** and choose **WordPress**.
3. Give it a name and, if you have one, a domain.

The panel downloads the current WordPress from wordpress.org while you watch, creates a
MariaDB database and a login scoped to just that database, writes the configuration, and
starts everything as services that come back on their own after a reboot. When it
finishes it opens WordPress' own one-minute setup — the page where you name the site and
make your login — and from there it is an ordinary WordPress.

The database server (MariaDB) and PHP are ordinary programs in the panel's **Programs**
list, so you can install them once and use them for as many sites as you like — WordPress
or your own PHP code. Each site's **Databases** tab shows what it has, and a database
browser is built into the panel, so you can look at and edit a site's tables without
installing anything else.

## Your own PHP code

WordPress is just the common case. A site written in PHP works the same way: choose **A
PHP website** when you add a site, or point the panel at a Git repository — a repository
with an `index.php` is recognised automatically, including a `public` web root and a
Composer install on each deploy when the project has a `composer.json`.

## What WinPanel is

A free, self-hosted control panel for Windows Server 2022/2025 and Windows 11 Home or Pro.
It manages websites, game servers, HTTPS, DNS, email and customer accounts from one web
page, with no IIS and no command line. See [the repository](https://github.com/decerto/winpanel) for the
full picture, [the hosting guide](hosting-a-website-on-windows-server.html) for the
no-jargon version, or [the game server guide](game-servers-on-windows.html) for Minecraft
and Steam dedicated servers.
