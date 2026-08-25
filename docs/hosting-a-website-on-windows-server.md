---
title: How to put a website on your own Windows PC or server
description: >-
  What hosting a website on your own Windows PC or server involves, what it costs and what
  the words mean - written for people who are not sysadmins. No command line needed.
---

# How to put a website on your own Windows PC or server

Written for people who are not sysadmins. If you have a Windows machine - a rented server,
a box under a desk, or a spare PC at home - and you want your website, your customers'
websites or your company's email running on it, this page explains what is involved, in
plain words.

No command line is needed for any of it. Where a technical word is unavoidable it is
explained the first time, and there is a [glossary](#glossary-of-the-words-people-use) at
the bottom.

---

## What you are actually trying to do

Putting a website online means four separate things, which is why it feels harder than it
sounds. In order:

1. **The files have to live somewhere** - the pages, pictures and code that make up the
   site, sitting in a folder on the server.
2. **Something has to answer visitors** - a program that listens for people asking for
   your site and hands them the pages. This is the "web server".
3. **Your web address has to point at the machine** - so that typing `example.com` sends
   people to your server and not somewhere else. This is DNS.
4. **The padlock has to appear** - a certificate, so browsers show `https` and not "Not
   secure". These are free and automatic now; nobody should be paying for one or
   installing them by hand.

Add email, backups, and a way to let a client into their own site without letting them
into everyone else's, and you have described a **hosting control panel**. It is a website
you sign in to that does all of the above with buttons instead of commands.

[WinPanel](https://github.com/decerto/winpanel#readme) is one, it is free, and it runs on
Windows.

---

## "Can I even do this on Windows?"

Yes. This question comes up constantly and gets bad answers, so, clearly:

- **You can host a normal website on Windows.** Pages, images, contact forms, the lot.
- **You can host a modern web app on Windows** - the kind built with Node.js, which covers
  most sites a developer has built for you in the last decade.
- **You can host your own email on Windows**, with real mailboxes at your own domain.
- **You do not need to buy Plesk**, and you do not need to move to Linux.

What is true is that Windows does not come with any of this arranged for you. It comes
with IIS, which is Microsoft's web server, and IIS was designed for a different kind of
website than most people build today. The gap is what a control panel fills.

---

## What it costs

| | |
| --- | --- |
| **The server** | Whatever you already pay. A small Windows VPS is typically £15-£40 a month; a machine in your office is free apart from electricity; a PC you already own costs nothing. |
| **Windows licence** | Included if you rent; bought once if you own the hardware; already paid for if you are reusing a PC. |
| **WinPanel** | Free. No per-site fee, no per-customer fee, no licence key. |
| **Plesk, the paid alternative** | Roughly £10-£60 per server per month depending on edition. |
| **Certificates (the padlock)** | Free, issued and renewed automatically. |
| **Your domain name** | £8-£15 a year, from wherever you bought it. |

---

## Does it have to be Windows *Server*?

No. A Windows 11 PC will do - nothing here needs a Server edition, and a desktop machine
avoids the commonest problem of all, because IIS is not installed on it to fight over the
ports.

If that PC lives at home, the computer is rarely what limits you. Your internet connection
is. Three things to know before you rely on it:

- **It must not go to sleep.** A sleeping computer is an offline website. Set the power
  plan to never sleep, and turn off automatic restarts after updates.
- **Your address probably changes.** Home connections are usually given a new IP address
  from time to time, so the domain has to be updated when it does. A dynamic DNS service
  does that for you.
- **Some connections cannot host at all.** Many providers block the ports websites use, or
  share one address between many customers, in which case nothing from outside can reach
  you. Test it before planning around it.

Email is the one thing not to do from home: residential connections are blocked from
sending mail directly and are distrusted by other mail servers, so those messages will not
arrive whatever you configure.

---

## What it looks like in practice

**Adding a website** is one form. You say what kind of site it is - a simple one you will
upload files to, or one built from a code repository - and it is created, running, and
reachable immediately at a temporary address like `http://203.0.113.10:7001`. You do not
need a domain to start.

**Adding your domain** is typing it into a box. If your domain is at Cloudflare and you
have connected it, the panel offers to point the domain at the server for you, shows you
exactly what it is about to change, and does it when you agree. The padlock appears on its
own within a minute or two.

**Uploading files** is drag and drop, in the browser, with a proper editor for when you
need to change one line. No FTP program to configure.

**Adding email** is picking a mailbox name and a password. The panel then checks the
half-dozen invisible settings that decide whether your mail reaches people's inboxes
instead of their spam folder - and tells you in plain English which one is wrong and
offers to fix it.

**Giving a client access** is creating an account for them and assigning their site to it.
They see their site and nothing else. You can cap how many sites they may have and how
much space they get.

---

## Do I need a developer?

For the panel itself, no. Installing it is a normal Windows installer - next, next,
finish - and everything after that is a web page you click around in.

You will want a developer for the site itself if it is an application rather than a set of
pages, because somebody has to have written it. But the hosting, the domains, the
certificates, the mailboxes and the day-to-day are all yours.

If you got as far as installing Windows, you are already past the hard part.

---

## Things that will go wrong, and what they mean

| What you see | What it actually means | What to do |
| --- | --- | --- |
| "Not secure" in the address bar | The site has no certificate yet, usually because the domain is not pointing at the server yet | Check the domain first; the certificate follows on its own |
| The site was fine and now shows an error after a restart | The program behind the site did not come back up | The panel restarts it for you, and shows the reason it stopped |
| Your emails land in spam | One of the invisible DNS records - SPF, DKIM, DMARC - is missing or wrong | The email page checks all of them and offers to publish the missing ones |
| "This site can't be reached" on a brand-new domain | DNS changes take time to spread, up to a few hours | Use the temporary address meanwhile; it works immediately |
| The panel warns about the certificate the first time you sign in | You are reaching it by IP address, which no certificate can cover | Expected. Give the panel its own domain in Settings and the warning goes |
| Everything is down at once | Something is holding the ports the web server needs - usually IIS, which Windows enables by default | The Health page detects exactly this and offers to fix it |

---

## Glossary of the words people use

| Word | What it means |
| --- | --- |
| **Domain** | Your web address, like `example.com`. Rented yearly from a registrar. |
| **DNS** | The phone book that turns your domain into the server's number. Changing where a site lives means changing DNS. |
| **A record** | One line in that phone book: "this name is at this address." |
| **Nameservers** | Which phone book your domain uses. Cloudflare's are free and are what makes the automatic bits possible. |
| **SSL / TLS certificate** | The padlock. Free, automatic, renews itself. |
| **Web server** | The program that answers visitors. Here it is Caddy; on Windows you may have heard of IIS. |
| **Reverse proxy** | The receptionist. One program takes every visitor and passes them to whichever site or app they asked for. |
| **Node.js** | The technology most modern web applications are built with. Runs on Windows perfectly well. |
| **Windows Service** | A program Windows keeps running in the background, starting it at boot and restarting it if it stops. Each of your sites gets one. |
| **Port** | A numbered door on the server. Websites use 80 and 443; each of your apps gets a private one. |
| **Deploy** | Publishing a new version of a site. |
| **Control panel** | The website you sign in to that manages all of the above - this. |
| **Hosting** | Owning the machine the site lives on, instead of renting a slice of somebody else's. |
| **Mailbox** | An email account at your own domain, with its own password and storage limit. |
| **SPF, DKIM, DMARC** | Three DNS records that prove your email is really from you. Get them wrong and your mail goes to spam. |

---

## Common questions

### I have a Windows VPS. How do I get my website onto it?

Install WinPanel, sign in with the code the installer gives you, add a website, upload
your files or connect your repository, then add your domain. Nothing else needs installing
first.

### Can I host my own website instead of paying for hosting?

Yes, and that is usually the reason people end up here - one server can hold as many sites
as it has room for, at no extra cost per site.

### Can I host websites for my clients and charge them?

Yes. Give each client their own login, cap what they may use, and bill them however you
like. The licence explicitly permits it.

### Do I have to be good with computers?

You have to be comfortable installing a program on a server and following instructions on
a web page. You do not have to use the command line, edit configuration files or know what
a reverse proxy is.

### Is this safe to put on the internet?

The panel has two-factor sign-in, blocks addresses that keep guessing passwords, and keeps
a log of every sign-in. Use a long password, turn on two-factor, and keep the server's
Windows updates current.

### What if I get stuck?

[Ask on Discord](https://discord.gg/wT6mnfAnUD) - plain questions are welcome and nobody
will tell you to read the source code.

---

Related: [the full feature list](https://github.com/decerto/winpanel#readme) ·
[the technical version of this page](nodejs-hosting-on-windows-server.md) ·
[hosting a game server on Windows](game-servers-on-windows.md)
