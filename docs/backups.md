# Backups and recovery

WinPanel has two different backup systems. They solve different problems and have different owners.

## Website backups

Open a website and choose **Backup** to create a ZIP for that website. The archive contains:

- the website files currently stored on the server;
- a `winpanel-backup.json` manifest; and
- portable database exports for the website's MariaDB, MySQL-compatible, PostgreSQL or MongoDB databases.

MariaDB and PostgreSQL databases are exported as SQL. MongoDB is exported as newline-delimited JSON, with the collection name and document on each line.

Creating the ZIP does not stop the website: it keeps serving visitors while its files are read. Installed dependencies (`node_modules`) are left out unless **Include dependencies (node_modules)** is ticked, which makes the archive much faster to build and much smaller.

The ZIP is a download, not a second hosting service. After creating it, download the archive and put it wherever you keep offsite copies: B2, S3, a USB drive, a NAS or another server. WinPanel does not currently ask for B2 or S3 credentials and does not upload website backups automatically.

Website backup access follows website ownership. A customer can download backups for websites they can access; an administrator cannot use the download route to read another customer's website unless the existing website access rules allow it.

## Panel backups

The owner can open **Backup** in the main navigation and choose **Back up now** or enable daily, weekly and monthly schedules. These are local compressed recovery snapshots stored under the panel's backup directory.

A panel snapshot includes every file in the panel installation folder, the complete hosted websites, the local database engine storage, and a consistent copy of the panel's SQLite database. Game-server files are optional because their data folders can be very large; the **Include game servers** checkbox applies to both **Back up now** and automatic snapshots, and is off by default for new schedules. Websites and databases are always included. Websites, supporting services and database services keep running throughout: a snapshot never takes hosted sites offline. Regenerable build caches such as `node_modules/.cache`, `.next/cache` and `.turbo` are left out, because the next deployment rebuilds them. Because the machine is still serving while the snapshot is read, a file can be rewritten or removed as it is copied; those few paths are listed in the job log and the rest of the snapshot is still written. The archive manifest records every website and database known to the panel, and creation fails if one of those records has no corresponding storage on disk.

### Dependencies

Installed dependencies (`node_modules`) are usually the great majority of the files on the server, and they are the main reason a backup takes a long time. They are left out by default and reinstalled by a deployment, so a restored website needs a redeploy before it runs again. Turn on **Include dependencies (node_modules)** to capture them anyway, for a snapshot that restores without one. Expect it to take considerably longer.

Panel snapshots are owner-only. The owner can download one for external safekeeping and can restore one from the Backup page. A restore replaces the panel state, websites, game servers and configuration represented by that snapshot, then restarts the panel and its supporting services. The browser connection will briefly disappear while the agent restarts.

Create or download a panel snapshot before a major update. Keep at least one copy on a different device or server: a backup stored only on the machine it protects cannot help after that machine's disk fails.

## Database recovery

Website database exports are portable files inside the website ZIP. Restoring those exports into a database server is a separate database operation; the archive does not overwrite a live database automatically.

Panel snapshots preserve the local WinPanel installation and its local database data for machine recovery. They do not reach into externally hosted databases such as MongoDB Atlas, and they are not a replacement for a database's own production backup and retention policy.
