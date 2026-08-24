<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  File,
  FileCog,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  Package,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-vue-next';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { roleAtLeast, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { gameDownloadUrl, uploadGameFile } from '../lib/file-transfer';
import { formatBytes } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import FileEditorDialog from '../components/FileEditorDialog.vue';
import GameWorkshopPanel from '../components/GameWorkshopPanel.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';

/**
 * One game server, and everything you can do to it.
 *
 * Split into tabs for the same reason a website is: the page had grown a
 * console, a file browser, a credentials list and an editor stacked on top of
 * one another, and each was a scroll away from whatever you actually came for.
 * The tab lives in the address bar, so a link to a server's mods is a link to
 * its mods.
 */

const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params['slug'] ?? ''));
type Server = Awaited<ReturnType<typeof api.gameServers.get.query>>;
type Listing = Awaited<ReturnType<typeof api.gameServers.files.list.query>>;
type Entry = Listing['entries'][number];

const TABS = ['overview', 'console', 'files', 'workshop'] as const;
type Tab = (typeof TABS)[number];

const server = ref<Server | null>(null);
const listing = ref<Listing | null>(null);
const currentPath = ref('');
const editingPath = ref<string | null>(null);
const loading = ref(true);
const fileLoading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const creatingFolder = ref(false);
const folderName = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const role = ref<UserRole | null>(null);
type ConsoleState = Awaited<ReturnType<typeof api.gameServers.console.query>>;
const consoleState = ref<ConsoleState | null>(null);
const consoleCommand = ref('');
const consoleBusy = ref(false);
let consoleTimer: ReturnType<typeof setInterval> | null = null;
const branch = ref('');
const branchBusy = ref(false);
type Credential = Awaited<ReturnType<typeof api.gameServers.credentials.query>>[number];
const credentials = ref<ReadonlyArray<Credential>>([]);
const revealed = ref<Record<string, string>>({});
const installJob = useJobLog({
  onFinished: async () => {
    busy.value = false;
    await Promise.all([loadServer(), loadFiles(), loadConsole()]);
  },
});

const isAdmin = computed(() => role.value !== null && roleAtLeast(role.value, 'admin'));
const hasWorkshop = computed(() => server.value?.catalog?.workshop != null);

const tab = computed<Tab>(() => {
  const wanted = String(route.query['tab'] ?? 'overview');
  const found = TABS.find((name) => name === wanted) ?? 'overview';
  return found === 'workshop' && !hasWorkshop.value ? 'overview' : found;
});

const visibleTabs = computed(() =>
  [
    { id: 'overview' as const, label: 'Overview', icon: Gauge, show: true },
    { id: 'console' as const, label: 'Console', icon: TerminalSquare, show: true },
    { id: 'files' as const, label: 'Files', icon: FolderOpen, show: true },
    { id: 'workshop' as const, label: 'Workshop', icon: Package, show: hasWorkshop.value },
  ].filter((entry) => entry.show),
);

function selectTab(next: Tab): void {
  void router.replace({ query: { ...route.query, tab: next } });
}

const entries = computed(() => listing.value?.entries ?? []);
/*
 * The catalog can name the one file that holds the server's settings. When it
 * does, the page gets a shortcut that opens it straight into the editor — the
 * common case is editing config, not browsing for it. Providers with no single
 * obvious file leave it unset and no button appears.
 */
const configFilePath = computed(() =>
  server.value?.catalog?.configFile?.replaceAll('{slug}', slug.value) ?? null,
);
const breadcrumbs = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
});
const quotaPercent = computed(() =>
  listing.value ? Math.min(100, (listing.value.quotaUsedBytes / listing.value.quotaTotalBytes) * 100) : 0,
);

