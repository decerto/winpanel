<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { CheckResult, CheckState } from '@winpanel/shared';
import { rollUpState } from '@winpanel/shared';
import { RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import CheckCard from '../components/CheckCard.vue';
import StatusBadge from '../components/StatusBadge.vue';
import AlertMessage from '../components/AlertMessage.vue';

/**
 * Server health.
 *
 * Groups by category, sorts problems to the top, and offers a single action
 * that applies every fix which is safe to run unattended.
 */

const results = ref<CheckResult[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busyAction = ref<string | null>(null);

const overall = computed<CheckState>(() => rollUpState(results.value.map((r) => r.state)));

// Problems first: a healthy server should not bury the one thing that is wrong.
const ORDER: Record<CheckState, number> = {
  blocked: 0,
  warning: 1,
  unknown: 2,
  checking: 3,
  absent: 4,
  ok: 5,
};

const sorted = computed(() =>
  [...results.value].sort((a, b) => ORDER[a.state] - ORDER[b.state]),
);

const fixableCount = computed(
  () =>
    results.value.filter(
      (r) =>
        (r.state === 'blocked' || r.state === 'warning') &&
        r.fix?.kind === 'automatic' &&
        r.fix.safeToBatch,
    ).length,
);

/** Counts for the summary strip, in the order problems should be read. */
const tally = computed(() => ({
  blocked: results.value.filter((r) => r.state === 'blocked').length,
  warning: results.value.filter((r) => r.state === 'warning').length,
  ok: results.value.filter((r) => r.state === 'ok').length,
}));

const headline = computed(() => {
  if (loading.value) return 'Checking your server\u2026';
  if (tally.value.blocked > 0) return 'Something needs your attention';
  if (tally.value.warning > 0) return 'Worth a look';
  return 'Everything looks healthy';
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    results.value = await api.checks.run.query();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function applyFix(action: string): Promise<void> {
  busyAction.value = action;
  try {
    await api.checks.applyFix.mutate({ action });
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busyAction.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-4xl">
    <!--
      A single sentence, then the numbers. Anyone opening this page is asking
      "is my server all right?", and that deserves an answer before a list.
    -->
    <section class="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-4 p-5 md:p-6">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-3">
          <StatusBadge :state="loading ? 'checking' : overall" />
          <h2 class="truncate text-lg font-semibold tracking-tight text-ink">{{ headline }}</h2>
        </div>
        <p class="mt-1.5 text-sm text-ink-muted">
          {{ loading ? 'This takes a moment.' : `${results.length} checks ran on this server.` }}
        </p>
      </div>

      <dl v-if="!loading" class="flex gap-6">
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Blocked</dt>
          <dd class="text-2xl font-semibold" :class="tally.blocked > 0 ? 'text-danger' : 'text-ink-faint'">
            {{ tally.blocked }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Warnings</dt>
          <dd class="text-2xl font-semibold" :class="tally.warning > 0 ? 'text-warn' : 'text-ink-faint'">
            {{ tally.warning }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Passing</dt>
          <dd class="text-2xl font-semibold text-ok">{{ tally.ok }}</dd>
        </div>
      </dl>

      <div class="flex w-full gap-2 sm:w-auto">
        <button
          v-if="fixableCount > 0"
          type="button"
          class="btn btn-primary"
          @click="applyFix('__all_safe__')"
        >
          Fix everything safe ({{ fixableCount }})
        </button>
        <button type="button" class="btn btn-ghost" @click="load">
          <RefreshCw :size="15" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </section>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

    <!-- Skeletons rather than a spinner: the shape of the page stays stable. -->
    <div v-if="loading" class="space-y-3">
      <div v-for="n in 5" :key="n" class="h-24 animate-pulse rounded-card bg-surface" />
    </div>

    <div v-else class="space-y-3">
      <CheckCard
        v-for="result in sorted"
        :key="result.id"
        :result="result"
        :busy="busyAction === (result.fix?.kind === 'automatic' ? result.fix.action : '')"
        @fix="applyFix"
      />
    </div>
  </div>
</template>
