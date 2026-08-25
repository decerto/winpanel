# Backups and recovery

WinPanel has two different backup systems. They solve different problems and have different owners.

## Website backups

Open a website and choose **Backup** to create a ZIP for that website. The archive contains:

- the website files currently stored on the server;
- a `winpanel-backup.json` manifest; and
- portable database exports for the website's MariaDB, MySQL-compatible, PostgreSQL or MongoDB databases.

MariaDB and PostgreSQL databases are exported as SQL. MongoDB is exported as newline-delimited JSON, with the collection name and document on each line.

The ZIP is a download, not a second hosting service. After creating it, download the archive and put it wherever you keep offsite copies: B2, S3, a USB drive, a NAS or another server. WinPanel does not currently ask for B2 or S3 credentials and does not upload website backups automatically.

Website backup access follows website ownership. A customer can download backups for websites they can access; an administrator cannot use the download route to read another customer's website unless the existing website access rules allow it.

## Panel backups

The owner can open **Backup** in the main navigation and choose **Back up now** or enable daily, weekly and monthly schedules. These are local compressed recovery snapshots stored under the panel's backup directory.

A panel snapshot includes the panel's program and data folders, configuration, hosted websites and game-server files. It is intended to recover this WinPanel installation after a damaging change or machine problem, not to replace a website's portable download.

Panel snapshots are owner-only. The owner can download one for external safekeeping and can restore one from the Backup page. A restore replaces the panel state, websites, game servers and configuration represented by that snapshot, then restarts the panel and its supporting services. The browser connection will briefly disappear while the agent restarts.

Create or download a panel snapshot before a major update. Keep at least one copy on a different device or server: a backup stored only on the machine it protects cannot help after that machine's disk fails.

## Database recovery

Website database exports are portable files inside the website ZIP. Restoring those exports into a database server is a separate database operation; the archive does not overwrite a live database automatically.

Panel snapshots preserve the local WinPanel installation and its data directory for machine recovery. They are not a replacement for a database's own production backup and retention policy.
