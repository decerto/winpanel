<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ExternalLink, RefreshCw, Rocket } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import StatusBadge from '../components/StatusBadge.vue';
import type { CheckState } from '@winpanel/shared';

/**
 * A single website: where it lives, what happened last, and a way to deploy.
 *
 * Deploy output is polled incrementally rather than re-fetched, so a long
 * build does not resend its whole log every second.
 */

const route = useRoute();
const slug = computed(() => route.params['slug'] as string);

type SiteDetail = Awaited<ReturnType<typeof api.sites.get.query>>;

const site = ref<SiteDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const activeJobId = ref<string | null>(null);
const logLines = ref<Array<{ seq: number; level: string; message: string }>>([]);
const jobStatus = ref<string | null>(null);
let poller: ReturnType<typeof setInterval> | null = null;

const deployState = computed<CheckState>(() => {
  if (jobStatus.value === 'running' || jobStatus.value === 'pending') return 'checking';
  if (jobStatus.value === 'failed') return 'blocked';
  if (jobStatus.value === 'succeeded') return 'ok';

  const last = site.value?.deployments?.[0];
  if (!last) return 'absent';
  if (last.status === 'succeeded') return 'ok';
  if (last.status === 'failed') return 'blocked';
  return 'unknown';
});

async function load(): Promise<void> {
  loading.value = true;
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
  if (!activeJobId.value) return;

  try {
    const job = await api.jobs.get.query({ jobId: activeJobId.value });
    jobStatus.value = job?.status ?? null;

    // Only ask for lines newer than the last one seen.
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

const levelClass: Record<string, string> = {
  error: 'text-[--color-status-blocked]',
  warn: 'text-[--color-status-warn]',
  debug: 'text-[--color-text-muted]',
  info: 'text-[--color-text]',
};
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <div v-if="loading" class="h-32 animate-pulse rounded-[--radius-card] bg-[--color-surface]" />

    <p
      v-else-if="error"
      class="rounded-md bg-[--color-status-blocked-bg] px-4 py-3 text-sm
             text-[--color-status-blocked]"
    >
      {{ error }}
    </p>

    <template v-else-if="site">
      <div
        class="mb-4 rounded-[--radius-card] border border-[--color-border]
               bg-[--color-surface] p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold text-[--color-text]">{{ site.displayName }}</h2>
              <StatusBadge :state="deployState" size="sm" />
            </div>

            <ul class="mt-2 space-y-1">
              <li v-for="domain in site.domains" :key="domain" class="text-sm">
                <a
                  :href="`https://${domain}`"
                  target="_blank"
                  rel="noreferrer noopener"
                  class="inline-flex items-center gap-1 text-[--color-brand]
                         underline underline-offset-2"
                >
                  {{ domain }}
                  <ExternalLink :size="12" aria-hidden="true" />
                </a>
              </li>
            </ul>
          </div>

          <button
            type="button"
            :disabled="jobStatus === 'running' || jobStatus === 'pending'"
            class="flex shrink-0 items-center gap-1.5 rounded-md bg-[--color-brand] px-3 py-2
                   text-sm font-medium text-white hover:bg-[--color-brand-hover]
                   disabled:cursor-not-allowed disabled:opacity-50"
            @click="deploy"
          >
            <component
              :is="jobStatus === 'running' ? RefreshCw : Rocket"
              :size="15"
              :class="jobStatus === 'running' ? 'animate-spin' : ''"
              aria-hidden="true"
            />
            {{ jobStatus === 'running' ? 'Deploying\u2026' : 'Deploy now' }}
          </button>
        </div>

        <dl class="mt-4 grid grid-cols-3 gap-4 border-t border-[--color-border] pt-4 text-sm">
          <div>
            <dt class="text-[--color-text-muted]">Running on</dt>
            <dd class="font-mono text-[--color-text]">
              {{ site.activeColour === 'blue' ? site.portBlue : site.portGreen }}
            </dd>
          </div>
          <div>
            <dt class="text-[--color-text-muted]">Standby</dt>
            <dd class="font-mono text-[--color-text]">
              {{ site.activeColour === 'blue' ? site.portGreen : site.portBlue }}
            </dd>
          </div>
          <div>
            <dt class="text-[--color-text-muted]">Type</dt>
            <dd class="text-[--color-text]">{{ site.runtime }}</dd>
          </div>
        </dl>
      </div>

      <!-- Live deploy output -->
      <div
        v-if="logLines.length > 0"
        class="mb-4 rounded-[--radius-card] border border-[--color-border] bg-[--color-surface]"
      >
        <div class="border-b border-[--color-border] px-4 py-2">
          <h3 class="text-sm font-medium text-[--color-text]">Deployment</h3>
        </div>
        <pre
          class="max-h-96 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
        ><span
          v-for="line in logLines"
          :key="line.seq"
          class="block"
          :class="levelClass[line.level] ?? 'text-[--color-text]'"
        >{{ line.message }}</span></pre>
      </div>

      <div class="rounded-[--radius-card] border border-[--color-border] bg-[--color-surface] p-5">
        <h3 class="mb-3 text-sm font-medium text-[--color-text]">Recent deployments</h3>

        <p v-if="site.deployments.length === 0" class="text-sm text-[--color-text-muted]">
          This website has not been deployed yet.
        </p>

        <ul v-else class="space-y-2">
          <li
            v-for="deployment in site.deployments"
            :key="deployment.id"
            class="flex items-center justify-between rounded bg-[--color-surface-sunken]
                   px-3 py-2 text-sm"
          >
            <span class="font-mono text-[--color-text]">{{ deployment.releaseId }}</span>
            <span class="text-[--color-text-muted]">{{ deployment.status }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
