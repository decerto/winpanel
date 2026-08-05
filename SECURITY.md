# Security policy

WinPanel holds the keys to a whole server: TLS private keys, Cloudflare API tokens, mail
credentials and the panel's own sessions. Vulnerabilities are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository
(*Security* → *Report a vulnerability*). That keeps the discussion private until a fix
exists.

Helpful things to include:

- what an attacker can reach that they should not,
- the steps to reproduce it, and
- the WinPanel version and Windows build you saw it on.

You will get an acknowledgement, and an honest answer about whether it is being fixed.
Please give a reasonable window for a fix before disclosing publicly.

## Scope

In scope:

- authentication, session handling, two-factor and recovery codes,
- authorisation between accounts — anything letting one customer reach another's website,
  files or mailboxes,
- path handling in the file manager and deployments,
- the secret vault and anything that could leak a stored token or key,
- the installer and the update path.

Out of scope:

- vulnerabilities in Caddy, Stalwart or Node.js themselves — report those upstream, though
  do tell us if WinPanel ships an affected version,
- anything requiring Administrator access to the server already, since that is game over
  by definition,
- missing hardening that is not exploitable on its own.

## Supported versions

Only the latest release is supported. WinPanel updates itself in place, so the fix for
anything reported here ships in the next release.
