<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  AlertTriangle,
  Bug,
  ChevronDown,
  CircleAlert,
  FileText,
  Info,
  RefreshCw,
  Search,
  ServerCog,
  Terminal,
  X,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { formatBytes, timeAgo } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';
import Tooltip from '../components/Tooltip.vue';

/**
 * Runtime output for the panel itself.
 *
 * This is intentionally separate from sign-in activity and from website
 * request logs. It is the owner's view into what the agent and its managed
 * services have been saying on disk, with the API keeping the boundary owner-only.
 */

type LogInfo = Awaited<ReturnType<typeof api.logs.list.query>>[number];
type PanelLog = Awaited<ReturnType<typeof api.logs.read.query>>;
type LevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';

const logs = ref<LogInfo[]>([]);
const selectedId = ref<string | null>(null);
const selected = ref<PanelLog | null>(null);
const loading = ref(true);
const reading = ref(false);
const error = ref<string | null>(null);
const level = ref<LevelFilter>('all');
const search = ref('');
const fileSearch = ref('');
const categoryFilter = ref('all');
const expandedGroups = ref(new Set<string>(['Panel']));
let refreshTimer: number | null = null;

const visibleLines = computed(() => {
  const needle = search.value.trim().toLowerCase();

  return (selected.value?.lines ?? []).filter((line) => {
    const levelMatches =
      level.value === 'all' ||
      (level.value === 'error' ? line.level === 'error' || line.level === 'fatal' : line.level === level.value);
    const searchMatches =
      !needle || line.message.toLowerCase().includes(needle) || line.raw.toLowerCase().includes(needle);
    return levelMatches && searchMatches;
  });
});

const selectedInfo = computed(() => logs.value.find((log) => log.id === selectedId.value) ?? null);
const hasFilters = computed(() => level.value !== 'all' || search.value.trim().length > 0);

/**
 * Which service wrote a file, from the folder the agent gives it.
 *
 * Everything the panel runs logs into one tree, so without this the list is a
 * wall of near-identical service ids and finding out why mail stopped means
 * reading all of them.
 */
const SERVICES: Record<string, string> = {
  caddy: 'Web server',
  stalwart: 'Mail',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  mongodb: 'MongoDB',
};

function serviceOf(id: string): string {
  const folder = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  return SERVICES[folder] ?? (folder === '' ? 'Panel' : folder);
}

function groupLogs(fileLogs: LogInfo[]): { service: string; files: LogInfo[] }[] {
  const byService = new Map<string, LogInfo[]>();

  for (const log of fileLogs) {
    const service = serviceOf(log.id);
    byService.set(service, [...(byService.get(service) ?? []), log]);
  }

  return [...byService.entries()]
    .map(([service, files]) => ({
      service,
      files: files.sort(
        (left, right) =>
          right.modifiedAt.getTime() - left.modifiedAt.getTime() || left.id.localeCompare(right.id),
      ),
    }))
    .sort((a, b) =>
      a.service === 'Panel' ? -1 : b.service === 'Panel' ? 1 : a.service.localeCompare(b.service),
    );
}

const allGroups = computed(() => groupLogs(logs.value));
const categoryOptions = computed(() => [
  { value: 'all', label: 'All', count: logs.value.length },
  ...allGroups.value.map((group) => ({ value: group.service, label: group.service, count: group.files.length })),
]);
const filteredLogs = computed(() => {
  const needle = fileSearch.value.trim().toLowerCase();
  return logs.value.filter((log) => {
    if (categoryFilter.value !== 'all' && serviceOf(log.id) !== categoryFilter.value) return false;
    if (!needle) return true;
    return [log.id, fileNameOf(log.id), labelFor(log.id)].some((value) => value.toLowerCase().includes(needle));
  });
});
const groups = computed(() => groupLogs(filteredLogs.value));

function isGroupExpanded(service: string): boolean {
  return (
    expandedGroups.value.has(service) ||
    categoryFilter.value === service ||
    fileSearch.value.trim().length > 0
  );
}

