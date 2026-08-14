<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Gauge, RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { formatBytes, formatCount, timeAgo } from '../../lib/format';
import AlertMessage from '../../components/AlertMessage.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';

/**
 * What this website has actually served.
 *
 * Counted from the web server's own request log rather than from anything
 * inside the site, which is the only place the whole picture exists: a static
 * site has no process to ask, and an application behind the proxy never sees
 * the requests it did not handle. It also means the figures are the same ones
 * a host would bill on — every byte that left the machine on this website's
 * behalf, including redirects, errors and files served straight off disk.
 *
 * Deliberately not analytics. There is no attempt to count people, follow
 * them between pages or guess where they came from; that needs cookies and a
 * privacy policy, and it answers a different question from "is my hosting
 * about to cost me more".
 */

const route = useRoute();
const slug = computed(() => route.params['slug'] as string);

type Traffic = Awaited<ReturnType<typeof api.sites.traffic.query>>;
type Failures = Awaited<ReturnType<typeof api.sites.trafficErrors.query>>;
type Requests = Awaited<ReturnType<typeof api.sites.trafficRequests.query>>;
type Range = Traffic['range'];

const RANGES = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
] as const;

/** Which number the chart draws. The other two stay in the summary above it. */
const METRICS = [
  { value: 'requests', label: 'Requests' },
  { value: 'bytesOut', label: 'Data out' },
  { value: 'bytesIn', label: 'Data in' },
] as const;

type Metric = (typeof METRICS)[number]['value'];

const range = ref<Range>('7d');
const metric = ref<Metric>('requests');

const traffic = ref<Traffic | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

/**
 * The requests behind the error counts.
 *
 * Fetched separately because it is read out of the log files rather than the
 * counters, and only asked for when something has actually failed — a website
 * answering everything has nothing here to show.
 */
const failures = ref<Failures | null>(null);
const failuresLoading = ref(false);
const failuresError = ref<string | null>(null);

/**
 * The requests that succeeded, the other half of the picture.
 *
 * Fetched on the same trigger as the failures, so both lists describe the
 * same window. A healthy site has plenty to show here and nothing to show in
 * the failures, which is exactly the answer "is anything actually using this".
 */
const requests = ref<Requests | null>(null);
const requestsLoading = ref(false);
const requestsError = ref<string | null>(null);

/*
 * One list, not two. A visitor's request either worked or it didn't, and
 * splitting those into separate boxes made the page answer "what happened" in
 * two places. So both scans land in the same table, and the status classes
 * become filters on it rather than separate sections.
 */
type ClassFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx';
type View = 'grouped' | 'latest';
type GroupSort = 'count' | 'address' | 'answer' | 'recent';
type LatestSort = 'recent' | 'address' | 'answer';

/** Set by clicking a band in “what the server answered”, or the class chips. */
const classFilter = ref<ClassFilter>('all');
const view = ref<View>('grouped');
const groupSort = ref<GroupSort>('count');
const latestSort = ref<LatestSort>('recent');

async function loadFailures(): Promise<void> {
  failuresLoading.value = true;
  failuresError.value = null;

  try {
    failures.value = await api.sites.trafficErrors.query({
      slug: slug.value,
      range: range.value,
    });
  } catch (err) {
    failuresError.value = describeError(err);
  } finally {
    failuresLoading.value = false;
  }
}

