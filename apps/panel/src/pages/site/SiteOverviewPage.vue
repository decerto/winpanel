<script setup lang="ts">
import { computed, inject } from 'vue';
import { GitBranch, Rocket, Server } from 'lucide-vue-next';
import { siteContextKey } from '../../lib/site-context';
import EmptyState from '../../components/EmptyState.vue';

/**
 * What is running, where it came from, and what happened last.
 *
 * Blue/green is an implementation detail the user did not ask for, so it is
 * described as "live" and "standby" rather than by colour.
 */

const { site, deploy, deploying } = inject(siteContextKey)!;

const source = computed(
  () => site.value?.source as { kind?: string; url?: string; branch?: string } | undefined,
);

const livePort = computed(() =>
  site.value?.activeColour === 'blue' ? site.value?.portBlue : site.value?.portGreen,
);

const standbyPort = computed(() =>
  site.value?.activeColour === 'blue' ? site.value?.portGreen : site.value?.portBlue,
);

/** Static files are served by the web server itself, with no process at all. */
const runsAProcess = computed(
  () => site.value?.runtime !== 'static' && site.value?.runtime !== 'proxy',
);

/** Where to put files, which differs depending on how the site was made. */
const filesNote = computed(() => {
  if (source.value?.kind === 'git') return null;
  return runsAProcess.value
    ? 'Your app runs from this website\u2019s public folder. Edit it in the Files tab, then publish.'
    : 'Your files are served straight from this website\u2019s public folder. Edit them in the Files tab \u2014 changes are live immediately.';
});

const RUNTIME_LABEL: Record<string, string> = {
  node: 'Node.js app',
  static: 'Static files',
  dotnet: '.NET app',
  proxy: 'Proxied elsewhere',
};

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'text-ok',
  failed: 'text-danger',
  running: 'text-info',
};

function when(value: Date | number | null | undefined): string {
  if (!value) return '\u2014';
  return new Date(value).toLocaleString();
}
</script>

<template>
  <div v-if="site" class="space-y-6">
    <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <!--
        The address that works without DNS. First, because on a site that has
        just been made it is the only way to look at it.
      -->
      <div class="card p-4">
        <dt class="text-xs font-medium uppercase tracking-wide text-ink-faint">Preview address</dt>
        <dd class="mt-1 truncate text-sm">
          <a
            v-if="site.previewUrl"
            :href="site.previewUrl"
            target="_blank"
            rel="noreferrer noopener"
            class="font-mono text-brand-bright underline underline-offset-2"
          >
            {{ site.previewUrl }}
          </a>
          <span v-else class="text-ink-muted">&#8212;</span>
        </dd>
        <p class="mt-1.5 text-xs text-ink-faint">
          Reaches this website by IP, with or without a working domain.
        </p>
      </div>
      <div v-if="runsAProcess" class="card p-4">
        <dt class="text-xs font-medium uppercase tracking-wide text-ink-faint">App ports</dt>
        <dd class="mt-1 flex items-baseline gap-2 font-mono text-lg text-ink">
          {{ livePort ?? '\u2014' }}
          <span class="text-xs uppercase tracking-wide text-ok">live</span>
          <span class="text-ink-faint">/</span>
          <span class="text-ink-muted">{{ standbyPort ?? '\u2014' }}</span>
          <span class="text-xs uppercase tracking-wide text-ink-faint">standby</span>
        </dd>
        <p class="mt-1.5 text-xs text-ink-faint">
          Where your app itself listens. Reachable only from this server &#8212; visitors always
          arrive through the web server.
        </p>
      </div>
      <div class="card p-4">
        <dt class="text-xs font-medium uppercase tracking-wide text-ink-faint">Type</dt>
        <dd class="mt-1 text-lg text-ink">
          {{ RUNTIME_LABEL[site.runtime] ?? site.runtime }}
        </dd>
      </div>
      <div class="card p-4">
        <dt class="text-xs font-medium uppercase tracking-wide text-ink-faint">Last changed</dt>
        <dd class="mt-1 text-sm text-ink-muted">{{ when(site.updatedAt) }}</dd>
      </div>
    </dl>

    <section class="card p-5">
      <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <GitBranch :size="15" class="text-ink-faint" aria-hidden="true" />
        {{ source?.kind === 'git' ? 'Where the code comes from' : 'Where the files live' }}
      </h3>

      <p v-if="source?.kind === 'git'" class="break-all font-mono text-sm text-ink-muted">
        {{ source.url }}
        <span class="text-brand-bright">#{{ source.branch }}</span>
      </p>
      <p v-else class="text-sm text-ink-muted">{{ filesNote }}</p>
    </section>

    <section class="card overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-5 py-3">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
          <Server :size="15" class="text-ink-faint" aria-hidden="true" /> Recent deployments
        </h3>
      </div>

      <EmptyState
        v-if="site.deployments.length === 0"
        :icon="Rocket"
        title="Not deployed yet"
        description="Nothing is being served for this website until its first deployment finishes."
        action-label="Deploy now"
        flush
        :busy="deploying"
        @action="deploy"
      />

      <ul v-else class="divide-y divide-line">
        <li
          v-for="deployment in site.deployments"
          :key="deployment.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
        >
          <span class="font-mono text-ink">{{ deployment.releaseId }}</span>
          <span
            class="font-medium capitalize"
            :class="STATUS_CLASS[deployment.status] ?? 'text-ink-muted'"
          >
            {{ deployment.status }}
          </span>
          <span class="ml-auto text-xs text-ink-faint">{{ when(deployment.startedAt) }}</span>
          <p v-if="deployment.errorMessage" class="w-full text-xs text-danger">
            {{ deployment.errorMessage }}
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