function toggleGroup(service: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(service)) next.delete(service);
  else next.add(service);
  expandedGroups.value = next;
}

function expandGroupFor(id: string): void {
  const next = new Set(expandedGroups.value);
  next.add(serviceOf(id));
  expandedGroups.value = next;
}

function clearFileSearch(): void {
  fileSearch.value = '';
}

/** The filename on its own; the folder is already said by the section it is in. */
function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

function labelFor(id: string): string {
  if (id.endsWith('.err.log')) return 'Error output';
  if (id.endsWith('.out.log')) return 'Standard output';
  if (id.includes('update')) return 'Panel updates';
  return 'Runtime log';
}

function iconFor(id: string) {
  if (id.endsWith('.err.log')) return CircleAlert;
  if (id.includes('update')) return RefreshCw;
  return Terminal;
}

function levelIcon(levelName: string) {
  if (levelName === 'error' || levelName === 'fatal') return CircleAlert;
  if (levelName === 'warn') return AlertTriangle;
  if (levelName === 'debug') return Bug;
  return Info;
}

function levelTone(levelName: string): string {
  if (levelName === 'error' || levelName === 'fatal') return 'text-danger';
  if (levelName === 'warn') return 'text-warn';
  if (levelName === 'debug') return 'text-ink-faint';
  return 'text-info';
}

function exact(value: Date | number): string {
  return new Date(value).toLocaleString();
}

function displayTime(value: number | null): string {
  return value === null ? '--:--:--' : new Date(value).toLocaleTimeString();
}

function clearFilters(): void {
  level.value = 'all';
  search.value = '';
}

async function read(id: string | null = selectedId.value): Promise<void> {
  if (!id) {
    selected.value = null;
    return;
  }

  reading.value = true;
  error.value = null;

  try {
    selected.value = await api.logs.read.query({ id, lines: 500 });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    reading.value = false;
  }
}

async function choose(id: string): Promise<void> {
  selectedId.value = id;
  expandGroupFor(id);
  await read(id);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const next = await api.logs.list.query();
    logs.value = next;

    if (!selectedId.value || !next.some((log) => log.id === selectedId.value)) {
      selectedId.value = next[0]?.id ?? null;
    }

    if (selectedId.value) expandGroupFor(selectedId.value);

    await read();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  // Service output changes while the owner is watching it; refresh the selected
  // tail without making the page jump to another file.
  refreshTimer = window.setInterval(() => void refresh(), 30_000);
});

