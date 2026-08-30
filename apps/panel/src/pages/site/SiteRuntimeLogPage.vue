<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  AlertTriangle,
  Bug,
  CircleAlert,
  FileText,
  Info,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  X,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { formatBytes, timeAgo } from '../../lib/format';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';
import Tooltip from '../../components/Tooltip.vue';

/**
 * What this website's own application has been saying.
 *
 * Deliberately not the request log: that lives on Traffic, where the counts
 * it belongs to are. This is the other half of "my site is broken" — the
 * stack trace, the failed database connection, the port that was already in
 * use. Read straight off the site's service output on disk.
 */

const route = useRoute();
const { site } = inject(siteContextKey)!;
const slug = computed(() => route.params['slug'] as string);

type LogInfo = Awaited<ReturnType<typeof api.sites.runtimeLogs.query>>[number];
type RuntimeLog = Awaited<ReturnType<typeof api.sites.runtimeLog.query>>;
type LevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';

const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
  { value: 'debug', label: 'Debug' },
];

const logs = ref<LogInfo[]>([]);
const selectedId = ref<string | null>(null);
const selected = ref<RuntimeLog | null>(null);
const loading = ref(true);
const reading = ref(false);
const error = ref<string | null>(null);
const level = ref<LevelFilter>('all');
const search = ref('');
let refreshTimer: number | null = null;

const domainLabel = computed(() => site.value?.domains[0] ?? site.value?.displayName ?? slug.value);

const visibleLines = computed(() => {
  const needle = search.value.trim().toLowerCase();

  return (selected.value?.lines ?? []).filter((line) => {
    const levelMatches =
      level.value === 'all' ||
      (level.value === 'error'
        ? line.level === 'error' || line.level === 'fatal'
        : line.level === level.value);
    const searchMatches =
      !needle || line.message.toLowerCase().includes(needle) || line.raw.toLowerCase().includes(needle);
    return levelMatches && searchMatches;
  });
});

const selectedInfo = computed(() => logs.value.find((log) => log.id === selectedId.value) ?? null);
const hasFilters = computed(() => level.value !== 'all' || search.value.trim().length > 0);

/**
 * Names the files a website's service leaves behind.
 *
 * The service id is not something the owner chose, so the raw filename means
 * little on its own; what matters is which stream it is and which half of the
 * blue/green pair wrote it.
 */
function labelFor(id: string): string {
  if (id === 'php-error.log') return 'PHP errors';

  const stream = id.endsWith('.err.log') ? 'Error output' : id.endsWith('.out.log') ? 'Standard output' : 'Output';
  if (/-blue\./.test(id)) return `${stream} (blue release)`;
  if (/-green\./.test(id)) return `${stream} (green release)`;
  return stream;
}

function iconFor(id: string) {
  if (id === 'php-error.log') return CircleAlert;
  return id.endsWith('.err.log') ? CircleAlert : Terminal;
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
    selected.value = await api.sites.runtimeLog.query({ slug: slug.value, id, lines: 500 });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    reading.value = false;
  }
}

