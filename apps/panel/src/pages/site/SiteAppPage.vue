<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Boxes,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Package,
  Play,
  Power,
  RefreshCw,
  Save,
  Terminal,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import { LOG_LEVEL_CLASS, useJobLog } from '../../lib/job-log';
import AlertMessage from '../../components/AlertMessage.vue';
import PathPicker from '../../components/PathPicker.vue';

/**
 * The application: what runs it, and the three buttons you need at 2am.
 *
 * Restarting, reinstalling packages and running a script are the operations
 * that otherwise force someone onto a remote desktop session. They are jobs on
 * the server, so their output streams here rather than disappearing into a
 * spinner — a failed install is only useful if you can read why it failed.
 */

const route = useRoute();
const router = useRouter();
const { reload } = inject(siteContextKey)!;

const slug = computed(() => route.params['slug'] as string);

type AppInfo = Awaited<ReturnType<typeof api.sites.app.info.query>>;

const info = ref<AppInfo | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);
const saving = ref(false);

const form = ref({
  nodeVersion: '',
  packageManager: 'npm' as 'npm' | 'pnpm' | 'yarn' | 'bun',

  applicationRoot: '',
  documentRoot: '',
  startupFile: '',
  applicationMode: 'production' as 'production' | 'development',
});

const chosenScript = ref('');
const command = ref<'npm' | 'npx' | 'node' | 'pnpm' | 'yarn' | 'bun' | 'dotnet'>('npm');
const commandArgs = ref('');

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** A one-off choice: installing with something else does not change the site. */
const installWith = ref<PackageManager>('npm');

/**
 * Which of the three path fields is being browsed, if any.
 *
 * All three are relative to something the user cannot see from here, so each
 * one opens the same browser rooted at whatever it is measured against.
 */
const picking = ref<'applicationRoot' | 'startupFile' | 'documentRoot' | null>(null);

/** The folder the site's paths are measured from: a release, or the public folder. */
const pathBase = computed(() => info.value?.applicationRoot.split('/')[0] ?? 'release');

const job = useJobLog({ onFinished: () => refresh() });

/** Two views on one page, as the panel this follows does. */
const tab = computed(() => (route.query['tab'] === 'commands' ? 'commands' : 'dashboard'));

/**
 * The output folded into the application card, so the buttons that produce it
 * and the answer to "did that work?" stay on the same screen. Collapsible
 * because the settings below it are what the dashboard is otherwise for.
 */
const outputOpen = ref(true);
watch(
  () => job.running.value,
  (isRunning) => {
    if (isRunning) outputOpen.value = true;
  },
);

const running = computed(() => info.value?.serviceState === 'running');
const deployedYet = computed(
  () => info.value !== null && info.value.serviceState !== null && info.value.serviceState !== 'not-installed',
);

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  'not-installed': 'Not deployed yet',
};