async function loadServer(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    server.value = await api.gameServers.get.query({ slug: slug.value });
    branch.value = server.value.branch ?? '';
    credentials.value = await api.gameServers.credentials.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

/*
 * Revealed on request rather than sent with the page, so a password the game
 * needs its owner to type is not sitting in every response that happens to
 * load this server.
 */
async function revealCredential(name: string): Promise<void> {
  if (revealed.value[name]) {
    const { [name]: _hidden, ...rest } = revealed.value;
    revealed.value = rest;
    return;
  }
  try {
    const result = await api.gameServers.revealCredential.mutate({ slug: slug.value, name });
    revealed.value = { ...revealed.value, [name]: result.value };
  } catch (err) {
    error.value = describeError(err);
  }
}

async function loadFiles(): Promise<void> {
  fileLoading.value = true;
  try {
    listing.value = await api.gameServers.files.list.query({
      gameServerSlug: slug.value,
      path: currentPath.value,
      showHidden: false,
      sortBy: 'name',
      sortDir: 'asc',
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    fileLoading.value = false;
  }
}

async function loadConsole(): Promise<void> {
  try {
    consoleState.value = await api.gameServers.console.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  }
}

async function sendConsoleCommand(): Promise<void> {
  const command = consoleCommand.value.trim();
  if (!command) return;
  consoleBusy.value = true;
  try {
    await api.gameServers.command.mutate({ slug: slug.value, command });
    consoleCommand.value = '';
    await loadConsole();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    consoleBusy.value = false;
  }
}

function goTo(path: string): void {
  currentPath.value = path;
  void loadFiles();
}

function goUp(): void {
  const parts = currentPath.value.split('/').filter(Boolean);
  parts.pop();
  goTo(parts.join('/'));
}

function openEntry(entry: Entry): void {
  if (entry.kind === 'directory') {
    goTo(entry.path);
    return;
  }
  editingPath.value = entry.path;
}

/** Opens the catalog's named config file directly, without browsing for it. */
function openConfig(): void {
  if (!configFilePath.value) return;
  error.value = null;
  editingPath.value = configFilePath.value;
}

async function createFolder(): Promise<void> {
  const name = folderName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    await api.gameServers.files.createFolder.mutate({
      gameServerSlug: slug.value,
      parentPath: currentPath.value,
      name,
    });
    folderName.value = '';
    creatingFolder.value = false;
    await loadFiles();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function chooseUpload(): void {
  fileInput.value?.click();
}

async function upload(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  busy.value = true;
  error.value = null;
  try {
    await uploadGameFile(slug.value, currentPath.value, file).promise;
    notice.value = `${file.name} uploaded.`;
    await loadFiles();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function serviceAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.gameServers.service.mutate({ slug: slug.value, action });
    notice.value = action === 'start' ? 'Server started.' : action === 'stop' ? 'Server stopped.' : 'Server restarted.';
    await loadServer();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function installServer(reinstall = false): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = reinstall
      ? await api.gameServers.reinstall.mutate({ slug: slug.value })
      : await api.gameServers.install.mutate({ slug: slug.value });
    installJob.watchJob(result.jobId);
  } catch (err) {
    busy.value = false;
    error.value = describeError(err);
  }
}

/** Pulls the latest build of the server's selected Steam branch. */
async function updateServer(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.gameServers.update.mutate({ slug: slug.value });
    installJob.watchJob(result.jobId);
  } catch (err) {
    busy.value = false;
    error.value = describeError(err);
  }
}

/** Saves the branch so the next update pulls it. */
async function saveBranch(): Promise<void> {
  branchBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const wanted = branch.value.trim();
    await api.gameServers.setBranch.mutate({ slug: slug.value, branch: wanted || null });
    notice.value = wanted
      ? `The next update will pull the "${wanted}" branch.`
      : 'The next update will pull the default branch.';
    await loadServer();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    branchBusy.value = false;
  }
}

async function removeEntry(entry: Entry): Promise<void> {
  if (!window.confirm(`Delete ${entry.name}?`)) return;
  busy.value = true;
  try {
    await api.gameServers.files.remove.mutate({
      gameServerSlug: slug.value,
      paths: [entry.path],
      permanent: false,
    });
    if (editingPath.value === entry.path) editingPath.value = null;
    await loadFiles();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function removeServer(): Promise<void> {
  if (!window.confirm(`Delete ${server.value?.displayName ?? 'this game server'}? This removes its files, service, ports, and firewall rules.`)) return;
  if (!window.confirm('Type DELETE in the next prompt to confirm this cannot be undone.')) return;
  const confirmation = window.prompt('Type DELETE to permanently remove this game server:');
  if (confirmation !== 'DELETE') return;

  busy.value = true;
  error.value = null;
  try {
    await api.gameServers.remove.mutate({ slug: slug.value, confirmation: 'DELETE' });
    await router.push('/game-servers');
  } catch (err) {
    error.value = describeError(err);
    busy.value = false;
  }
}

watch(slug, async () => {
  await loadServer();
  currentPath.value = '';
  editingPath.value = null;
  await loadFiles();
  await loadConsole();
  role.value = await api.auth.me.query().then((me) => me?.role ?? null, () => null);
}, { immediate: true });

/*
 * The console only polls while it is on screen. Following a log nobody is
 * looking at is a request every two and a half seconds for nothing.
 */
watch(tab, (current) => {
  if (consoleTimer) clearInterval(consoleTimer);
  consoleTimer = null;
  if (current !== 'console') return;
  void loadConsole();
  consoleTimer = setInterval(() => void loadConsole(), 2500);
}, { immediate: true });

onUnmounted(() => {
  if (consoleTimer) clearInterval(consoleTimer);
});
</script>

<template>
  <div class="mx-auto w-full max-w-7xl">
    <RouterLink to="/game-servers" class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft :size="15" aria-hidden="true" /> All game servers
    </RouterLink>

    <LoadingBlock v-if="loading" class="h-40 rounded-card bg-surface" />
    <AlertMessage v-else-if="error && !server" class="mb-4">{{ error }}</AlertMessage>

    <template v-else-if="server">
      <PageHeader :title="server.displayName" :description="server.catalog?.name ?? server.catalogId">
        <template #actions>
          <button
            v-if="(server.state === 'uninstalled' || server.state === 'failed') && server.installAllowed"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy || installJob.running.value"
            @click="installServer(false)"
          >
            <Download :size="14" aria-hidden="true" />
            {{ installJob.running.value ? 'Installing...' : 'Install server' }}
          </button>
          <span
            v-if="(server.state === 'uninstalled' || server.state === 'failed') && !server.installAllowed"
            class="self-center text-xs text-ink-faint"
          >
            An administrator must install this Steam server
          </span>
          <button
            v-if="server.serviceId && server.state !== 'running'"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy"
            @click="serviceAction('start')"
          >
            Start
          </button>
          <button
            v-if="server.serviceId && server.state === 'running'"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            @click="serviceAction('stop')"
          >
            Stop
          </button>
          <button
            v-if="server.serviceId"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            @click="serviceAction('restart')"
          >
            Restart
          </button>
          <StatusBadge
            :state="server.state === 'running' ? 'ok' : server.state === 'failed' ? 'blocked' : 'unknown'"
            :label="server.state"
            size="sm"
          />
          <button
            v-if="server.serviceId"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy || installJob.running.value"
            @click="updateServer"
          >
            <RefreshCw :size="14" aria-hidden="true" />
            {{ installJob.running.value ? 'Updating...' : 'Update' }}
          </button>
          <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="removeServer">
            Delete
          </button>
        </template>
      </PageHeader>

      <nav class="mb-6 flex gap-5 overflow-x-auto border-b border-line" aria-label="Game server sections">
        <button
          v-for="entry in visibleTabs"
          :key="entry.id"
          type="button"
          class="tab"
          :class="tab === entry.id ? 'tab-active' : ''"
          :aria-current="tab === entry.id ? 'page' : undefined"
          @click="selectTab(entry.id)"
        >
          <component :is="entry.icon" :size="15" aria-hidden="true" />
          {{ entry.label }}
        </button>
      </nav>

      <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

      <section v-if="installJob.lines.value.length > 0" class="card mb-6 overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <RefreshCw
              :size="14"
              :class="installJob.running.value ? 'animate-spin text-brand-bright' : 'text-ink-faint'"
              aria-hidden="true"
            />
            <h2 class="text-sm font-semibold text-ink">
              {{ installJob.running.value ? 'Installing server' : 'Installation result' }}
            </h2>
          </div>
          <span class="text-xs capitalize text-ink-faint">{{ installJob.status.value }}</span>
        </div>
        <pre class="max-h-64 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"><span
          v-for="line in installJob.lines.value"
          :key="line.seq"
          class="block"
          :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
        >{{ line.message }}</span></pre>
      </section>

      <div v-if="tab === 'overview'" class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="space-y-6">
          <section v-if="configFilePath" class="card p-5">
            <h2 class="text-sm font-semibold text-ink">Server configuration</h2>
            <p class="mt-2 text-sm text-ink-muted">
              Nearly everything this game lets you change lives in one file. It opens in the panel's
              editor, which has line numbers and find and replace — these files run long.
            </p>
            <p class="mt-2 font-mono text-xs text-ink-faint">{{ configFilePath }}</p>
            <button type="button" class="btn btn-primary mt-4" :disabled="busy" @click="openConfig">
              <FileCog :size="14" aria-hidden="true" /> Edit server config
            </button>
          </section>

          <section v-if="server.catalog?.provider === 'steam'" class="card overflow-hidden">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <h2 class="text-sm font-semibold text-ink">Updates</h2>
                <p class="mt-0.5 text-xs text-ink-faint">
                  Pulls the latest build of this server's Steam branch. Leave the branch blank for the default.
                </p>
              </div>
              <form class="flex items-center gap-2" @submit.prevent="saveBranch">
                <input
                  v-model="branch"
                  class="field !w-44 font-mono text-xs"
                  placeholder="Branch, e.g. legacy41"
                  :disabled="branchBusy || busy"
                  aria-label="Steam branch"
                />
                <button type="submit" class="btn btn-ghost btn-sm" :disabled="branchBusy || busy">
                  Save branch
                </button>
              </form>
            </div>
            <div class="px-4 py-3 text-xs text-ink-muted">
              <span class="text-ink-faint">Current:</span>
              <span class="font-mono text-ink">{{ server.branch || 'default' }}</span>
            </div>
          </section>

          <section class="card p-5">
            <h2 class="text-sm font-semibold text-ink">Connection</h2>
            <dl class="mt-3 space-y-2 text-sm">
              <div v-for="port in server.ports" :key="port.id" class="flex justify-between gap-3">
                <dt class="text-ink-faint">{{ port.name }} ({{ port.protocol.toUpperCase() }})</dt>
                <dd class="font-mono text-ink-muted">
                  {{ port.visibility === 'public' ? (server.publicIpv4 ?? 'IP unavailable') : '127.0.0.1' }}:{{ port.port }}
                </dd>
              </div>
            </dl>
            <p class="mt-3 text-xs text-ink-faint">
              Forward these ports on your router or cloud firewall if the machine is not directly
              reachable from the internet.
            </p>
          </section>
        </div>

        <aside class="space-y-4">
          <section class="card p-5">
            <h2 class="text-sm font-semibold text-ink">Data storage</h2>
            <p class="mt-2 text-sm text-ink-muted">
              {{ formatBytes(listing?.quotaUsedBytes ?? 0) }} of {{ formatBytes(listing?.quotaTotalBytes ?? server.diskQuotaBytes) }} used
            </p>
            <div class="mt-3 h-2 overflow-hidden rounded-full bg-black/30">
              <div class="h-full rounded-full bg-brand" :style="{ width: `${quotaPercent}%` }" />
            </div>
            <p class="mt-3 text-xs text-ink-faint">Provider files are managed separately. This area is for configuration, worlds, saves, and logs.</p>
          </section>

          <section v-if="credentials.length > 0" class="card p-5">
            <h2 class="text-sm font-semibold text-ink">Credentials</h2>
            <p class="mt-2 text-xs text-ink-faint">
              Generated when the server was installed and kept in the panel's vault. Reinstalling
              does not change them.
            </p>
            <dl class="mt-3 space-y-3 text-sm">
              <div v-for="credential in credentials" :key="credential.name">
                <dt class="flex items-center justify-between gap-3 text-ink-faint">
                  <span>{{ credential.name.replaceAll('-', ' ') }}</span>
                  <button
                    v-if="credential.available"
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :title="revealed[credential.name] ? 'Hide' : 'Show'"
                    @click="revealCredential(credential.name)"
                  >
                    <component :is="revealed[credential.name] ? EyeOff : Eye" :size="14" aria-hidden="true" />
                    {{ revealed[credential.name] ? 'Hide' : 'Show' }}
                  </button>
                </dt>
                <dd class="mt-1 break-all font-mono text-ink-muted">
                  <template v-if="!credential.available">Not generated yet — install the server first.</template>
                  <template v-else>{{ revealed[credential.name] ?? '••••••••••••' }}</template>
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <section v-else-if="tab === 'console'" class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 class="text-sm font-semibold text-ink">Server console</h2>
            <p class="mt-0.5 text-xs text-ink-faint">
              {{ consoleState?.available ? 'Live service output' : 'Interactive console unavailable for this provider' }}
            </p>
          </div>
          <span v-if="consoleState?.kind" class="rounded-full bg-black/25 px-2 py-1 text-[0.65rem] uppercase tracking-wide text-ink-faint">
            {{ consoleState.kind }}
          </span>
        </div>
        <pre class="max-h-[60vh] min-h-72 overflow-y-auto bg-[#101617] p-4 font-mono text-xs leading-relaxed text-[#b7d6c3]">{{ consoleState?.lines.join('\n') || 'No console output yet.' }}</pre>
        <form v-if="consoleState?.kind === 'rcon'" class="flex gap-2 border-t border-line bg-black/15 p-3" @submit.prevent="sendConsoleCommand">
          <span class="self-center font-mono text-sm text-brand-bright">&gt;</span>
          <input v-model="consoleCommand" class="field flex-1 font-mono text-sm" :disabled="consoleBusy" placeholder="Enter a server command" autocomplete="off" />
          <button type="submit" class="btn btn-primary btn-sm" :disabled="consoleBusy || !consoleCommand.trim()">Send</button>
        </form>
      </section>

      <section v-else-if="tab === 'files'" class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div class="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <button type="button" class="text-brand-bright hover:underline" @click="goTo('')">data</button>
            <template v-for="crumb in breadcrumbs" :key="crumb.path">
              <span class="text-ink-faint">/</span>
              <button type="button" class="truncate text-brand-bright hover:underline" @click="goTo(crumb.path)">
                {{ crumb.name }}
              </button>
            </template>
          </div>
          <div class="flex gap-2">
            <button
              v-if="configFilePath"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              :title="`Open ${configFilePath} in the editor`"
              @click="openConfig"
            >
              <FileCog :size="14" aria-hidden="true" /> Server config
            </button>
            <button v-if="currentPath" type="button" class="btn btn-ghost btn-sm" @click="goUp">Up</button>
            <input ref="fileInput" type="file" class="hidden" @change="upload" />
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="chooseUpload">Upload</button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="creatingFolder = !creatingFolder">
              <FolderPlus :size="14" aria-hidden="true" /> New folder
            </button>
          </div>
        </div>

        <form v-if="creatingFolder" class="flex gap-2 border-b border-line p-3" @submit.prevent="createFolder">
          <input v-model="folderName" class="field flex-1" placeholder="Folder name" autofocus />
          <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !folderName.trim()">Create</button>
        </form>

        <div v-if="fileLoading" class="p-8"><LoadingBlock class="h-24" /></div>
        <div v-else-if="entries.length === 0" class="p-8 text-center text-sm text-ink-muted">This data folder is empty.</div>
        <ul v-else class="divide-y divide-line">
          <li v-for="entry in entries" :key="entry.path" class="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" @click="openEntry(entry)">
              <Folder v-if="entry.kind === 'directory'" :size="17" class="shrink-0 text-brand-bright" aria-hidden="true" />
              <File v-else :size="17" class="shrink-0 text-ink-faint" aria-hidden="true" />
              <span class="min-w-0 truncate text-sm text-ink">{{ entry.name }}</span>
              <span v-if="entry.kind === 'file'" class="ml-auto text-xs text-ink-faint">{{ formatBytes(entry.sizeBytes) }}</span>
            </button>
            <a
              v-if="entry.kind === 'file'"
              :href="gameDownloadUrl(slug, entry.path)"
              class="btn btn-ghost btn-sm"
              :download="entry.name"
              aria-label="Download file"
            >
              Download
            </a>
            <button type="button" class="btn btn-ghost btn-sm text-danger" :disabled="busy" :aria-label="`Delete ${entry.name}`" @click="removeEntry(entry)">
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </section>

      <GameWorkshopPanel v-else-if="tab === 'workshop'" :slug="slug" :is-admin="isAdmin" />

      <FileEditorDialog
        v-if="editingPath"
        :open="editingPath !== null"
        :game-server-slug="slug"
        :path="editingPath"
        @close="editingPath = null"
        @saved="loadFiles"
      />
    </template>
  </div>
</template>
