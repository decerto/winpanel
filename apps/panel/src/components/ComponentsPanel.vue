<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ArrowDownToLine, Boxes, Play, RefreshCw, Square, Trash2 } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from './AlertMessage.vue';
import LoadingBlock from './LoadingBlock.vue';
import Tooltip from './Tooltip.vue';

/**
 * The programs the panel drives: web server, mail server, git.
 *
 * Installing one is a job, not a request — it downloads tens of megabytes,
 * unpacks it, and registers a Windows service — so the log is streamed here
 * rather than leaving somebody watching a spinner for three minutes.
 */

type Component = Awaited<ReturnType<typeof api.components.list.query>>[number];
type NodeManager = Awaited<ReturnType<typeof api.components.nodeVersions.list.query>>;
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

const components = ref<Component[]>([]);
const nodeManager = ref<NodeManager | null>(null);
const nodeToInstall = ref('');
const loading = ref(true);
const nodeLoading = ref(true);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);

const activeJobId = ref<string | null>(null);
const logLines = ref<Array<{ seq: number; level: string; message: string }>>([]);
const jobStatus = ref<string | null>(null);
let poller: ReturnType<typeof setInterval> | null = null;
/** A slow tick must not overlap the next one, or lines arrive twice. */
let polling = false;

const emit = defineEmits<{ changed: [] }>();

const running = computed(() => jobStatus.value === 'running' || jobStatus.value === 'pending');

const coreComponents = computed(() =>
  components.value.filter(
    (component) => component.id !== 'node' && !PACKAGE_MANAGERS.includes(component.id as PackageManager),
  ),
);

const packageManagers = computed(() =>
  PACKAGE_MANAGERS.map((id) => {
    const component = components.value.find((entry) => entry.id === id);
    const installed = id === 'npm' ? (nodeManager.value?.installed.length ?? 0) > 0 : component?.installed ?? false;
    return {
      id,
      component,
      installed,
      version: id === 'npm' ? 'Bundled with Node.js' : (component?.version ?? 'Not available'),
    };
  }),
);

const availableNodeVersions = computed(() => {
  const installed = new Set(nodeManager.value?.installed.map((entry) => entry.version));
  return nodeManager.value?.available.filter((entry) => !installed.has(entry.version)) ?? [];
});

const panelNodeInstalled = computed(
  () => nodeManager.value?.installed.some((entry) => entry.managed) ?? false,
);

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  'not-installed': 'Not registered',
};

async function load(): Promise<void> {
  loading.value = true;
  nodeLoading.value = true;

  const [programs, nodes] = await Promise.allSettled([
    api.components.list.query(),
    api.components.nodeVersions.list.query(),
  ]);

  if (programs.status === 'fulfilled') components.value = programs.value;
  else error.value = describeError(programs.reason);

  if (nodes.status === 'fulfilled') nodeManager.value = nodes.value;
  else error.value = describeError(nodes.reason);

  loading.value = false;
  nodeLoading.value = false;
}

void load();

function stopPolling(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

async function pollJob(): Promise<void> {
  if (!activeJobId.value || polling) return;
  polling = true;

  try {
    const job = await api.jobs.get.query({ jobId: activeJobId.value });
    jobStatus.value = job?.status ?? null;

    const lastSeq = logLines.value.at(-1)?.seq ?? -1;
    logLines.value.push(
      ...(await api.jobs.logs.query({ jobId: activeJobId.value, afterSeq: lastSeq })),
    );

    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      stopPolling();
      busyId.value = null;
      await load();
      emit('changed');
    }
  } catch {
    // A transient failure while polling should not tear down the view.
  } finally {
    polling = false;
  }
}

function watchJob(jobId: string): void {
  activeJobId.value = jobId;
  logLines.value = [];
  jobStatus.value = 'pending';
  stopPolling();
  poller = setInterval(() => void pollJob(), 1000);
}

