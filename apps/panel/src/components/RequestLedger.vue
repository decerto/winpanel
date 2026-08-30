<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Search, Server, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { formatBytes, timeAgo } from '../lib/format';
import AlertMessage from './AlertMessage.vue';
import LoadingBlock from './LoadingBlock.vue';
import Tooltip from './Tooltip.vue';

/**
 * Every request a website answered, one line each.
 *
 * The counters on the traffic page say how much moved; this says what moved,
 * when, and what the web server said back. It is a parsed view of the log
 * rather than raw JSON, so headers such as cookies and authorisation never
 * leave the agent.
 */

type AccessLog = Awaited<ReturnType<typeof api.sites.accessLog.query>>;
type Range = AccessLog['range'];
type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx';

const props = defineProps<{
  slug: string;
  range: Range;
  /** Driven from the traffic page's status chips, so both stay in step. */
  status: StatusFilter;
}>();

const searchInput = ref('');
const search = ref('');
const result = ref<AccessLog | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    result.value = await api.sites.accessLog.query({
      slug: props.slug,
      range: props.range,
      status: props.status,
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

watch(() => [props.slug, props.range, props.status], load, { immediate: true });

const hasSearch = computed(() => search.value.length > 0);

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
  <div class="space-y-4">
    <form class="flex min-w-0 gap-2" @submit.prevent="applySearch">
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
        <Tooltip v-if="searchInput" text="Clear search">
          <button
            type="button"
            class="absolute right-2 top-1.5 rounded p-1 text-ink-faint hover:text-ink"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <X :size="15" aria-hidden="true" />
          </button>
        </Tooltip>
      </label>
      <button type="submit" class="btn btn-ghost shrink-0">Search</button>
    </form>

    <p v-if="hasSearch" class="text-xs text-ink-faint">
      Showing matches for <span class="font-mono text-ink-muted">{{ search }}</span>.
    </p>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>

    <section class="overflow-hidden rounded-card border border-line">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h4 class="flex items-center gap-2 text-sm font-semibold text-ink">
          <Server :size="15" class="text-brand-bright" aria-hidden="true" /> Recent requests
        </h4>
        <span v-if="result?.lines.length" class="font-mono text-xs text-ink-faint">
          {{ result.lines.length }} shown
        </span>
      </div>

      <LoadingBlock v-if="loading && !result" class="m-4 h-40 rounded-lg bg-sunken" />

      <template v-else-if="result">
        <div v-if="result.lines.length > 0" class="hidden overflow-x-auto md:block">
          <table class="w-full min-w-[960px] text-sm">
            <thead>
              <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th scope="col" class="px-4 py-3 font-medium">When</th>
                <th scope="col" class="px-4 py-3 font-medium">Response</th>
                <th scope="col" class="px-4 py-3 font-medium">Request</th>
                <th scope="col" class="px-4 py-3 font-medium">Visitor</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Timing</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Transfer</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr
                v-for="(line, index) in result.lines"
                :key="`${line.at}-${index}`"
                class="align-top transition-colors hover:bg-white/[0.03]"
              >
                <td class="whitespace-nowrap px-4 py-3 text-xs text-ink-faint" :title="exact(line.at)">
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

        <div v-else class="px-6 py-12 text-center">
          <Search :size="20" class="mx-auto text-ink-faint" aria-hidden="true" />
          <p class="mt-3 text-sm text-ink-muted">
            No requests here match. Try a wider window, another response class, or clear the search.
          </p>
          <button v-if="hasSearch" type="button" class="btn btn-ghost btn-sm mt-4" @click="clearSearch">
            Clear search
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-xs text-ink-faint">
          <span v-if="result.complete">Complete window read</span>
          <span v-else>Recent tail only</span>
          <span v-if="result.oldestAt">Oldest scanned {{ timeAgo(result.oldestAt) }}</span>
          <span v-if="result.lines.length >= 250">Showing the newest 250 matches</span>
        </div>
      </template>
    </section>
  </div>
</template>