const COMMANDS = ['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'dotnet'] as const;

async function refresh(): Promise<void> {
  try {
    info.value = await api.sites.app.info.query({ slug: slug.value });
    form.value = {
      nodeVersion: info.value.nodeVersion,
      packageManager: info.value.packageManager,
      applicationRoot: info.value.applicationRoot.replace(/^(release|current|public)\/?/, ''),
      documentRoot: info.value.documentRoot.replace(/^(release|current|public)\/?/, ''),
      startupFile: info.value.startupFile,
      applicationMode: info.value.applicationMode === 'development' ? 'development' : 'production',
    };
    installWith.value = info.value.packageManager;
  } catch (err) {
    error.value = describeError(err);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  await refresh();
  loading.value = false;
}

async function act(name: string, action: () => Promise<void>): Promise<void> {
  busy.value = name;
  error.value = null;
  notice.value = null;

  try {
    await action();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

const restart = () =>
  act('restart', async () => {
    const result = await api.sites.app.restart.mutate({ slug: slug.value });
    notice.value = 'The app was restarted.';
    if (info.value) info.value.serviceState = result.state;
  });

const togglePower = () =>
  act('power', async () => {
    const result = await api.sites.app.setRunning.mutate({
      slug: slug.value,
      running: !running.value,
    });
    notice.value = running.value ? 'The app was stopped.' : 'The app was started.';
    if (info.value) info.value.serviceState = result.state;
  });

const install = () =>
  act('install', async () => {
    const result = await api.sites.app.install.mutate({
      slug: slug.value,
      packageManager: installWith.value,
    });
    job.watchJob(result.jobId);
  });

const runScript = () =>
  act('script', async () => {
    if (!chosenScript.value) return;
    const result = await api.sites.app.runScript.mutate({
      slug: slug.value,
      script: chosenScript.value,
    });
    job.watchJob(result.jobId);
  });

const runCommand = () =>
  act('command', async () => {
    // Split on whitespace only: the server never sees a shell, so quoting
    // rules would be a promise this cannot keep.
    const args = commandArgs.value.trim().split(/\s+/).filter(Boolean);
    const result = await api.sites.app.runCommand.mutate({
      slug: slug.value,
      command: command.value,
      args,
    });
    job.watchJob(result.jobId);
  });

const saveSettings = () =>
  act('settings', async () => {
    saving.value = true;
    try {
      const result = await api.sites.app.setSettings.mutate({
        slug: slug.value,
        applicationRoot: form.value.applicationRoot.trim(),
        documentRoot: form.value.documentRoot.trim(),
        startupFile: form.value.startupFile.trim(),
        packageManager: form.value.packageManager,
        applicationMode: form.value.applicationMode,
      });
      notice.value = result.note;
      await Promise.all([refresh(), reload()]);
    } finally {
      saving.value = false;
    }
  });

async function saveNodeVersion(): Promise<void> {
  await act('node', async () => {
    const result = await api.sites.setNodeVersion.mutate({
      slug: slug.value,
      nodeVersion: form.value.nodeVersion,
    });
    notice.value = result.note;
    await Promise.all([refresh(), reload()]);
  });
}

watch(slug, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <AlertMessage v-if="error">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

    <div v-if="loading" class="h-80 animate-pulse rounded-card bg-surface" />

    <template v-else-if="info">
      <!-- Actions first. This page exists for them; the facts below are context. -->
      <section class="card p-5">
        <div class="flex flex-wrap items-center gap-3">
          <span
            class="flex h-9 w-9 items-center justify-center rounded-lg border border-line
                   bg-brand-soft/50 text-brand-bright"
            aria-hidden="true"
          >
            <Boxes :size="17" />
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-ink">
              {{ info.runtime === 'dotnet' ? '.NET application' : 'Node.js application' }}
            </h3>
            <p class="text-xs text-ink-faint">
              {{ STATE_LABEL[info.serviceState ?? ''] ?? 'State unknown' }}
              <template v-if="info.activePort">
                &#183; port <span class="font-mono">{{ info.activePort }}</span>
              </template>
              <template v-if="info.packageName">
                &#183; <span class="font-mono">{{ info.packageName }}</span>
              </template>
            </p>
          </div>

          <a
            v-if="info.applicationUrl"
            :href="info.applicationUrl"
            target="_blank"
            rel="noreferrer noopener"
            class="btn btn-ghost btn-sm"
          >
            <ExternalLink :size="14" aria-hidden="true" /> Open site
          </a>
        </div>

        <div class="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy !== null || !deployedYet"
            @click="restart"
          >
            <RefreshCw
              :size="14"
              :class="busy === 'restart' ? 'animate-spin' : ''"
              aria-hidden="true"
            />
            Restart app
          </button>

          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy !== null || !deployedYet"
            @click="togglePower"
          >
            <Power :size="14" aria-hidden="true" />
            {{ running ? 'Stop app' : 'Start app' }}
          </button>

          <div class="flex items-center gap-2">
            <select
              v-model="installWith"
              class="field w-24 py-1.5 text-[0.8125rem]"
              aria-label="Package manager to install with"
            >
              <option v-for="manager in PACKAGE_MANAGERS" :key="manager" :value="manager">
                {{ manager }}
              </option>
            </select>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null || job.running.value"
              @click="install"
            >
              <Package :size="14" aria-hidden="true" /> Install packages
            </button>
          </div>

          <div class="flex items-center gap-2">
            <select
              v-model="chosenScript"
              class="field w-40 py-1.5 text-[0.8125rem]"
              aria-label="Script to run"
              :disabled="info.scripts.length === 0"
            >
              <option value="">
                {{ info.scripts.length === 0 ? 'No scripts found' : 'Choose a script' }}
              </option>
              <option v-for="name in info.scripts" :key="name" :value="name">{{ name }}</option>
            </select>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null || job.running.value || !chosenScript"
              @click="runScript"
            >
              <Play :size="14" aria-hidden="true" /> Run script
            </button>
          </div>

          <RouterLink :to="`/sites/${slug}/files`" class="btn btn-ghost btn-sm">
            <FolderOpen :size="14" aria-hidden="true" /> File manager
          </RouterLink>
        </div>

        <p v-if="!deployedYet" class="mt-3 text-xs text-ink-faint">
          There is no process to control until this website has been deployed once.
        </p>

        <!-- On the commands tab the output has its own panel below the form,
             and two copies of the same log would only confuse. -->
        <div
          v-if="tab === 'dashboard' && job.lines.value.length > 0"
          class="mt-4 overflow-hidden rounded-lg border border-line"
        >
          <button
            type="button"
            class="flex w-full items-center justify-between px-4 py-2.5 text-left"
            :aria-expanded="outputOpen"
            @click="outputOpen = !outputOpen"
          >
            <span class="flex items-center gap-2 text-sm font-medium text-ink">
              <ChevronDown
                :size="15"
                class="text-ink-faint transition-transform"
                :class="outputOpen ? '' : '-rotate-90'"
                aria-hidden="true"
              />
              Output
            </span>
            <span class="text-xs capitalize text-ink-muted">{{ job.status.value ?? '' }}</span>
          </button>
          <pre
            v-if="outputOpen"
            class="max-h-80 overflow-y-auto border-t border-line bg-black/25 p-4 font-mono text-xs leading-relaxed"
          ><span
            v-for="line in job.lines.value"
            :key="line.seq"
            class="block"
            :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
          >{{ line.message }}</span></pre>
        </div>
      </section>

      <nav class="flex gap-6 border-b border-line" aria-label="Application views">
        <button
          type="button"
          class="tab"
          :class="tab === 'dashboard' ? 'tab-active' : ''"
          @click="router.replace({ query: {} })"
        >
          <Boxes :size="15" aria-hidden="true" /> Dashboard
        </button>
        <button
          type="button"
          class="tab"
          :class="tab === 'commands' ? 'tab-active' : ''"
          @click="router.replace({ query: { tab: 'commands' } })"
        >
          <Terminal :size="15" aria-hidden="true" /> Run commands
        </button>
      </nav>

      <section v-if="tab === 'dashboard'" class="card p-5">
        <h3 class="text-sm font-semibold text-ink">How this application runs</h3>
        <p class="mt-1 text-sm text-ink-muted">
          Changes here take effect when the app is next restarted or deployed.
        </p>

        <dl class="mt-4 divide-y divide-line border-y border-line text-sm">
          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Node version</dt>
            <dd class="flex flex-1 flex-wrap items-center gap-2">
              <select
                v-model="form.nodeVersion"
                class="field max-w-64 py-1.5"
                aria-label="Node version"
              >
                <option value="">Whatever the server defaults to</option>
                <option v-for="version in info.installedNodeVersions" :key="version" :value="version">
                  Node {{ version }}
                </option>
              </select>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy !== null || form.nodeVersion === info.nodeVersion"
                @click="saveNodeVersion"
              >
                Use this version
              </button>
              <span v-if="info.resolvedNodeVersion" class="text-xs text-ink-faint">
                currently {{ info.resolvedNodeVersion }}
              </span>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Package manager</dt>
            <dd class="flex-1">
              <select
                v-model="form.packageManager"
                class="field max-w-64 py-1.5"
                aria-label="Package manager"
              >
                <option v-for="manager in PACKAGE_MANAGERS" :key="manager" :value="manager">
                  {{ manager }}
                </option>
              </select>
              <p class="hint">
                Used for the install and build steps of every deployment, not just the
                buttons above. Changing it rewrites those steps.
              </p>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Application root</dt>
            <dd class="flex-1">
              <div class="flex max-w-md flex-wrap items-center gap-2">
                <input
                  v-model="form.applicationRoot"
                  class="field min-w-48 flex-1 font-mono"
                  aria-label="Application root"
                  placeholder="(the project root)"
                />
                <button type="button" class="btn btn-ghost btn-sm" @click="picking = 'applicationRoot'">
                  <FolderSearch :size="14" aria-hidden="true" /> Browse
                </button>
              </div>
              <p class="hint">
                The folder your <span class="font-mono">package.json</span> lives in, inside
                <span class="font-mono">{{ pathBase }}</span>.
              </p>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Startup file</dt>
            <dd class="flex-1">
              <div class="flex max-w-md flex-wrap items-center gap-2">
                <input
                  v-model="form.startupFile"
                  class="field min-w-48 flex-1 font-mono"
                  aria-label="Startup file"
                  placeholder="index.js"
                />
                <button type="button" class="btn btn-ghost btn-sm" @click="picking = 'startupFile'">
                  <FolderSearch :size="14" aria-hidden="true" /> Browse
                </button>
              </div>
              <p class="hint">Relative to the application root, e.g. src/server.js</p>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Document root</dt>
            <dd class="flex-1">
              <div class="flex max-w-md flex-wrap items-center gap-2">
                <input
                  v-model="form.documentRoot"
                  class="field min-w-48 flex-1 font-mono"
                  aria-label="Document root"
                  placeholder="(the application root)"
                />
                <button type="button" class="btn btn-ghost btn-sm" @click="picking = 'documentRoot'">
                  <FolderSearch :size="14" aria-hidden="true" /> Browse
                </button>
              </div>
              <p class="hint">Only used when the web server serves files directly.</p>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Application mode</dt>
            <dd class="flex-1">
              <select
                v-model="form.applicationMode"
                class="field max-w-64 py-1.5"
                aria-label="Application mode"
              >
                <option value="production">production</option>
                <option value="development">development</option>
              </select>
              <p class="hint">Stored as NODE_ENV in this website&#8217;s environment.</p>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Application URL</dt>
            <dd class="flex-1">
              <a
                v-if="info.applicationUrl"
                :href="info.applicationUrl"
                target="_blank"
                rel="noreferrer noopener"
                class="text-brand-bright underline underline-offset-2"
              >
                {{ info.applicationUrl }}
              </a>
              <span v-else class="text-ink-faint">No web address yet</span>
            </dd>
          </div>

          <div class="flex flex-wrap items-center gap-3 py-3">
            <dt class="w-52 shrink-0 text-ink-muted">Environment values</dt>
            <dd class="flex-1">
              <RouterLink
                :to="`/sites/${slug}/settings`"
                class="text-brand-bright underline underline-offset-2"
              >
                {{ info.environmentCount }} stored
              </RouterLink>
              <p class="hint">Encrypted on this server and handed only to your app.</p>
            </dd>
          </div>
        </dl>

        <button type="button" class="btn btn-primary mt-4" :disabled="saving" @click="saveSettings">
          <Save :size="15" aria-hidden="true" /> {{ saving ? 'Saving\u2026' : 'Save changes' }}
        </button>
      </section>

      <section v-else class="card p-5">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
          <Terminal :size="15" class="text-ink-faint" aria-hidden="true" /> Run a command
        </h3>
        <p class="mt-1 text-sm text-ink-muted">
          Runs in this website&#8217;s application folder with its own environment. Only the
          tools listed here can be started, and nothing is passed through a shell &#8212; so
          pipes, redirects and <span class="font-mono">&amp;&amp;</span> will not work.
        </p>

        <form class="mt-4 flex flex-wrap items-end gap-2" @submit.prevent="runCommand">
          <div>
            <label for="command" class="label">Command</label>
            <select id="command" v-model="command" class="field w-32 py-1.5">
              <option v-for="name in COMMANDS" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>
          <div class="min-w-64 flex-1">
            <label for="args" class="label">Arguments</label>
            <input
              id="args"
              v-model="commandArgs"
              class="field font-mono"
              placeholder="run build"
            />
          </div>
          <button
            type="submit"
            class="btn btn-primary mb-0.5"
            :disabled="busy !== null || job.running.value"
          >
            <Play :size="15" aria-hidden="true" />
            {{ job.running.value ? 'Running\u2026' : 'Run' }}
          </button>
        </form>
      </section>

      <!-- The commands tab is short enough that the output belongs right under
           the form that produced it. -->
      <section v-if="tab === 'commands' && job.lines.value.length > 0" class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 class="text-sm font-medium text-ink">Output</h3>
          <span class="text-xs capitalize text-ink-muted">{{ job.status.value ?? '' }}</span>
        </div>
        <pre
          class="max-h-96 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"
        ><span
          v-for="line in job.lines.value"
          :key="line.seq"
          class="block"
          :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
        >{{ line.message }}</span></pre>
      </section>

      <!--
        One browser, pointed at whatever the field being edited is measured
        from. The startup file is relative to the application root, so it opens
        inside the value of the field above it rather than at the release root.
      -->
      <PathPicker
        v-model="form.applicationRoot"
        :open="picking === 'applicationRoot'"
        :site-slug="slug"
        :base="pathBase"
        title="Choose the application root"
        @close="picking = null"
      />
      <PathPicker
        v-model="form.startupFile"
        :open="picking === 'startupFile'"
        :site-slug="slug"
        :base="[pathBase, form.applicationRoot].filter(Boolean).join('/')"
        mode="file"
        title="Choose the startup file"
        @close="picking = null"
      />
      <PathPicker
        v-model="form.documentRoot"
        :open="picking === 'documentRoot'"
        :site-slug="slug"
        :base="pathBase"
        title="Choose the document root"
        @close="picking = null"
      />
    </template>
  </div>
</template>
