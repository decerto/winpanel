import fs from 'node:fs/promises';
import path from 'node:path';
import type { BuildStep, PackageManager, SiteManifest, StepCommand } from '@winpanel/shared';
import {
  MANIFEST_FILENAME,
  SiteManifest as SiteManifestSchema,
  validateRelativePath,
} from '@winpanel/shared';

/**
 * Works out how to build and run a project by looking at it.
 *
 * The goal is that the user confirms rather than configures. Detection is
 * therefore explicit about confidence and always explains itself in plain
 * English, because a wrong guess presented confidently is worse than a
 * question.
 *
 * The layout this is built around first is the common one: a `frontend/` and a
 * `backend/` folder in one repository, where the frontend builds its output
 * into the backend folder and only the backend runs as a process, serving the
 * built files itself.
 */

export type RepoShape =
  | 'single-app'
  | 'workspace-monorepo'
  | 'multi-folder'
  | 'frontend-builds-into-backend'
  | 'static'
  | 'unknown';

export interface FolderRole {
  path: string;
  kind: 'server' | 'frontend' | 'static' | 'unknown';
  framework: string | null;
  packageManager: PackageManager | null;
  /** Where this folder's build output lands, relative to the repo root. */
  buildOutput: string | null;
}

export interface DetectionResult {
  shape: RepoShape;
  /** 0..1. Below ~0.6 the wizard should ask rather than assume. */
  confidence: number;
  /** One sentence the user reads, e.g. "This repo has a frontend and a backend." */
  summary: string;
  folders: FolderRole[];
  manifest: SiteManifest;
  /** Notes worth surfacing, in plain English. */
  notes: string[];
  /** True when the manifest came from the repo rather than from detection. */
  fromManifestFile: boolean;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  engines?: { node?: string };
  main?: string;
  type?: string;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Determines the package manager from the lockfile, per folder. */
export async function detectPackageManager(dir: string): Promise<PackageManager | null> {
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(dir, 'bun.lockb'))) return 'bun';
  if (await exists(path.join(dir, 'package-lock.json'))) return 'npm';

  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'));
  if (pkg?.packageManager) {
    const name = pkg.packageManager.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun') return name;
  }
  return null;
}

/** Reads the requested Node version from the usual places. */
export async function detectNodeVersion(dir: string): Promise<string | null> {
  for (const file of ['.nvmrc', '.node-version']) {
    const content = await readText(path.join(dir, file));
    if (content) {
      const cleaned = content.trim().replace(/^v/, '');
      if (cleaned) return cleaned;
    }
  }

  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'));
  const engine = pkg?.engines?.node;
  if (engine) {
    const match = /(\d+)(?:\.\d+)*/.exec(engine);
    if (match?.[1]) return match[1];
  }
  return null;
}

const SERVER_DEPENDENCIES = [
  'express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'restify', 'h3',
];

const FRONTEND_MARKERS: Array<{ file: RegExp; framework: string }> = [
  { file: /^nuxt\.config\.(ts|js|mjs)$/, framework: 'nuxt' },
  { file: /^next\.config\.(ts|js|mjs)$/, framework: 'next' },
  { file: /^vite\.config\.(ts|js|mts|mjs)$/, framework: 'vite' },
  { file: /^astro\.config\.(ts|js|mjs)$/, framework: 'astro' },
  { file: /^svelte\.config\.(ts|js|mjs)$/, framework: 'svelte' },
  { file: /^angular\.json$/, framework: 'angular' },
  { file: /^vue\.config\.(ts|js)$/, framework: 'vue-cli' },
];

/**
 * Extracts a build output directory from a frontend config file.
 *
 * Deliberately a regular expression rather than executing the config: these
 * files come from an untrusted repository and must never be evaluated. A
 * regex can be defeated by an unusual config, which is why detection reports
 * confidence and lets the user correct it.
 *
 * The path is not always a bare string. `outDir: fileURLToPath(new
 * URL('../server/web-dist', import.meta.url))` is a common way to write it,
 * so the first quoted string on the value's own line is taken rather than
 * insisting the quote follow the colon immediately.
 */