async function loadRequests(): Promise<void> {
  requestsLoading.value = true;
  requestsError.value = null;

  try {
    requests.value = await api.sites.trafficRequests.query({
      slug: slug.value,
      range: range.value,
    });
  } catch (err) {
    requestsError.value = describeError(err);
  } finally {
    requestsLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    traffic.value = await api.sites.traffic.query({ slug: slug.value, range: range.value });

    const totals = traffic.value.summary;
    if (totals.status4xx + totals.status5xx > 0) {
      await loadFailures();
    } else {
      failures.value = null;
    }

    const succeeded = totals.status2xx + totals.status3xx;
    if (succeeded > 0) {
      await loadRequests();
    } else {
      requests.value = null;
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

watch([slug, range], load, { immediate: true });

const summary = computed(() => traffic.value?.summary ?? null);

/** Hourly points carry a time; daily ones only need the date. */
const hourly = computed(() => range.value === '24h' || range.value === '7d');

function labelFor(at: Date): string {
  return hourly.value
    ? new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric' })
    : new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function valueOf(point: Traffic['points'][number]): number {
  return point[metric.value];
}

function describeValue(value: number): string {
  return metric.value === 'requests' ? formatCount(value) : formatBytes(value);
}

const peak = computed(() => Math.max(1, ...(traffic.value?.points ?? []).map(valueOf)));

/**
 * Bars, as percentages of the tallest.
 *
 * A quiet interval still gets a sliver of height so the axis reads as a
 * timeline with gaps in it rather than as a chart that stops early.
 */
const bars = computed(() =>
  (traffic.value?.points ?? []).map((point) => {
    const value = valueOf(point);
    return {
      key: new Date(point.at).getTime(),
      value,
      height: value === 0 ? 0 : Math.max(2, Math.round((value / peak.value) * 100)),
      failed: point.status5xx > 0,
      title: `${labelFor(point.at)} \u2014 ${describeValue(value)}`,
    };
  }),
);

/** The share each status class took, for the bar under the chart. */
const statusBands = computed(() => {
  const totals = summary.value;
  if (!totals || totals.requests === 0) return [];

  return [
    { label: 'Delivered', key: '2xx', count: totals.status2xx, tint: 'bg-ok' },
    { label: 'Redirected', key: '3xx', count: totals.status3xx, tint: 'bg-info' },
    { label: 'Not found or refused', key: '4xx', count: totals.status4xx, tint: 'bg-warn' },
    { label: 'Website errors', key: '5xx', count: totals.status5xx, tint: 'bg-danger' },
  ]
    .filter((band) => band.count > 0)
    .map((band) => ({
      ...band,
      share: (band.count / totals.requests) * 100,
      /** Every class narrows the table below it now, not just the failures. */
      inspectable: true,
    }));
});

/** The band under the chart narrows the table; clicking it again undoes that. */
function inspect(key: string): void {
  classFilter.value = classFilter.value === key ? 'all' : (key as ClassFilter);
}

function classOf(status: number): ClassFilter {
  return (`${Math.floor(status / 100)}xx`) as ClassFilter;
}

function inFilter(status: number): boolean {
  return classFilter.value === 'all' || classOf(status) === classFilter.value;
}

/** One row per grouped route, merging the failed and the successful scans. */
interface Row {
  status: number;
  method: string;
  path: string;
  count: number;
  lastAt: number;
}

const allGroups = computed<Row[]>(() => [
  ...(failures.value?.groups ?? []),
  ...(requests.value?.groups ?? []),
]);

const visibleGroups = computed<Row[]>(() => {
  const rows = allGroups.value.filter((row) => inFilter(row.status));
  const by = groupSort.value;

  return [...rows].sort((a, b) => {
    if (by === 'count') return b.count - a.count || b.lastAt - a.lastAt;
    if (by === 'address') return a.path.localeCompare(b.path) || b.count - a.count;
    if (by === 'answer') return a.status - b.status || b.count - a.count;
    return b.lastAt - a.lastAt;
  });
});

/** The individual requests behind the rows, newest first unless re-sorted. */
interface Entry {
  at: number;
  status: number;
  method: string;
  uri: string;
}

const allRecent = computed<Entry[]>(() => [
  ...(failures.value?.recent ?? []),
  ...(requests.value?.recent ?? []),
]);

const visibleRecent = computed<Entry[]>(() => {
  const rows = allRecent.value.filter((row) => inFilter(row.status));
  const by = latestSort.value;

  return [...rows].sort((a, b) => {
    if (by === 'address') return a.uri.localeCompare(b.uri) || b.at - a.at;
    if (by === 'answer') return a.status - b.status || b.at - a.at;
    return b.at - a.at;
  });
});

/** True while either scan is in flight, so the table shows one spinner. */
const tableLoading = computed(() => failuresLoading.value || requestsLoading.value);

/** The first scan failure, if any — one message rather than one per scan. */
const tableError = computed(() => failuresError.value ?? requestsError.value);

/** True once at least one scan has returned, so the table has something to render. */
const tableReady = computed(() => failures.value !== null || requests.value !== null);

const TABLE_SORTS: Record<View, { value: string; label: string }[]> = {
  grouped: [
    { value: 'count', label: 'Busiest' },
    { value: 'address', label: 'Address' },
    { value: 'answer', label: 'Answer' },
    { value: 'recent', label: 'Most recent' },
  ],
  latest: [
    { value: 'recent', label: 'Most recent' },
    { value: 'address', label: 'Address' },
    { value: 'answer', label: 'Answer' },
  ],
};

const CLASS_FILTERS: { value: ClassFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '2xx', label: 'Delivered' },
  { value: '3xx', label: 'Redirected' },
  { value: '4xx', label: 'Not found / refused' },
  { value: '5xx', label: 'Errors' },
];

/**
 * What a status code means, without the jargon.
 *
 * The number stays on screen for anyone who wants to search for it; the words
 * are there so the person who owns the website can tell “someone probed a URL
 * that was never there” apart from “my application fell over”.
 */
const STATUS_WORDS: Record<number, string> = {
  400: 'Malformed request',
  401: 'Sign-in required',
  403: 'Refused',
  404: 'Not found',
  405: 'Method not allowed',
  408: 'Visitor timed out',
  413: 'Upload too large',
  429: 'Rate limited',
  499: 'Visitor gave up',
  500: 'Application error',
  502: 'Application not responding',
  503: 'Application unavailable',
  504: 'Application too slow',
};

function describeStatus(status: number): string {
  if (STATUS_WORDS[status]) return STATUS_WORDS[status];
  if (status >= 500) return 'Website error';
  if (status >= 400) return 'Request refused';
  if (status >= 300) return 'Redirect';
  return 'Delivered';
}

function statusTint(status: number): string {
  return status >= 500 ? 'text-danger' : status >= 400 ? 'text-warn' : 'text-ok';
}

function whenExact(at: number): string {
  return new Date(at).toLocaleString();
}

/** True when the logs no longer reach back as far as the selected range. */
const partialLog = computed(
  () =>
    (failures.value !== null && !failures.value.complete) ||
    (requests.value !== null && !requests.value.complete),
);

/** The oldest entry either scan reached, for the "only goes back to" note. */
const oldestLogAt = computed(() => {
  const stamps = [failures.value?.oldestAt, requests.value?.oldestAt].filter(
    (at): at is number => at !== null && at !== undefined,
  );
  return stamps.length > 0 ? Math.min(...stamps) : null;
});

/** Split out because a website erroring on its own account is worth saying. */
const errorRate = computed(() => {
  const totals = summary.value;
  if (!totals || totals.requests === 0) return 0;
  return (totals.status5xx / totals.requests) * 100;
});

function whenMonth(value: Date): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
</script>

<template>
  <div class="space-y-6">
    <AlertMessage v-if="error">{{ error }}</AlertMessage>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="inline-flex rounded-lg border border-line bg-black/20 p-0.5">
        <button
          v-for="option in RANGES"
          :key="option.value"
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          :class="
            range === option.value
              ? 'bg-brand-soft text-brand-bright'
              : 'text-ink-faint hover:text-ink'
          "
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

    <dl v-if="summary" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card p-4">
        <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <Activity :size="13" aria-hidden="true" /> Requests
        </dt>
        <dd class="mt-1 text-2xl font-semibold text-ink" :title="String(summary.requests)">
          {{ formatCount(summary.requests) }}
        </dd>
      </div>

      <div class="card p-4">
        <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <ArrowUpFromLine :size="13" aria-hidden="true" /> Data out
        </dt>
        <dd class="mt-1 text-2xl font-semibold text-ink">{{ formatBytes(summary.bytesOut) }}</dd>
        <p class="mt-1 text-xs text-ink-faint">Sent to visitors. This is the egress figure.</p>
      </div>

      <div class="card p-4">
        <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <ArrowDownToLine :size="13" aria-hidden="true" /> Data in
        </dt>
        <dd class="mt-1 text-2xl font-semibold text-ink">{{ formatBytes(summary.bytesIn) }}</dd>
        <p class="mt-1 text-xs text-ink-faint">Uploads and form posts received.</p>
      </div>

      <div class="card p-4">
        <dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <Gauge :size="13" aria-hidden="true" /> Mean response
        </dt>
        <dd class="mt-1 text-2xl font-semibold text-ink">{{ summary.meanResponseMs }} ms</dd>
        <p v-if="errorRate > 0" class="mt-1 text-xs text-danger">
          {{ errorRate.toFixed(1) }}% of requests failed
        </p>
      </div>
    </dl>

    <section class="card p-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-ink">
          {{ hourly ? 'By the hour' : 'By the day' }}
        </h3>

        <div class="inline-flex rounded-lg border border-line bg-black/20 p-0.5">
          <button
            v-for="option in METRICS"
            :key="option.value"
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            :class="
              metric === option.value
                ? 'bg-brand-soft text-brand-bright'
                : 'text-ink-faint hover:text-ink'
            "
            :aria-pressed="metric === option.value"
            @click="metric = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <LoadingBlock v-if="loading && !traffic" class="h-40 rounded-lg bg-sunken" />

      <template v-else>
        <div class="flex h-40 items-end gap-px" role="img" :aria-label="`Traffic over the last ${range}`">
          <div
            v-for="bar in bars"
            :key="bar.key"
            class="min-w-px flex-1 rounded-t-sm transition-colors"
            :class="
              bar.height === 0
                ? 'bg-line/40'
                : bar.failed
                  ? 'bg-danger/70 hover:bg-danger'
                  : 'bg-brand/60 hover:bg-brand-bright'
            "
            :style="{ height: `${Math.max(bar.height, 1)}%` }"
            :title="bar.title"
          />
        </div>

        <div class="mt-2 flex justify-between text-xs text-ink-faint">
          <span>{{ bars.length > 0 ? labelFor(traffic!.points[0]!.at) : '' }}</span>
          <span>Peak {{ describeValue(peak) }}</span>
          <span>Now</span>
        </div>
      </template>
    </section>

    <section v-if="statusBands.length > 0" class="card p-5">
      <h3 class="mb-3 text-sm font-semibold text-ink">What the server answered</h3>

      <div class="flex h-2.5 overflow-hidden rounded-full bg-sunken">
        <div
          v-for="band in statusBands"
          :key="band.key"
          :class="band.tint"
          :style="{ width: `${band.share}%` }"
          :title="`${band.label}: ${formatCount(band.count)}`"
        />
      </div>

      <dl class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="band in statusBands"
          :key="band.key"
          class="flex items-center gap-2 rounded-md text-sm"
          :class="classFilter === band.key ? 'bg-white/5 ring-1 ring-line' : ''"
        >
          <span class="ml-2 h-2 w-2 shrink-0 rounded-full" :class="band.tint" aria-hidden="true" />
          <dt class="min-w-0 flex-1 truncate py-1 text-ink-muted">
            <button
              v-if="band.inspectable"
              type="button"
              class="w-full truncate text-left underline decoration-dotted underline-offset-4 hover:text-ink"
              :aria-pressed="classFilter === band.key"
              @click="inspect(band.key)"
            >
              {{ band.label }}
            </button>
            <template v-else>{{ band.label }}</template>
          </dt>
          <dd class="mr-2 font-mono text-ink">{{ formatCount(band.count) }}</dd>
        </div>
      </dl>

      <p class="mt-3 text-xs text-ink-faint">
        Select a band to narrow the table below to just those requests.
      </p>
    </section>

    <section v-if="tableReady || tableLoading || tableError" class="card p-5">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-ink">Requests</h3>

        <div class="flex flex-wrap items-center gap-2">
          <!-- Which status classes are on the table. -->
          <div class="inline-flex rounded-lg border border-line bg-black/20 p-0.5">
            <button
              v-for="option in CLASS_FILTERS"
              :key="option.value"
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              :class="
                classFilter === option.value
                  ? 'bg-brand-soft text-brand-bright'
                  : 'text-ink-faint hover:text-ink'
              "
              :aria-pressed="classFilter === option.value"
              @click="classFilter = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <!-- Grouped by route, or every request on its own line. -->
          <div class="inline-flex rounded-lg border border-line bg-black/20 p-0.5">
            <button
              v-for="option in [
                { value: 'grouped', label: 'By route' },
                { value: 'latest', label: 'Every request' },
              ]"
              :key="option.value"
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              :class="
                view === option.value
                  ? 'bg-brand-soft text-brand-bright'
                  : 'text-ink-faint hover:text-ink'
              "
              :aria-pressed="view === option.value"
              @click="view = option.value as View"
            >
              {{ option.label }}
            </button>
          </div>

          <label class="flex items-center gap-1.5 text-xs text-ink-faint">
            Sort
            <select
              v-if="view === 'grouped'"
              v-model="groupSort"
              class="field !w-auto px-2 py-1 text-xs"
            >
              <option v-for="option in TABLE_SORTS.grouped" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <select v-else v-model="latestSort" class="field !w-auto px-2 py-1 text-xs">
              <option v-for="option in TABLE_SORTS.latest" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
      </div>

      <AlertMessage v-if="tableError">{{ tableError }}</AlertMessage>

      <LoadingBlock v-else-if="tableLoading && !tableReady" class="h-24 rounded-lg bg-sunken" :icon-size="16" />

      <template v-else>
        <p class="mb-3 text-xs text-ink-faint">
          Read back from the web server&#8217;s own log.
          <template v-if="partialLog && oldestLogAt">
            It only reaches back to {{ whenExact(oldestLogAt) }}, so older requests counted above
            are not listed.
          </template>
        </p>

        <div v-if="view === 'grouped'" class="overflow-x-auto">
          <table v-if="visibleGroups.length > 0" class="w-full text-sm">
            <thead>
              <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th class="py-1.5 pr-3 font-medium">Answer</th>
                <th class="py-1.5 pr-3 font-medium">Address</th>
                <th class="py-1.5 pr-3 text-right font-medium">Times</th>
                <th class="py-1.5 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="group in visibleGroups"
                :key="`${group.status} ${group.method} ${group.path}`"
                class="border-b border-line/50 last:border-0"
              >
                <td class="whitespace-nowrap py-2 pr-3">
                  <span class="font-mono" :class="statusTint(group.status)">{{ group.status }}</span>
                  <span class="ml-1.5 text-ink-muted">{{ describeStatus(group.status) }}</span>
                </td>
                <td class="max-w-md py-2 pr-3">
                  <span class="mr-1.5 font-mono text-xs text-ink-faint">{{ group.method }}</span>
                  <span class="break-all font-mono text-xs text-ink">{{ group.path }}</span>
                </td>
                <td class="whitespace-nowrap py-2 pr-3 text-right font-mono text-ink">
                  {{ formatCount(group.count) }}
                </td>
                <td
                  class="whitespace-nowrap py-2 text-right text-xs text-ink-faint"
                  :title="whenExact(group.lastAt)"
                >
                  {{ timeAgo(group.lastAt) }}
                </td>
              </tr>
            </tbody>
          </table>

          <p v-else class="text-sm text-ink-muted">Nothing matching is still in the log.</p>
        </div>

        <div v-else class="overflow-x-auto">
          <table v-if="visibleRecent.length > 0" class="w-full text-sm">
            <thead>
              <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th class="py-1.5 pr-3 font-medium">When</th>
                <th class="py-1.5 pr-3 font-medium">Answer</th>
                <th class="py-1.5 font-medium">Address</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in visibleRecent"
                :key="`${entry.at}-${index}`"
                class="border-b border-line/50 last:border-0"
              >
                <td
                  class="whitespace-nowrap py-2 pr-3 text-xs text-ink-faint"
                  :title="whenExact(entry.at)"
                >
                  {{ timeAgo(entry.at) }}
                </td>
                <td class="whitespace-nowrap py-2 pr-3">
                  <span class="font-mono" :class="statusTint(entry.status)">{{ entry.status }}</span>
                  <span class="ml-1.5 text-ink-muted">{{ describeStatus(entry.status) }}</span>
                </td>
                <td class="max-w-md py-2">
                  <span class="mr-1.5 font-mono text-xs text-ink-faint">{{ entry.method }}</span>
                  <span class="break-all font-mono text-xs text-ink">{{ entry.uri }}</span>
                </td>
              </tr>
            </tbody>
          </table>

          <p v-else class="text-sm text-ink-muted">Nothing matching is still in the log.</p>
        </div>
      </template>
    </section>

    <section v-if="traffic" class="card p-5">
      <h3 class="mb-3 text-sm font-semibold text-ink">Totals</h3>

      <dl class="grid gap-4 sm:grid-cols-2">
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">
            {{ whenMonth(traffic.month.since) }} so far
          </dt>
          <dd class="mt-1 text-sm text-ink">
            {{ formatBytes(traffic.month.bytesOut) }} out
            <span class="text-ink-faint">&#183;</span>
            {{ formatBytes(traffic.month.bytesIn) }} in
            <span class="text-ink-faint">&#183;</span>
            {{ formatCount(traffic.month.requests) }} requests
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">
            Since
            {{
              traffic.allTime.since
                ? new Date(traffic.allTime.since).toLocaleDateString()
                : 'counting began'
            }}
          </dt>
          <dd class="mt-1 text-sm text-ink">
            {{ formatBytes(traffic.allTime.bytesOut) }} out
            <span class="text-ink-faint">&#183;</span>
            {{ formatBytes(traffic.allTime.bytesIn) }} in
            <span class="text-ink-faint">&#183;</span>
            {{ formatCount(traffic.allTime.requests) }} requests
          </dd>
        </div>
      </dl>

      <p v-if="!traffic.collecting" class="mt-4 text-xs text-ink-muted">
        Nothing has been recorded for this website yet. Counting starts the first time a visitor
        reaches it through the web server &#8212; requests made straight to the app&#8217;s own
        port do not pass through it and are not counted.
      </p>
    </section>
  </div>
</template>
