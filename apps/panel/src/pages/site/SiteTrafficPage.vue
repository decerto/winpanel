<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Gauge, RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { formatBytes, formatCount } from '../../lib/format';
import AlertMessage from '../../components/AlertMessage.vue';

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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    traffic.value = await api.sites.traffic.query({ slug: slug.value, range: range.value });
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
    .map((band) => ({ ...band, share: (band.count / totals.requests) * 100 }));
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

      <p v-if="loading && !traffic" class="h-40 animate-pulse rounded-lg bg-sunken" />

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
        <div v-for="band in statusBands" :key="band.key" class="flex items-center gap-2 text-sm">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="band.tint" aria-hidden="true" />
          <dt class="min-w-0 truncate text-ink-muted">{{ band.label }}</dt>
          <dd class="ml-auto font-mono text-ink">{{ formatCount(band.count) }}</dd>
        </div>
      </dl>
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