export function extractOutputDir(configSource: string): string | null {
  // `[^,\n]*?` skips a wrapping call without ever crossing a comma or a line
  // break, so it cannot wander off and pick up an unrelated string.
  const patterns = [
    /outDir\s*:\s*[^,\n]*?['"`]([^'"`]+)['"`]/,
    /outputDir\s*:\s*[^,\n]*?['"`]([^'"`]+)['"`]/,
    /outputPath\s*:\s*[^,\n]*?['"`]([^'"`]+)['"`]/,
    /build\s*:\s*\{[^}]*outDir\s*:\s*[^,\n]*?['"`]([^'"`]+)['"`]/s,
    /"outputPath"\s*:\s*"([^"]+)"/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(configSource);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function classifyFolder(rootDir: string, relative: string): Promise<FolderRole | null> {
  const dir = path.join(rootDir, relative);
  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'));

  const entries = await fs.readdir(dir).catch(() => [] as string[]);

  let framework: string | null = null;
  let buildOutput: string | null = null;

  for (const marker of FRONTEND_MARKERS) {
    const found = entries.find((entry) => marker.file.test(entry));
    if (!found) continue;

    framework = marker.framework;
    const source = await readText(path.join(dir, found));
    if (source) {
      const outDir = extractOutputDir(source);
      if (outDir) {
        // Resolve relative to the folder holding the config, then express it
        // relative to the repository root.
        const absolute = path.resolve(dir, outDir);
        buildOutput = path.relative(rootDir, absolute).split(path.sep).join('/');
      }
    }
    break;
  }

  if (!pkg && !framework) {
    if (entries.includes('index.html')) {
      return { path: relative, kind: 'static', framework: null, packageManager: null, buildOutput: null };
    }
    return null;
  }

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const hasServerDep = SERVER_DEPENDENCIES.some((dep) => dep in deps);
  const hasStartScript = Boolean(pkg?.scripts?.['start']);

  const kind: FolderRole['kind'] =
    framework && !hasServerDep
      ? 'frontend'
      : hasServerDep || hasStartScript
        ? 'server'
        : framework
          ? 'frontend'
          : 'unknown';

  return {
    path: relative,
    kind,
    framework: framework ?? (hasServerDep ? 'node-server' : null),
    packageManager: await detectPackageManager(dir),
    buildOutput,
  };
}

const CANDIDATE_FOLDERS = [
  'backend', 'server', 'api',
  'frontend', 'client', 'web', 'ui', 'app',
];

/** Where a Node app's entry file usually lives, in the order worth trying. */
const ENTRY_CANDIDATES = [
  'index.js', 'index.mjs', 'index.cjs',
  'server.js', 'server.mjs', 'app.js', 'main.js',
  'src/index.js', 'src/index.mjs', 'src/server.js', 'src/app.js', 'src/main.js',
  'dist/index.js', 'dist/index.mjs', 'dist/server.js', 'dist/main.js',
  'build/index.js', 'build/server.js',
  'app/index.js', 'app/server.js',
];

/**
 * Pulls the file a `start` script runs out of the script itself.
 *
 * `start` is the most reliable statement of intent there is: it is what the
 * author runs, so it names the real entry file even when `main` is missing or
 * stale. Flags and env-var prefixes (`cross-env NODE_ENV=production node
 * dist/main.js`) are skipped by taking the first plain `.js` argument.
 */
export function entryFromStartScript(script: string): string | null {
  for (const raw of script.split(/\s+/)) {
    if (raw.startsWith('-')) continue;
    const token = raw.replace(/^["']|["']$/g, '');
    if (/\.[cm]?js$/.test(token)) return token.replace(/\\/g, '/');
  }
  return null;
}

/**
 * Works out which file starts a Node app in `dir`.
 *
 * Without this the manifest carries no entry at all and the service falls back
 * to `index.js` in the application folder, so anything laid out as
 * `src/index.js` dies at start-up with "Cannot find module" naming a file the
 * user never chose. Candidates are preferred in the order they are checked
 * against the disk, because a wrong guess produces exactly that same failure.
 */
export async function detectEntryPoint(dir: string): Promise<string | undefined> {
  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'));

  // The repository is untrusted, so an entry that escapes the folder (or is
  // absolute) is discarded rather than written into the manifest.
  const clean = (candidate: string): string | null => {
    const checked = validateRelativePath(candidate.replace(/^\.\//, ''));
    return checked.ok && checked.value.length > 0 ? checked.value : null;
  };

  const declared: string[] = [];
  const start = pkg?.scripts?.['start'];
  const fromScript = start ? entryFromStartScript(start) : null;
  if (fromScript) declared.push(fromScript);
  if (pkg?.main) declared.push(pkg.main);

  for (const candidate of [...declared, ...ENTRY_CANDIDATES]) {
    const relative = clean(candidate);
    if (relative && (await exists(path.join(dir, relative)))) return relative;
  }

  // Nothing is on disk yet. A declared entry still beats a guess: it is
  // usually a build output that only appears once the build has run.
  for (const candidate of declared) {
    const relative = clean(candidate);
    if (relative) return relative;
  }

  return undefined;
}

function startupFileNote(folder: string): string {
  return (
    `The panel could not tell which file starts the ${folder} folder, so it will try ` +
    'index.js. If that is not right, set the startup file on the Application page.'
  );
}

/** The arguments that install a project's packages, per package manager. */
export function installArgs(manager: PackageManager, production: boolean): string[] {
  if (manager === 'npm') return production ? ['ci', '--omit=dev'] : ['install'];
  if (manager === 'pnpm') return production ? ['install', '--prod'] : ['install'];
  if (manager === 'yarn') return production ? ['install', '--production'] : ['install'];
  return production ? ['install', '--production'] : ['install'];
}

/** The arguments that run a project's build script. */
export function buildArgs(manager: PackageManager): string[] {
  return manager === 'npm' ? ['run', 'build'] : ['run', 'build'];
}

/**
 * Inspects a checked-out repository and proposes how to build and run it.
 */
export async function detectApp(rootDir: string): Promise<DetectionResult> {
  const notes: string[] = [];

  // A manifest committed to the repo always wins. That is the whole point of
  // committing it: subsequent deploys need no decisions at all.
  const manifestPath = path.join(rootDir, MANIFEST_FILENAME);
  const existing = await readJson<unknown>(manifestPath);
  if (existing) {
    const parsed = SiteManifestSchema.safeParse(existing);
    if (parsed.success) {
      return {
        shape: 'single-app',
        confidence: 1,
        summary: `Using the ${MANIFEST_FILENAME} file already in this project.`,
        folders: [],
        manifest: parsed.data,
        notes: [`Settings were read from ${MANIFEST_FILENAME} in your project.`],
        fromManifestFile: true,
      };
    }
    notes.push(
      `The ${MANIFEST_FILENAME} file in this project could not be read, so settings were ` +
        'worked out automatically instead.',
    );
  }

  const rootPkg = await readJson<PackageJson>(path.join(rootDir, 'package.json'));
  const rootEntries = await fs.readdir(rootDir).catch(() => [] as string[]);

  // Classify every plausible folder.
  const folders: FolderRole[] = [];
  for (const candidate of CANDIDATE_FOLDERS) {
    if (!rootEntries.includes(candidate)) continue;
    const role = await classifyFolder(rootDir, candidate);
    if (role) folders.push(role);
  }

  const rootRole = await classifyFolder(rootDir, '');
  const nodeVersion = await detectNodeVersion(rootDir);

  /*
   * A PHP entry point settles it before the Node layouts get a say. Plenty of
   * PHP projects also carry a package.json — a theme build, a frontend
   * toolchain — so checking only after the Node branches would misread every
   * one of them as a Node app. An index.php is the signal no Node app has.
   */
  const php = await detectPhp(rootDir);
  if (php) {
    notes.push(...php.notes);
    return {
      shape: 'single-app',
      confidence: php.confidence,
      summary: php.summary,
      folders: [{ path: '', kind: 'server', framework: 'php', packageManager: null, buildOutput: null }],
      manifest: SiteManifestSchema.parse({
        runtime: 'php',
        app: { cwd: php.documentRoot },
        steps: php.steps,
        // PHP is never an SPA in the Node sense; its own index.php routes.
        spaFallback: false,
      }),
      notes,
      fromManifestFile: false,
    };
  }

  const serverFolders = folders.filter((f) => f.kind === 'server');
  const frontendFolders = folders.filter((f) => f.kind === 'frontend');

  // The strongest signal available: a frontend whose build output lands inside
  // a sibling folder that is itself a server.
  const buildsIntoServer = frontendFolders.find((frontend) =>
    serverFolders.some(
      (server) =>
        frontend.buildOutput !== null &&
        (frontend.buildOutput === server.path ||
          frontend.buildOutput.startsWith(`${server.path}/`)),
    ),
  );

  if (buildsIntoServer && serverFolders.length > 0) {
    const server = serverFolders.find(
      (s) =>
        buildsIntoServer.buildOutput === s.path ||
        buildsIntoServer.buildOutput?.startsWith(`${s.path}/`),
    )!;

    const frontendManager = buildsIntoServer.packageManager ?? 'npm';
    const serverManager = server.packageManager ?? 'npm';

    const steps: BuildStep[] = [
      {
        name: 'Install frontend packages',
        cwd: buildsIntoServer.path,
        command: frontendManager as StepCommand,
        args: installArgs(frontendManager, false),
        optional: false,
        env: {},
      },
      {
        name: 'Build the frontend',
        cwd: buildsIntoServer.path,
        command: frontendManager as StepCommand,
        args: buildArgs(frontendManager),
        optional: false,
        env: {},
      },
      {
        name: 'Install backend packages',
        cwd: server.path,
        command: serverManager as StepCommand,
        args: installArgs(serverManager, true),
        optional: false,
        env: {},
      },
    ];

    // If the build output is ignored by git, a "prebuilt" deploy would ship an
    // empty folder and serve a blank page for no visible reason.
    const gitignore = (await readText(path.join(rootDir, '.gitignore'))) ?? '';
    const outputIgnored = buildsIntoServer.buildOutput
      ? gitignore
          .split(/\r?\n/)
          .map((line) => line.trim())
          .some(
            (line) =>
              line.length > 0 &&
              !line.startsWith('#') &&
              buildsIntoServer.buildOutput!.includes(line.replace(/^\/+|\/+$/g, '')),
          )
      : false;

    if (outputIgnored) {
      notes.push(
        'Your built frontend is not stored in the repository, so it will be built here ' +
          'on the server each time you deploy.',
      );
    }

    const entry = await detectEntryPoint(path.join(rootDir, server.path));
    if (!entry) notes.push(startupFileNote(server.path));

    const manifest = SiteManifestSchema.parse({
      runtime: 'node',
      nodeVersion: nodeVersion ?? undefined,
      packageManager: serverManager,
      buildLocation: outputIgnored ? 'server' : 'server',
      steps,
      app: {
        cwd: server.path,
        entry,
        portEnvVar: 'PORT',
        healthCheckPath: '/',
      },
      // The backend serves the built frontend itself and has its own catch-all
      // route, so a second fallback at the web-server layer would double-handle
      // requests and hide real API 404s.
      spaFallback: false,
      websockets: await hasWebsockets(path.join(rootDir, server.path)),
    });

    notes.push(
      `Your frontend builds into the ${server.path} folder, and ${server.path} serves it.`,
    );

    return {
      shape: 'frontend-builds-into-backend',
      confidence: 0.95,
      summary: `This project has a ${buildsIntoServer.path} and a ${server.path}. The ${buildsIntoServer.path} will be built first, then ${server.path} runs your site.`,
      folders,
      manifest,
      notes,
      fromManifestFile: false,
    };
  }

  // Workspace monorepo.
  const hasWorkspaces =
    Boolean(rootPkg?.workspaces) ||
    rootEntries.includes('pnpm-workspace.yaml') ||
    rootEntries.includes('turbo.json');

  if (hasWorkspaces && serverFolders.length > 0) {
    const server = serverFolders[0]!;
    const manager = (await detectPackageManager(rootDir)) ?? 'npm';
    const entry = await detectEntryPoint(path.join(rootDir, server.path));
    if (!entry) notes.push(startupFileNote(server.path));

    return {
      shape: 'workspace-monorepo',
      confidence: 0.7,
      summary: `This project contains several packages. The ${server.path} folder looks like the one that runs.`,
      folders,
      manifest: SiteManifestSchema.parse({
        runtime: 'node',
        nodeVersion: nodeVersion ?? undefined,
        packageManager: manager,
        steps: [
          {
            name: 'Install packages',
            cwd: '',
            command: manager,
            args: installArgs(manager, false),
          },
          { name: 'Build', cwd: '', command: manager, args: buildArgs(manager) },
        ],
        app: {
          cwd: server.path,
          entry,
          portEnvVar: 'PORT',
          healthCheckPath: '/',
        },
        spaFallback: false,
        websockets: await hasWebsockets(path.join(rootDir, server.path)),
      }),
      notes,
      fromManifestFile: false,
    };
  }

  // Single app at the repository root.
  if (rootRole) {
    const manager = (await detectPackageManager(rootDir)) ?? 'npm';
    const framework = rootRole.framework;

    if (rootRole.kind === 'static') {
      return {
        shape: 'static',
        confidence: 0.85,
        summary: 'This looks like a plain website with no build step.',
        folders: [rootRole],
        manifest: SiteManifestSchema.parse({
          runtime: 'static',
          staticRoot: '',
          spaFallback: false,
        }),
        notes,
        fromManifestFile: false,
      };
    }

    const isNuxt = framework === 'nuxt';
    const isFrontendOnly = rootRole.kind === 'frontend' && !isNuxt;

    if (isFrontendOnly) {
      const outputDir = rootRole.buildOutput ?? 'dist';
      return {
        shape: 'single-app',
        confidence: 0.8,
        summary: `This looks like a ${framework ?? 'web'} app. It will be built, then served as files.`,
        folders: [rootRole],
        manifest: SiteManifestSchema.parse({
          runtime: 'static',
          nodeVersion: nodeVersion ?? undefined,
          packageManager: manager,
          steps: [
            { name: 'Install packages', cwd: '', command: manager, args: installArgs(manager, false) },
            { name: 'Build', cwd: '', command: manager, args: buildArgs(manager) },
          ],
          staticRoot: outputDir,
          // A built single-page app served as static files does need the
          // fallback, or refreshing on a sub-page returns 404.
          spaFallback: true,
        }),
        notes,
        fromManifestFile: false,
      };
    }

    const steps: BuildStep[] = [
      {
        name: 'Install packages',
        cwd: '',
        command: manager as StepCommand,
        args: installArgs(manager, false),
        optional: false,
        env: {},
      },
    ];

    if (rootPkg?.scripts?.['build']) {
      steps.push({
        name: 'Build',
        cwd: '',
        command: manager as StepCommand,
        args: buildArgs(manager),
        optional: false,
        env: {},
      });
    }

    return {
      shape: 'single-app',
      confidence: 0.85,
      summary: isNuxt
        ? 'This looks like a Nuxt app. It will be built, then run as a website.'
        : 'This looks like a Node app that runs as a website.',
      folders: [rootRole],
      manifest: SiteManifestSchema.parse({
        runtime: 'node',
        nodeVersion: nodeVersion ?? undefined,
        packageManager: manager,
        steps,
        app: {
          cwd: '',
          entry: isNuxt ? '.output/server/index.mjs' : await detectEntryPoint(rootDir),
          // Nuxt's server reads a different variable than everything else.
          portEnvVar: isNuxt ? 'NITRO_PORT' : 'PORT',
          healthCheckPath: '/',
        },
        spaFallback: false,
        websockets: await hasWebsockets(rootDir),
      }),
      notes,
      fromManifestFile: false,
    };
  }

  /*
   * A repository whose only runnable thing lives in a sub-folder.
   *
   * Nothing at the root says how to build this, and no frontend build output
   * could be traced into the server folder - but a sub-folder plainly runs,
   * and calling the whole project unrecognised here is the worst outcome
   * available: the site is created with no build steps and no entry file, so
   * it deploys, installs nothing, and dies at start-up asking for index.js, a
   * file the user never chose.
   */
  const backendNamed = new Set(['backend', 'server', 'api']);
  const runnable =
    serverFolders.length > 0
      ? serverFolders
      : // A backend-named folder with a package.json but neither a start
        // script nor a recognised server package still runs this site: no
        // other folder here is a candidate for it.
        folders.filter((f) => f.kind === 'unknown' && backendNamed.has(f.path));

  if (runnable.length > 0) {
    // CANDIDATE_FOLDERS is ordered, so the first match is the most likely.
    const server = runnable[0]!;
    const serverManager = server.packageManager ?? 'npm';
    const steps: BuildStep[] = [];

    for (const frontend of frontendFolders) {
      const manager = frontend.packageManager ?? 'npm';
      steps.push(
        {
          name: `Install ${frontend.path} packages`,
          cwd: frontend.path,
          command: manager as StepCommand,
          args: installArgs(manager, false),
          optional: false,
          env: {},
        },
        {
          name: `Build ${frontend.path}`,
          cwd: frontend.path,
          command: manager as StepCommand,
          args: buildArgs(manager),
          optional: false,
          env: {},
        },
      );
    }

    steps.push({
      name: `Install ${server.path} packages`,
      cwd: server.path,
      command: serverManager as StepCommand,
      args: installArgs(serverManager, true),
      optional: false,
      env: {},
    });

    const entry = await detectEntryPoint(path.join(rootDir, server.path));
    if (!entry) notes.push(startupFileNote(server.path));

    if (frontendFolders.length > 0) {
      notes.push(
        `Where ${frontendFolders.map((f) => f.path).join(' and ')} builds to could not be read ` +
          `from its config, so check that ${server.path} serves the built files.`,
      );
    }

    const others = runnable.slice(1).map((f) => f.path);
    if (others.length > 0) {
      notes.push(
        `${others.join(' and ')} could also run this site. The ${server.path} folder was ` +
          'chosen; change the application root on the next screen if that is wrong.',
      );
    }

    return {
      shape: 'multi-folder',
      confidence: others.length > 0 ? 0.45 : 0.6,
      summary: `The ${server.path} folder looks like the one that runs this site.`,
      folders,
      manifest: SiteManifestSchema.parse({
        runtime: 'node',
        nodeVersion: nodeVersion ?? undefined,
        packageManager: serverManager,
        steps,
        app: {
          cwd: server.path,
          entry,
          portEnvVar: 'PORT',
          healthCheckPath: '/',
        },
        spaFallback: false,
        websockets: await hasWebsockets(path.join(rootDir, server.path)),
      }),
      notes,
      fromManifestFile: false,
    };
  }

  /*
   * A repository that is only a frontend, kept in a sub-folder. Nothing runs
   * as a process: it is built, and the built files are served.
   */
  if (frontendFolders.length === 1) {
    const frontend = frontendFolders[0]!;
    const manager = frontend.packageManager ?? 'npm';
    const staticRoot = frontend.buildOutput ?? `${frontend.path}/dist`;

    if (!frontend.buildOutput) {
      notes.push(
        `Where ${frontend.path} builds to could not be read from its config, so ` +
          `${staticRoot} was assumed. Change the document root if that is wrong.`,
      );
    }

    return {
      shape: 'multi-folder',
      confidence: 0.6,
      summary: `This project is a ${frontend.framework ?? 'web'} app in the ${frontend.path} folder. It will be built, then served as files.`,
      folders,
      manifest: SiteManifestSchema.parse({
        runtime: 'static',
        nodeVersion: nodeVersion ?? undefined,
        packageManager: manager,
        steps: [
          {
            name: `Install ${frontend.path} packages`,
            cwd: frontend.path,
            command: manager,
            args: installArgs(manager, false),
          },
          {
            name: `Build ${frontend.path}`,
            cwd: frontend.path,
            command: manager,
            args: buildArgs(manager),
          },
        ],
        staticRoot,
        spaFallback: true,
      }),
      notes,
      fromManifestFile: false,
    };
  }

  return {
    shape: 'unknown',
    confidence: 0,
    summary: 'This project could not be recognised automatically.',
    folders,
    manifest: SiteManifestSchema.parse({}),
    notes: [
      'The panel could not work out how to build this project. You can fill in the ' +
        'details yourself on the next screen.',
    ],
    fromManifestFile: false,
  };
}

interface PhpDetection {
  /** The web root relative to the repository root. '' or 'public'. */
  documentRoot: string;
  confidence: number;
  summary: string;
  steps: BuildStep[];
  notes: string[];
}

/**
 * Works out whether a repository is a PHP website and, if so, where its web
 * root is.
 *
 * Returns null for anything that is not plainly PHP. The layouts recognised
 * are the two that cover nearly everything: a `public/index.php` (Laravel and
 * most frameworks keep their web root in `public`), and an `index.php` at the
 * root (WordPress, classic sites). A `composer.json` without either index is
 * treated as PHP only when there is no competing Node signal, which the
 * caller has already ruled out by the time this runs.
 */
export async function detectPhp(rootDir: string): Promise<PhpDetection | null> {
  const notes: string[] = [];
  const steps: BuildStep[] = [];

  const rootIndex = await exists(path.join(rootDir, 'index.php'));
  const publicIndex = await exists(path.join(rootDir, 'public', 'index.php'));
  const composerJson = await readJson<{ require?: Record<string, string> }>(
    path.join(rootDir, 'composer.json'),
  );

  if (!rootIndex && !publicIndex && !composerJson) return null;

  // WordPress is recognised so the wizard can offer the WordPress preset,
  // which sets up its database and config instead of treating it as plain PHP.
  const isWordPress =
    (await exists(path.join(rootDir, 'wp-config-sample.php'))) ||
    (await exists(path.join(rootDir, 'wp-content')));
  if (isWordPress) {
    notes.push(
      'This looks like WordPress. Choosing WordPress when you add the site sets up ' +
        'its database and configuration for you.',
    );
  }

  // Framework convention wins over the root: a `public` folder with its own
  // index.php is the web root, and serving the repository root instead would
  // expose the app's config and vendor files.
  const documentRoot = publicIndex ? 'public' : '';

  // Composer packages are installed on deploy when the project asks for them,
  // so a fresh checkout has its dependencies in place before it runs.
  if (composerJson) {
    steps.push({
      name: 'Install Composer packages',
      cwd: '',
      command: 'composer',
      args: ['install', '--no-dev', '--no-interaction', '--prefer-dist'],
      optional: false,
      env: {},
    });
  }

  return {
    documentRoot,
    confidence: rootIndex || publicIndex ? 0.85 : 0.6,
    summary: isWordPress
      ? 'This looks like a WordPress site.'
      : 'This looks like a PHP website.',
    steps,
    notes,
  };
}

/** Detects WebSocket use, which forces blue/green rather than load balancing. */
async function hasWebsockets(dir: string): Promise<boolean> {
  const pkg = await readJson<PackageJson>(path.join(dir, 'package.json'));
  if (!pkg) return false;

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return 'socket.io' in deps || 'ws' in deps || '@socket.io/redis-adapter' in deps;
}
