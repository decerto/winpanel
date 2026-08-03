<script setup lang="ts">
import { computed, onUnmounted, provide, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import {
  ArrowLeft,
  AtSign,
  ExternalLink,
  FolderOpen,
  Gauge,
  Globe2,
  RefreshCw,
  Rocket,
  SlidersHorizontal,
} from 'lucide-vue-next';
import type { CheckState } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { siteContextKey, type SiteDetail } from '../lib/site-context';
import StatusBadge from '../components/StatusBadge.vue';
import AlertMessage from '../components/AlertMessage.vue';

/**
 * One website, and everything you can do to it.
 *
 * This is the shape a hosting panel wants: the website is the object, and
 * files, DNS and settings are tools applied to it. Fetching happens here so
 * moving between tabs does not blank the header and re-ask the server.
 *
 * Deployment lives here too rather than on the overview tab. A build takes
 * minutes, and having it stop reporting because you wandered off to look at
 * the files would be a poor way to treat the one thing you are waiting for.
 */

const route = useRoute();
const slug = computed(() => route.params['slug'] as string);

const site = ref<SiteDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const activeJobId = ref<string | null>(null);
const logLines = ref<Array<{ seq: number; level: string; message: string }>>([]);
const jobStatus = ref<string | null>(null);
let poller: ReturnType<typeof setInterval> | null = null;
/** A slow tick must not overlap the next one, or lines arrive twice. */
let polling = false;

const deploying = computed(() => jobStatus.value === 'running' || jobStatus.value === 'pending');

const deployState = computed<CheckState>(() => {
  if (deploying.value) return 'checking';
  if (jobStatus.value === 'failed') return 'blocked';
  if (jobStatus.value === 'succeeded') return 'ok';

  const last = site.value?.deployments?.[0];
  if (!last) return 'absent';
  if (last.status === 'succeeded') return 'ok';
  if (last.status === 'failed') return 'blocked';
  return 'unknown';
});

const deployLabel = computed(() => {
  switch (deployState.value) {
    case 'checking':
      return 'Deploying';
    case 'ok':
      return 'Live';
    case 'blocked':
      return 'Deploy failed';
    case 'absent':
      return 'Not deployed';
    default:
      return 'Unknown';
  }
});

const TABS = [
  { name: 'site-detail', label: 'Overview', icon: Gauge, path: '' },
  { name: 'site-files', label: 'Files', icon: FolderOpen, path: 'files' },
  { name: 'site-dns', label: 'DNS', icon: Globe2, path: 'dns' },
  { name: 'site-email', label: 'Email', icon: AtSign, path: 'email' },
  { name: 'site-settings', label: 'Settings', icon: SlidersHorizontal, path: 'settings' },
] as const;

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    site.value = await api.sites.get.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

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

    // Only ask for lines newer than the last one seen, so a long build does
    // not resend its whole log every second.
    const lastSeq = logLines.value.at(-1)?.seq ?? -1;
    const newLines = await api.jobs.logs.query({
      jobId: activeJobId.value,
      afterSeq: lastSeq,
    });

    logLines.value.push(...newLines);

    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      stopPolling();
      await load();
    }
  } catch {
    // A transient failure while polling should not tear down the view.
  } finally {
    polling = false;
  }
}

async function deploy(): Promise<void> {
  error.value = null;
  logLines.value = [];
  jobStatus.value = 'pending';

  try {
    const result = await api.sites.deploy.mutate({ slug: slug.value });
    activeJobId.value = result.jobId;

    stopPolling();
    poller = setInterval(() => void pollJob(), 1000);
  } catch (err) {
    error.value = describeError(err);
    jobStatus.value = null;
  }
}

watch(slug, load, { immediate: true });
onUnmounted(stopPolling);

provide(siteContextKey, { site, reload: load, deploy, deploying });

const levelClass: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warn',
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
};
</script>

<template>
  <div class="max-w-5xl">
    <RouterLink
      to="/sites"
      class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft :size="15" aria-hidden="true" /> All websites
    </RouterLink>

    <div v-if="loading && !site" class="h-40 animate-pulse rounded-card bg-surface" />

    <AlertMessage v-else-if="error && !site">{{ error }}</AlertMessage>

    <template v-else-if="site">
      <header class="card mb-6 p-5 md:p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2.5">
              <h2 class="truncate text-xl font-semibold tracking-tight text-ink">
                {{ site.displayName }}
              </h2>
              <StatusBadge :state="deployState" :label="deployLabel" size="sm" />
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <a
                v-for="domain in site.domains"
                :key="domain"
                :href="`https://${domain}`"
                target="_blank"
                rel="noreferrer noopener"
                class="inline-flex items-center gap-1 text-sm text-brand-bright hover:underline"
              >
                {{ domain }}
                <ExternalLink :size="12" aria-hidden="true" />
              </a>
              <span v-if="site.domains.length === 0" class="text-sm text-ink-faint">
                No web address yet
              </span>
            </div>
          </div>

          <button type="button" class="btn btn-primary" :disabled="deploying" @click="deploy">
            <component
              :is="deploying ? RefreshCw : Rocket"
              :size="15"
              :class="deploying ? 'animate-spin' : ''"
              aria-hidden="true"
            />
            {{ deploying ? 'Deploying\u2026' : 'Deploy now' }}
          </button>
        </div>

        <nav class="-mb-1 mt-4 flex gap-6 border-t border-line pt-1" aria-label="Website tools">
          <RouterLink
            v-for="tab in TABS"
            :key="tab.name"
            :to="{ name: tab.name, params: { slug } }"
            class="tab"
            :class="route.name === tab.name ? 'tab-active' : ''"
          >
            <component :is="tab.icon" :size="15" aria-hidden="true" />
            {{ tab.label }}
          </RouterLink>
        </nav>
      </header>

      <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

      <!-- Live deploy output, visible from whichever tab you are on. -->
      <section v-if="logLines.length > 0" class="card mb-6 overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 class="text-sm font-medium text-ink">Deployment output</h3>
          <StatusBadge :state="deployState" :label="deployLabel" size="sm" />
        </div>
        <pre
          class="max-h-96 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"
        ><span
          v-for="line in logLines"
          :key="line.seq"
          class="block"
          :class="levelClass[line.level] ?? 'text-ink'"
        >{{ line.message }}</span></pre>
      </section>

      <RouterView />
    </template>
  </div>
</template>