async function choose(id: string): Promise<void> {
  selectedId.value = id;
  await read(id);
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const next = await api.sites.runtimeLogs.query({ slug: slug.value });
    logs.value = next;

    if (!selectedId.value || !next.some((log) => log.id === selectedId.value)) {
      // Whatever recorded a failure first: it is the reason anyone opens this page.
      selectedId.value =
        next.find((log) => log.id === 'php-error.log')?.id ??
        next.find((log) => log.id.endsWith('.err.log'))?.id ??
        next[0]?.id ??
        null;
    }

    await read();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

watch(slug, () => {
  selectedId.value = null;
  selected.value = null;
  void refresh();
});

onMounted(() => {
  void refresh();
  // A running app keeps writing while the page is open; follow it without
  // making the view jump to another file.
  refreshTimer = window.setInterval(() => void refresh(), 30_000);
});

onUnmounted(() => {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="space-y-6">
    <section class="relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-card md:p-6">
      <div class="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-linear-to-l from-brand-soft/25 to-transparent" />
      <div class="relative flex flex-wrap items-start justify-between gap-5">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-brand-bright">
            <ScrollText :size="14" aria-hidden="true" /> Application output
          </div>
          <h2 class="mt-2 truncate text-2xl font-semibold tracking-tight text-ink">{{ domainLabel }}</h2>
          <p class="mt-1 max-w-2xl text-sm text-ink-muted">
            What this website&#8217;s own process has written &#8212; startup messages, warnings and
            crashes. Visitor requests are counted on the Traffic tab.
          </p>
        </div>

        <button type="button" class="btn btn-ghost shrink-0" :disabled="loading || reading" @click="refresh">
          <RefreshCw :size="15" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </section>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>

    <LoadingBlock v-if="loading && logs.length === 0 && !error" class="h-48 rounded-card bg-sunken" />

    <EmptyState
      v-else-if="logs.length === 0"
      :icon="ScrollText"
      title="No application output yet"
      description="This website has not written a runtime log. Static websites have no process to log; a Node, .NET or PHP site starts writing here the first time its service runs."
    />

    <section v-else class="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside class="card overflow-hidden">
        <div class="border-b border-line px-4 py-3">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-ink">Log files</h3>
            <span class="font-mono text-xs text-ink-faint">{{ logs.length }}</span>
          </div>
          <p class="mt-1 text-xs text-ink-faint">Written by this website&#8217;s service.</p>
        </div>

        <nav class="max-h-[32rem] overflow-y-auto p-2" aria-label="Website log files">
          <button
            v-for="log in logs"
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
              <span class="block truncate text-xs font-medium">{{ log.id }}</span>
              <span class="mt-1 flex items-center justify-between gap-2 text-[0.65rem] text-ink-faint">
                <span class="truncate">{{ labelFor(log.id) }}</span>
                <span class="font-mono">{{ formatBytes(log.size) }}</span>
              </span>
            </span>
          </button>
        </nav>
      </aside>

      <section class="card min-w-0 overflow-hidden">
        <div class="border-b border-line px-4 py-4 md:px-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 items-start gap-3">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft/50 text-brand-bright" aria-hidden="true">
                <FileText :size="17" />
              </span>
              <div class="min-w-0">
                <h3 class="truncate font-mono text-sm font-semibold text-ink">{{ selectedId }}</h3>
                <p v-if="selectedInfo" class="mt-1 text-xs text-ink-faint">
                  {{ labelFor(selectedInfo.id) }} &#183; {{ formatBytes(selectedInfo.size) }} &#183;
                  updated {{ timeAgo(selectedInfo.modifiedAt) }}
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
                v-for="option in LEVELS"
                :key="option.value"
                type="button"
                class="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                :class="level === option.value ? 'bg-brand-soft text-brand-bright' : 'text-ink-faint hover:text-ink'"
                :aria-pressed="level === option.value"
                @click="level = option.value"
              >
                {{ option.label }}
              </button>
            </div>

            <label class="relative min-w-0 flex-1">
              <span class="sr-only">Search this log</span>
              <Search :size="15" class="pointer-events-none absolute left-3 top-2.5 text-ink-faint" aria-hidden="true" />
              <input v-model="search" type="search" class="field pl-9 pr-9" placeholder="Search this log" />
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
          <div class="bg-black/30 p-2 md:p-3">
            <div class="max-h-[42rem] overflow-auto rounded-lg border border-line bg-[#111016] p-2 font-mono text-xs leading-relaxed shadow-inner md:p-3">
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
              </div>

              <div v-if="visibleLines.length === 0" class="px-6 py-14 text-center font-sans">
                <Search :size="20" class="mx-auto text-ink-faint" aria-hidden="true" />
                <p class="mt-3 text-sm text-ink-muted">
                  {{ hasFilters ? 'No lines match these filters.' : 'This file is empty.' }}
                </p>
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
            <span v-if="selected.modifiedAt" class="ml-auto" :title="exact(selected.modifiedAt)">
              Updated {{ timeAgo(selected.modifiedAt) }}
            </span>
          </footer>
        </template>
      </section>
    </section>
  </div>
</template>
