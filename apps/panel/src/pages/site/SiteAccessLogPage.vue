<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  Activity,
  Clock3,
  FileText,
  Filter,
  Globe2,
  RefreshCw,
  Search,
  Server,
  X,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { formatBytes, formatCount, timeAgo } from '../../lib/format';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';

/**
 * The request ledger for one website.
 *
 * Traffic answers how much moved. This page answers what moved, when, and
 * what the web server said back. It is deliberately a parsed view of Caddy's
 * log rather than raw JSON, so headers such as cookies and authorisation never
 * leave the agent.
 */

const route = useRoute();
const { site } = inject(siteContextKey)!;
const slug = computed(() => route.params['slug'] as string);

type AccessLog = Awaited<ReturnType<typeof api.sites.accessLog.query>>;
type StatusFilter = AccessLog['lines'][number] extends never
  ? 'all'
  : 'all' | '2xx' | '3xx' | '4xx' | '5xx';
type Range = AccessLog['range'];

const RANGES: Array<{ value: Range; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All responses' },
  { value: '2xx', label: 'Delivered' },
  { value: '3xx', label: 'Redirected' },
  { value: '4xx', label: 'Refused' },
  { value: '5xx', label: 'Errors' },
];

const range = ref<Range>('7d');
const status = ref<StatusFilter>('all');
const searchInput = ref('');
const search = ref('');
const result = ref<AccessLog | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const domainLabel = computed(() => site.value?.domains[0] ?? site.value?.displayName ?? slug.value);
const hasSearch = computed(() => search.value.length > 0);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    result.value = await api.sites.accessLog.query({
      slug: slug.value,
      range: range.value,
      status: status.value,
      ...(search.value ? { search: search.value } : {}),
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

function applySearch(): void {
  search.value = searchInput.value.trim();
  void load();
}

function clearSearch(): void {
  searchInput.value = '';
  search.value = '';
  void load();
}

watch([slug, range, status], load, { immediate: true });

function statusTone(value: number): string {
  if (value >= 500) return 'text-danger';
  if (value >= 400) return 'text-warn';
  if (value >= 300) return 'text-info';
  return 'text-ok';
}

function statusLabel(value: number): string {
  if (value >= 500) return 'Website error';
  if (value >= 400) return 'Request refused';
  if (value >= 300) return 'Redirect';
  return 'Delivered';
}

function duration(value: number): string {
  if (value < 1) return '<1 ms';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function exact(value: number): string {
  return new Date(value).toLocaleString();
}

function agent(value: string | undefined): string {
  if (!value) return 'Unknown visitor';
  return value.length > 46 ? `${value.slice(0, 46)}...` : value;
}
</script>

<template>
  <div class="space-y-6">
    <section class="relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-card md:p-6">
      <div class="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-linear-to-l from-brand-soft/25 to-transparent" />
      <div class="relative flex flex-wrap items-start justify-between gap-5">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-brand-bright">
            <FileText :size="14" aria-hidden="true" /> Request ledger
          </div>
          <h2 class="mt-2 truncate text-2xl font-semibold tracking-tight text-ink">{{ domainLabel }}</h2>
          <p class="mt-1 max-w-2xl text-sm text-ink-muted">
            Every request the web server has recorded for this website, including redirects and errors.
          </p>
        </div>

        <div class="flex items-center gap-2 rounded-lg border border-line bg-black/20 px-3 py-2 text-xs text-ink-muted">
          <span class="h-2 w-2 rounded-full" :class="result?.collecting ? 'bg-ok' : 'bg-ink-faint'" aria-hidden="true" />
          {{ result?.collecting ? 'Recording requests' : 'No requests recorded yet' }}
        </div>
      </div>

      <dl class="relative mt-6 grid gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-line bg-black/20 p-3">
          <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
            <Activity :size="13" aria-hidden="true" /> Matching requests
          </dt>
          <dd class="mt-1 text-xl font-semibold tabular-nums text-ink">
            {{ result ? formatCount(result.total) : '\u2014' }}
          </dd>
        </div>
        <div class="rounded-lg border border-line bg-black/20 p-3">
          <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
            <Clock3 :size="13" aria-hidden="true" /> Window
          </dt>
          <dd class="mt-1 text-xl font-semibold text-ink">{{ range }}</dd>
        </div>
        <div class="rounded-lg border border-line bg-black/20 p-3">
          <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
            <Globe2 :size="13" aria-hidden="true" /> Domains
          </dt>
          <dd class="mt-1 truncate text-sm font-medium text-ink" :title="site?.domains.join(', ')">
            {{ site?.domains.length ? site.domains.join(', ') : 'No domain assigned' }}
          </dd>
        </div>
      </dl>
    </section>

    <section class="card p-4 md:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-black/20 p-0.5">
          <button
            v-for="option in RANGES"
            :key="option.value"
            type="button"
            class="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            :class="range === option.value ? 'bg-brand-soft text-brand-bright' : 'text-ink-faint hover:text-ink'"
            :aria-pressed="range === option.value"
            @click="range = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="load">
          <RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div class="mt-4 flex flex-col gap-3 lg:flex-row">
        <div class="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-black/20 p-0.5">
          <button
            v-for="option in STATUS_FILTERS"
            :key="option.value"
            type="button"
            class="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
            :class="status === option.value ? 'bg-brand-soft text-brand-bright' : 'text-ink-faint hover:text-ink'"
            :aria-pressed="status === option.value"
            @click="status = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <form class="flex min-w-0 flex-1 gap-2" @submit.prevent="applySearch">
          <label class="relative min-w-0 flex-1">
            <span class="sr-only">Search requests</span>
            <Search :size="15" class="pointer-events-none absolute left-3 top-2.5 text-ink-faint" aria-hidden="true" />
            <input
              v-model="searchInput"
              type="search"
              class="field pl-9 pr-9"
              placeholder="Search route, host, visitor, or browser"
              maxlength="200"
            />
            <button
              v-if="searchInput"
              type="button"
              class="absolute right-2 top-1.5 rounded p-1 text-ink-faint hover:text-ink"
              aria-label="Clear search"
              @click="clearSearch"
            >
              <X :size="15" aria-hidden="true" />
            </button>
          </label>
          <button type="submit" class="btn btn-ghost shrink-0">
            <Filter :size="14" aria-hidden="true" /> Filter
          </button>
        </form>
      </div>

      <p v-if="hasSearch" class="mt-3 text-xs text-ink-faint">
        Showing matches for <span class="font-mono text-ink-muted">{{ search }}</span>.
      </p>
    </section>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>

    <EmptyState
      v-if="!loading && result && !result.collecting"
      :icon="FileText"
      title="No requests recorded yet"
      description="Once a visitor reaches this website through the web server, their request will appear here. Direct connections to the app port are not included."
    />

    <section v-else class="card overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-5">
        <div>
          <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
            <Server :size="15" class="text-brand-bright" aria-hidden="true" /> Recent requests
          </h3>
          <p class="mt-1 text-xs text-ink-faint">Newest first, up to 250 entries per view.</p>
        </div>
        <span v-if="result?.lines.length" class="font-mono text-xs text-ink-faint">
          {{ result.lines.length }} shown
        </span>
      </div>

      <LoadingBlock v-if="loading && !result" class="m-5 h-48 rounded-lg bg-sunken" />

      <template v-else-if="result">
        <div v-if="result.lines.length > 0" class="hidden overflow-x-auto md:block">
          <table class="w-full min-w-[960px] text-sm">
            <thead>
              <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th scope="col" class="px-4 py-3 font-medium md:px-5">When</th>
                <th scope="col" class="px-4 py-3 font-medium">Response</th>
                <th scope="col" class="px-4 py-3 font-medium">Request</th>
                <th scope="col" class="px-4 py-3 font-medium">Visitor</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Timing</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Transfer</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr v-for="(line, index) in result.lines" :key="`${line.at}-${index}`" class="align-top transition-colors hover:bg-white/[0.03]">
                <td class="whitespace-nowrap px-4 py-3 text-xs text-ink-faint md:px-5" :title="exact(line.at)">
                  {{ timeAgo(line.at) }}
                </td>
                <td class="whitespace-nowrap px-4 py-3">
                  <span class="font-mono font-semibold" :class="statusTone(line.status)">{{ line.status }}</span>
                  <span class="ml-1.5 text-xs text-ink-muted">{{ statusLabel(line.status) }}</span>
                </td>
                <td class="max-w-[24rem] px-4 py-3">
                  <div class="flex items-start gap-2">
                    <span class="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.65rem] text-ink-faint">{{ line.method }}</span>
                    <span class="break-all font-mono text-xs text-ink" :title="line.uri">{{ line.uri }}</span>
                  </div>
                  <p class="mt-1 truncate text-xs text-ink-faint" :title="line.host">{{ line.host || 'Unknown host' }}</p>
                </td>
                <td class="max-w-[15rem] px-4 py-3">
                  <p class="font-mono text-xs text-ink-muted">{{ line.remoteIp || 'Unknown address' }}</p>
                  <p class="mt-1 truncate text-xs text-ink-faint" :title="line.userAgent">{{ agent(line.userAgent) }}</p>
                </td>
                <td class="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-ink-muted">
                  {{ duration(line.durationMs) }}
                </td>
                <td class="whitespace-nowrap px-4 py-3 text-right text-xs text-ink-faint">
                  <span class="text-ink-muted">{{ formatBytes(line.bytesOut) }}</span> out
                  <br />
                  <span class="text-ink-muted">{{ formatBytes(line.bytesIn) }}</span> in
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="result.lines.length > 0" class="divide-y divide-line md:hidden">
          <article v-for="(line, index) in result.lines" :key="`${line.at}-${index}-compact`" class="space-y-3 px-4 py-4">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2">
                <span class="font-mono text-sm font-semibold" :class="statusTone(line.status)">{{ line.status }}</span>
                <span class="truncate text-xs text-ink-muted">{{ statusLabel(line.status) }}</span>
              </div>
              <time class="shrink-0 text-xs text-ink-faint" :title="exact(line.at)">{{ timeAgo(line.at) }}</time>
            </div>

            <div class="border-l-2 border-brand/40 pl-3">
              <div class="flex min-w-0 items-start gap-2">
                <span class="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.65rem] text-ink-faint">{{ line.method }}</span>
                <span class="min-w-0 break-all font-mono text-xs text-ink">{{ line.uri }}</span>
              </div>
              <p class="mt-1 break-all text-xs text-ink-faint">{{ line.host || 'Unknown host' }}</p>
            </div>

            <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div class="min-w-0">
                <dt class="uppercase tracking-wide text-[0.65rem] text-ink-faint">Visitor</dt>
                <dd class="mt-1 break-all font-mono text-ink-muted">{{ line.remoteIp || 'Unknown address' }}</dd>
                <dd class="mt-1 break-words text-ink-faint">{{ agent(line.userAgent) }}</dd>
              </div>
              <div>
                <dt class="uppercase tracking-wide text-[0.65rem] text-ink-faint">Timing</dt>
                <dd class="mt-1 font-mono text-ink-muted">{{ duration(line.durationMs) }}</dd>
              </div>
              <div>
                <dt class="uppercase tracking-wide text-[0.65rem] text-ink-faint">Transfer</dt>
                <dd class="mt-1 text-ink-muted">{{ formatBytes(line.bytesOut) }} out</dd>
                <dd class="mt-0.5 text-ink-muted">{{ formatBytes(line.bytesIn) }} in</dd>
              </div>
            </dl>
          </article>
        </div>

        <div v-else class="px-6 py-14 text-center">
          <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-brand-soft/50 text-brand-bright" aria-hidden="true">
            <Search :size="21" />
          </span>
          <h3 class="mt-4 text-base font-semibold text-ink">No matching requests</h3>
          <p class="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
            Try a wider time window, another response class, or clear the search.
          </p>
          <button v-if="search || status !== 'all'" type="button" class="btn btn-ghost mt-5" @click="status = 'all'; clearSearch()">
            Clear filters
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-xs text-ink-faint md:px-5">
          <span v-if="result.complete">Complete window read</span>
          <span v-else>Recent tail only</span>
          <span v-if="result.oldestAt">Oldest scanned {{ timeAgo(result.oldestAt) }}</span>
          <span v-if="result.lines.length >= 250">Showing the newest 250 matches</span>
        </div>
      </template>
    </section>
  </div>
</template>
