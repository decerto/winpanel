import fs from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from '@winpanel/shared';

/**
 * Starter files for a site created without any code.
 *
 * The point is that a brand new site answers with something immediately. An
 * empty folder produces a bare 404, which is indistinguishable from a broken
 * web server config — so the first thing a new user sees would be a failure
 * they have no way to diagnose.
 *
 * Nothing here is ever written over an existing file: these folders belong to
 * the user from the moment they exist.
 */

/** Escapes text for interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function starterPage(displayName: string): string {
  const name = escapeHtml(displayName);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0d1117;
        color: #e6edf3;
      }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      h1 { margin: 0 0 0.5rem; font-size: 1.75rem; letter-spacing: -0.02em; }
      p { margin: 0.5rem 0; color: #9198a1; }
      code {
        font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
        font-size: 0.875em;
        background: rgba(255, 255, 255, 0.06);
        padding: 0.15em 0.4em;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p>Your website is up and running.</p>
      <p>
        Replace <code>index.html</code> in this site&rsquo;s
        <code>public</code> folder with your own files. You can do that from
        the Files tab in the control panel.
      </p>
    </main>
  </body>
</html>
`;
}

/**
 * The PHP starter page. Served by the worker pool rather than straight off
 * disk, so it also proves the pool is answering — and prints the PHP version
 * as a quiet confirmation that the right runtime is in front of the site.
 */
function phpStarterPage(displayName: string): string {
  const name = escapeHtml(displayName);

  return `<?php
// WinPanel starter page. Replace index.php with your own files — you can do
// that from the Files tab in the control panel.
$name = '${name}';
?><!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title><?= htmlspecialchars($name) ?></title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0d1117;
        color: #e6edf3;
      }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      h1 { margin: 0 0 0.5rem; font-size: 1.75rem; letter-spacing: -0.02em; }
      p { margin: 0.5rem 0; color: #9198a1; }
      code {
        font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
        font-size: 0.875em;
        background: rgba(255, 255, 255, 0.06);
        padding: 0.15em 0.4em;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1><?= htmlspecialchars($name) ?></h1>
      <p>Your PHP website is up and running on PHP <?= PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION ?>.</p>
      <p>
        Replace <code>index.php</code> in this site&rsquo;s <code>public</code>
        folder with your own files. You can do that from the Files tab in the
        control panel.
      </p>
    </main>
  </body>
</html>
`;
}

const STARTER_SERVER = `const http = require('node:http');

// WinPanel supplies the port. Do not hard-code one: the panel assigns a free
// port per site and routes traffic to it.
const port = Number(process.env.PORT) || 3000;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<h1>Hello from Node</h1><p>Edit index.js to change this.</p>');
});

// Bind to loopback only; Caddy is what faces the internet.
server.listen(port, '127.0.0.1', () => {
  console.log('Listening on port ' + port);
});
`;

/** Writes a file only if it is not already there. Returns true if written. */
async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
  try {
    await fs.writeFile(file, contents, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Lays down starter files in a site's public folder.
 *
 * @returns the relative paths that were created.
 */
export async function scaffoldSite(options: {
  publicDir: string;
  runtime: Runtime;
  displayName: string;
}): Promise<string[]> {
  await fs.mkdir(options.publicDir, { recursive: true });
  const written: string[] = [];

  const add = async (name: string, contents: string): Promise<void> => {
    if (await writeIfAbsent(path.join(options.publicDir, name), contents)) written.push(name);
  };

  switch (options.runtime) {
    case 'static':
      await add('index.html', starterPage(options.displayName));
      break;

    case 'node':
      await add('index.js', STARTER_SERVER);
      await add(
        'package.json',
        `${JSON.stringify(
          { name: 'site', private: true, version: '1.0.0', main: 'index.js' },
          null,
          2,
        )}\n`,
      );
      break;

    case 'php':
      await add('index.php', phpStarterPage(options.displayName));
      break;

    // A proxy site points at something already running, and a .NET site is
    // published from a build elsewhere. Neither has anything useful to seed.
    case 'dotnet':
    case 'proxy':
      break;
  }

  return written;
}
