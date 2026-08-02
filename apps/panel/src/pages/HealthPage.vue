<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { CheckResult, CheckState } from '@winpanel/shared';
import { rollUpState } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import CheckCard from '../components/CheckCard.vue';
import StatusBadge from '../components/StatusBadge.vue';

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
  <div class="mx-auto max-w-4xl">
    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <StatusBadge :state="loading ? 'checking' : overall" />
        <p class="text-sm text-[--color-text-muted]">
          {{ loading ? 'Checking your server\u2026' : `${results.length} checks` }}
        </p>
      </div>

      <div class="flex gap-2">
        <button
          v-if="fixableCount > 0"
          type="button"
          class="rounded-md bg-[--color-brand] px-3 py-1.5 text-sm font-medium text-white
                 hover:bg-[--color-brand-hover]"
          @click="applyFix('__all_safe__')"
        >
          Fix everything safe ({{ fixableCount }})
        </button>
        <button
          type="button"
          class="rounded-md border border-[--color-border] px-3 py-1.5 text-sm
                 text-[--color-text] hover:bg-[--color-surface]"
          @click="load"
        >
          Refresh
        </button>
      </div>
    </div>

    <p
      v-if="error"
      class="mb-4 rounded-md bg-[--color-status-blocked-bg] px-4 py-3 text-sm
             text-[--color-status-blocked]"
    >
      {{ error }}
    </p>

    <!-- Skeletons rather than a spinner: the shape of the page stays stable. -->
    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 5"
        :key="n"
        class="h-24 animate-pulse rounded-[--radius-card] border border-[--color-border]
               bg-[--color-surface]"
      />
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