async function installNode(version: string): Promise<void> {
  busyId.value = `node:${version}`;
  error.value = null;

  try {
    const result = await api.components.nodeVersions.install.mutate({ version });
    nodeToInstall.value = '';
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function uninstallNode(installation: NodeManager['installed'][number]): Promise<void> {
  if (!installation.canRemove) return;

  const fallback = installation.fallbackVersion
    ? `Affected websites will switch to Node ${installation.fallbackVersion} automatically.`
    : 'There is no other Node version available, so affected websites would go offline.';
  if (
    !window.confirm(
      `Remove Node ${installation.version}?\n\n` +
        (installation.affectedSites > 0
          ? `${installation.affectedSites} website${installation.affectedSites === 1 ? '' : 's'} use this version. ${fallback}`
          : 'Websites that explicitly need this version will no longer be able to use it.'),
    )
  ) {
    return;
  }

  const confirmation = window.prompt(`Type "${installation.version}" to confirm removing it:`);
  if (confirmation !== installation.version) return;

  busyId.value = `node:${installation.version}`;
  error.value = null;
  try {
    const result = await api.components.nodeVersions.uninstall.mutate({
      version: installation.version,
      confirmation,
    });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function updatePackageManager(packageManager: PackageManager): Promise<void> {
  busyId.value = packageManager;
  error.value = null;

  try {
    const result = await api.components.packageManagers.update.mutate({ packageManager });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function install(component: Component): Promise<void> {
  busyId.value = component.id;
  error.value = null;

  try {
    const result = await api.components.install.mutate({ componentId: component.id });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function uninstall(component: Component): Promise<void> {
  if (
    !window.confirm(
      `Remove ${component.name}? Websites or mailboxes may rely on it and will stop working ` +
        'until it is installed again.',
    )
  ) {
    return;
  }

  const confirmation = window.prompt(`Type "${component.name}" to confirm removing it:`);
  if (confirmation !== component.name) return;

  const deleteData = window.confirm(
    `Also permanently delete all ${component.name} data? This cannot be undone. ` +
      'Website files are not removed.',
  );

  busyId.value = component.id;
  error.value = null;

  try {
    const result = await api.components.uninstall.mutate({
      componentId: component.id,
      confirmation,
      deleteData,
    });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function service(component: Component, action: 'start' | 'stop' | 'restart'): Promise<void> {
  busyId.value = component.id;
  error.value = null;

  try {
    await api.components.service.mutate({ componentId: component.id, action });
    await load();
    emit('changed');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busyId.value = null;
  }
}

const levelClass: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warn',
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
};

onUnmounted(stopPolling);
</script>

<template>
  <section class="card p-6">
    <div class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
               bg-brand-soft/50 text-brand-bright"
        aria-hidden="true"
      >
        <Boxes :size="19" />
      </span>

      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold text-ink">Programs, runtimes &amp; tools</h2>
        <p class="mt-1 text-sm text-ink-muted">
          The software this panel manages for your websites and server. Downloads come from
          official releases and are checked before they are used.
        </p>
      </div>
    </div>

    <AlertMessage v-if="error" class="mt-4">{{ error }}</AlertMessage>

    <LoadingBlock v-if="loading" class="mt-5 h-52" />

    <ul v-else class="mt-5 divide-y divide-line">
      <li v-for="component in coreComponents" :key="component.id" class="flex flex-wrap gap-4 py-4">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-medium text-ink">{{ component.name }}</h3>
            <span class="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs text-ink-faint">
              {{ component.version }}
            </span>

            <span v-if="component.installed" class="flex items-center gap-1.5 text-xs">
              <span
                class="h-1.5 w-1.5 rounded-full"
                :class="
                  !component.serviceName || component.serviceState === 'running'
                    ? 'bg-ok'
                    : 'bg-idle'
                "
                aria-hidden="true"
              />
              <span
                :class="
                  !component.serviceName || component.serviceState === 'running'
                    ? 'text-ok'
                    : 'text-ink-muted'
                "
              >
                {{ component.serviceName ? STATE_LABEL[component.serviceState ?? ''] : 'Installed' }}
              </span>
            </span>
            <span v-else class="text-xs text-ink-faint">
              {{ component.managed ? 'Not installed' : 'None found' }}
            </span>
          </div>

          <p class="mt-1 text-sm text-ink-muted">{{ component.description }}</p>

        </div>

        <div v-if="component.managed" class="flex shrink-0 flex-wrap items-start gap-2">
          <template v-if="component.installed">
            <!--
              A program can be on disk with no service registered, when an
              install failed partway. Offering Start then only produces a
              failure; reinstalling is what actually fixes it.
            -->
            <button
              v-if="
                component.serviceName &&
                component.serviceState !== 'not-installed' &&
                component.serviceState !== 'running'
              "
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="service(component, 'start')"
            >
              <Play :size="13" aria-hidden="true" /> Start
            </button>
            <button
              v-else-if="component.serviceName && component.serviceState === 'running'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="service(component, 'stop')"
            >
              <Square :size="13" aria-hidden="true" /> Stop
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="install(component)"
            >
              <RefreshCw
                :size="13"
                :class="busyId === component.id && running ? 'animate-spin' : ''"
                aria-hidden="true"
              />
              Reinstall
            </button>

            <Tooltip :text="`Remove ${component.name}`">
              <button
                type="button"
                class="btn btn-danger btn-sm"
                :disabled="busyId !== null"
                :aria-label="`Remove ${component.name}`"
                @click="uninstall(component)"
              >
                <Trash2 :size="13" aria-hidden="true" />
              </button>
            </Tooltip>
          </template>

          <button
            v-else
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busyId !== null"
            @click="install(component)"
          >
            {{ busyId === component.id ? 'Installing\u2026' : 'Install' }}
          </button>
        </div>
      </li>
    </ul>

    <section class="mt-6 border-t border-line pt-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-ink">Node.js runtimes</h3>
          <p class="mt-1 max-w-2xl text-sm text-ink-muted">
            Keep more than one Node version available for different websites. Removing a
            panel-managed version automatically moves its websites to the newest remaining one.
          </p>
        </div>
        <span class="rounded-md border border-line bg-black/20 px-2.5 py-1 text-xs text-ink-faint">
          {{ nodeManager?.installed.length ?? 0 }} installed
        </span>
      </div>

      <LoadingBlock v-if="nodeLoading" class="mt-4 h-32" />

      <div v-else-if="nodeManager" class="mt-4 space-y-3">
        <div
          v-for="installation in nodeManager.installed"
          :key="installation.version"
          class="rounded-lg border border-line bg-black/15 p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-ink">Node {{ installation.version }}</span>
                <span
                  class="rounded-md px-1.5 py-0.5 text-xs"
                  :class="installation.managed ? 'bg-brand-soft text-brand-bright' : 'bg-black/25 text-ink-faint'"
                >
                  {{ installation.managed ? 'Panel managed' : 'Provided by server' }}
                </span>
              </div>
              <p class="mt-1 text-xs text-ink-faint">
                {{ installation.source === 'version-manager' ? 'Version manager' : installation.source === 'panel' ? 'WinPanel runtime store' : 'System installation' }}
                <template v-if="installation.affectedSites > 0">
                  <span class="mx-1">&middot;</span>
                  {{ installation.affectedSites }} website{{ installation.affectedSites === 1 ? '' : 's' }} use this version
                </template>
              </p>
              <p v-if="installation.affectedSites > 0" class="mt-2 text-xs text-warn">
                <template v-if="installation.fallbackVersion">
                  Removing it switches these websites to Node {{ installation.fallbackVersion }}.
                </template>
                <template v-else>
                  Install another Node version before removing this one.
                </template>
              </p>
            </div>

            <button
              v-if="installation.managed"
              type="button"
              class="btn btn-danger btn-sm shrink-0"
              :disabled="busyId !== null || !installation.canRemove"
              :title="installation.canRemove ? `Remove Node ${installation.version}` : 'Install another Node version before removing this one'"
              :aria-label="`Remove Node ${installation.version}`"
              @click="uninstallNode(installation)"
            >
              <Trash2 :size="14" aria-hidden="true" /> Remove
            </button>
          </div>
        </div>

        <div v-if="nodeManager.installed.length === 0" class="rounded-lg border border-dashed border-line-strong p-4">
          <p class="text-sm text-ink-muted">No Node.js runtime is installed yet.</p>
          <p class="mt-1 text-xs text-ink-faint">Install one below before creating or deploying a Node.js website.</p>
        </div>

        <form class="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-brand-soft/20 p-4" @submit.prevent="installNode(nodeToInstall)">
          <div class="min-w-56 flex-1 sm:max-w-xs">
            <label for="node-version-install" class="label">Add a Node version</label>
            <select id="node-version-install" v-model="nodeToInstall" class="field" :disabled="availableNodeVersions.length === 0 || busyId !== null">
              <option value="">Choose a version</option>
              <option v-for="version in availableNodeVersions" :key="version.version" :value="version.version">
                Node {{ version.version }} &middot; {{ version.codename }}
              </option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary" :disabled="!nodeToInstall || busyId !== null">
            <ArrowDownToLine :size="15" aria-hidden="true" />
            {{ busyId?.startsWith('node:') && running ? 'Installing...' : 'Install runtime' }}
          </button>
          <p v-if="availableNodeVersions.length === 0" class="basis-full text-xs text-ink-faint">
            All supported Node versions are already installed.
          </p>
        </form>
      </div>
    </section>

    <section class="mt-6 border-t border-line pt-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-ink">Package managers</h3>
          <p class="mt-1 max-w-2xl text-sm text-ink-muted">
            Keep the tools your projects use ready for deployments. Updates replace the current
            panel-managed copy; npm is updated inside each panel-managed Node runtime.
          </p>
        </div>
      </div>

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div v-for="manager in packageManagers" :key="manager.id" class="flex items-center justify-between gap-4 rounded-lg border border-line bg-black/15 p-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-ink">{{ manager.id }}</span>
              <span v-if="manager.installed" class="flex items-center gap-1.5 text-xs text-ok">
                <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" /> Ready
              </span>
              <span v-else class="text-xs text-ink-faint">Not installed</span>
            </div>
            <p class="mt-1 text-xs text-ink-faint">{{ manager.version }}</p>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm shrink-0"
            :disabled="busyId !== null || (manager.id === 'npm' && !panelNodeInstalled)"
            @click="updatePackageManager(manager.id)"
          >
            <RefreshCw :size="13" :class="busyId === manager.id && running ? 'animate-spin' : ''" aria-hidden="true" />
            {{ manager.installed ? 'Update' : 'Install' }}
          </button>
        </div>
      </div>
      <p v-if="!panelNodeInstalled" class="mt-3 text-xs text-ink-faint">
        npm becomes manageable after you install a Node.js runtime through WinPanel.
      </p>
    </section>

    <div v-if="logLines.length > 0" class="mt-5 overflow-hidden rounded-lg border border-line">
      <div class="flex items-center justify-between border-b border-line px-4 py-2">
        <h3 class="text-sm font-medium text-ink">Installation log</h3>
        <span class="text-xs capitalize text-ink-faint">{{ jobStatus }}</span>
      </div>
      <pre
        class="max-h-64 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"
      ><span
        v-for="line in logLines"
        :key="line.seq"
        class="block"
        :class="levelClass[line.level] ?? 'text-ink'"
      >{{ line.message }}</span></pre>
    </div>
  </section>
</template>