onUnmounted(() => {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="mx-auto w-full max-w-7xl">
    <PageHeader
      title="Panel logs"
      description="Runtime output from the panel and every service it runs for you — the web server, mail and the database engines. Websites log on their own Logs tab, and a game world's console stays with the game server."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="loading || reading" @click="refresh">
          <RefreshCw :size="15" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          Refresh
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

    <EmptyState
      v-if="!loading && logs.length === 0"
      :icon="ServerCog"
      title="No panel logs yet"
      description="The panel has not written a runtime log in its logs folder yet. Start or restart a managed service, then come back here."
    />

    <section v-else class="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside
        class="card flex min-h-0 flex-col overflow-hidden lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)] lg:max-h-[calc(100vh-8rem)]"
      >
        <div class="border-b border-line px-4 py-3">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold text-ink">Log files</h2>
            <span class="font-mono text-xs text-ink-faint">
              {{ filteredLogs.length }}<span v-if="filteredLogs.length !== logs.length"> / {{ logs.length }}</span>
            </span>
          </div>
          <p class="mt-1 text-xs text-ink-faint">Find output by service or filename.</p>

          <label class="relative mt-3 block">
            <span class="sr-only">Filter log files</span>
            <Search :size="14" class="pointer-events-none absolute left-2.5 top-2.5 text-ink-faint" aria-hidden="true" />
            <input
              v-model="fileSearch"
              type="search"
              class="field h-9 pl-8 pr-8 text-xs"
              placeholder="Filter files"
              maxlength="100"
            />
            <Tooltip v-if="fileSearch" text="Clear file filter">
              <button
                type="button"
                class="absolute right-2 top-1.5 rounded p-1 text-ink-faint hover:text-ink"
                aria-label="Clear file filter"
                @click="clearFileSearch"
              >
                <X :size="14" aria-hidden="true" />
              </button>
            </Tooltip>
          </label>
        </div>

        <div class="border-b border-line px-2 py-2">
          <div class="flex gap-1 overflow-x-auto pb-0.5" aria-label="Log categories">
            <button
              v-for="option in categoryOptions"
              :key="option.value"
              type="button"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
              :class="
                categoryFilter === option.value
                  ? 'bg-brand-soft text-brand-bright'
                  : 'text-ink-faint hover:bg-white/[0.04] hover:text-ink'
              "
              :aria-pressed="categoryFilter === option.value"
              @click="categoryFilter = option.value"
            >
              {{ option.label }}
              <span class="font-mono text-[0.65rem] opacity-70">{{ option.count }}</span>
            </button>
          </div>
        </div>

        <nav class="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Panel log files">
          <section v-for="group in groups" :key="group.service" class="mb-3 last:mb-0">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-ink-faint hover:bg-white/[0.04] hover:text-ink"
              :aria-expanded="isGroupExpanded(group.service)"
              @click="toggleGroup(group.service)"
            >
              <ChevronDown
                :size="13"
                class="shrink-0 transition-transform"
                :class="isGroupExpanded(group.service) ? '' : '-rotate-90'"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate">{{ group.service }}</span>
              <span class="font-mono text-[0.65rem] font-normal">{{ group.files.length }}</span>
            </button>

            <div v-if="isGroupExpanded(group.service)" class="mt-1">
              <button
                v-for="log in group.files"
                :key="log.id"
                type="button"
                class="mb-1 flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors last:mb-0"
                :class="
                  selectedId === log.id
                    ? 'border-brand/50 bg-brand-soft/60 text-ink'
                    : 'border-transparent text-ink-muted hover:border-line hover:bg-white/[0.04] hover:text-ink'
                "
                @click="choose(log.id)"
              >
                <component
                  :is="iconFor(log.id)"
                  :size="15"
                  class="mt-0.5 shrink-0"
                  :class="selectedId === log.id ? 'text-brand-bright' : 'text-ink-faint'"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium">{{ fileNameOf(log.id) }}</span>
                  <span class="mt-1 flex items-center justify-between gap-2 text-[0.65rem] text-ink-faint">
                    <span class="truncate">{{ labelFor(log.id) }}</span>
                    <span class="font-mono">{{ formatBytes(log.size) }}</span>
                  </span>
                </span>
              </button>
            </div>
          </section>

          <p v-if="groups.length === 0" class="px-3 py-8 text-center text-xs text-ink-muted">
            No log files match this filter.
          </p>
        </nav>
      </aside>

      <section
        class="card flex min-h-0 min-w-0 flex-col overflow-hidden lg:h-[calc(100vh-8rem)] lg:max-h-[calc(100vh-8rem)]"
      >
        <div class="border-b border-line px-4 py-4 md:px-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 items-start gap-3">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft/50 text-brand-bright" aria-hidden="true">
                <FileText :size="17" />
              </span>
              <div class="min-w-0">
                <h2 class="truncate font-mono text-sm font-semibold text-ink">{{ selectedId }}</h2>
                <p v-if="selectedInfo" class="mt-1 text-xs text-ink-faint">
                  {{ serviceOf(selectedInfo.id) }} · {{ labelFor(selectedInfo.id) }} ·
                  {{ formatBytes(selectedInfo.size) }} · updated {{ timeAgo(selectedInfo.modifiedAt) }}
                </p>
              </div>
            </div>
            <span v-if="selected" class="rounded-full bg-info-soft/60 px-2.5 py-1 text-xs text-info">
              Last 500 lines
            </span>
          </div>

          <div class="mt-4 flex flex-col gap-3 md:flex-row">
            <div class="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-black/20 p-0.5">
              <button
                v-for="option in [
                  { value: 'all', label: 'All' },
                  { value: 'info', label: 'Info' },
                  { value: 'warn', label: 'Warnings' },
                  { value: 'error', label: 'Errors' },
                  { value: 'debug', label: 'Debug' },
                ]"
                :key="option.value"
                type="button"
                class="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                :class="level === option.value ? 'bg-brand-soft text-brand-bright' : 'text-ink-faint hover:text-ink'"
                :aria-pressed="level === option.value"
                @click="level = option.value as LevelFilter"
              >
                {{ option.label }}
              </button>
            </div>

            <label class="relative min-w-0 flex-1">
              <span class="sr-only">Search panel logs</span>
              <Search :size="15" class="pointer-events-none absolute left-3 top-2.5 text-ink-faint" aria-hidden="true" />
              <input
                v-model="search"
                type="search"
                class="field pl-9 pr-9"
                placeholder="Search this log"
              />
              <Tooltip v-if="search" text="Clear log search">
                <button
                  type="button"
                  class="absolute right-2 top-1.5 rounded p-1 text-ink-faint hover:text-ink"
                  aria-label="Clear log search"
                  @click="search = ''"
                >
                  <X :size="15" aria-hidden="true" />
                </button>
              </Tooltip>
            </label>
          </div>
        </div>

        <LoadingBlock v-if="reading && !selected" class="m-5 h-56 rounded-lg bg-sunken" />

        <template v-else-if="selected">
          <div class="min-h-0 flex-1 bg-black/30 p-2 md:p-3">
            <div class="h-full min-h-[24rem] overflow-auto rounded-lg border border-line bg-[#111016] p-2 font-mono text-xs leading-relaxed shadow-inner md:p-3">
              <div
                v-for="(line, index) in visibleLines"
                :key="`${index}-${line.raw}`"
                class="group flex min-w-0 flex-wrap items-start gap-3 rounded px-2 py-1.5 transition-colors hover:bg-white/[0.04] md:flex-nowrap"
              >
                <span class="w-7 shrink-0 select-none text-right text-[0.65rem] text-ink-faint/60">{{ index + 1 }}</span>
                <span class="w-[4.75rem] shrink-0 text-[0.65rem] text-ink-faint" :title="line.at === null ? '' : exact(line.at)">
                  {{ displayTime(line.at) }}
                </span>
                <span class="flex w-[4.5rem] shrink-0 items-center gap-1.5 uppercase" :class="levelTone(line.level)">
                  <component :is="levelIcon(line.level)" :size="12" aria-hidden="true" />
                  <span class="text-[0.65rem]">{{ line.level }}</span>
                </span>
                <span class="basis-full min-w-0 whitespace-pre-wrap break-words text-ink md:basis-auto md:flex-1">{{ line.message }}</span>
                <details v-if="line.raw !== line.message" class="basis-full min-w-0 text-ink-faint md:basis-auto md:shrink">
                  <summary class="cursor-pointer select-none text-[0.65rem] hover:text-brand-bright">raw</summary>
                  <pre class="mt-2 max-w-full whitespace-pre-wrap break-all rounded border border-line bg-black/30 p-2 text-[0.65rem] text-ink-muted">{{ line.raw }}</pre>
                </details>
              </div>

              <div v-if="visibleLines.length === 0" class="px-6 py-14 text-center font-sans">
                <Search :size="20" class="mx-auto text-ink-faint" aria-hidden="true" />
                <p class="mt-3 text-sm text-ink-muted">No lines match these filters.</p>
                <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm mt-4" @click="clearFilters">
                  Clear filters
                </button>
              </div>
            </div>
          </div>

          <footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-xs text-ink-faint md:px-5">
            <span>{{ visibleLines.length }} shown</span>
            <span v-if="selected.truncated">Recent tail only; older output is not loaded.</span>
            <span v-else>Full file loaded.</span>
            <span v-if="selected.modifiedAt" class="ml-auto" :title="exact(selected.modifiedAt)">Updated {{ timeAgo(selected.modifiedAt) }}</span>
          </footer>
        </template>
      </section>
    </section>
  </div>
</template>
