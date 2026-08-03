<script setup lang="ts">
import type { CheckResult } from '@winpanel/shared';
import StatusBadge from './StatusBadge.vue';

/**
 * A single check on the Health or Server Setup page.
 *
 * The layout follows the rule that every problem answers three questions:
 * what this is, what is wrong, and what will fix it. The fix button always
 * states what it will change before it is pressed, because this panel edits a
 * live server.
 */

defineProps<{
  result: CheckResult;
  busy?: boolean;
}>();

const emit = defineEmits<{ fix: [action: string] }>();
</script>

<template>
  <div class="card p-4 md:p-5">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-medium text-ink">{{ result.name }}</h3>
          <StatusBadge :state="result.state" size="sm" />
        </div>

        <p class="mt-1 text-sm text-ink-muted">
          {{ result.plainDescription }}
        </p>

        <p v-if="result.detail" class="mt-2 break-all font-mono text-sm text-ink">
          {{ result.detail }}
        </p>

        <!-- Why it is not OK, in the same plain language as everything else. -->
        <p
          v-if="result.reason"
          class="mt-2.5 rounded-lg border border-line bg-black/20 px-3 py-2 text-sm text-ink"
        >
          {{ result.reason }}
        </p>

        <p v-if="result.fix?.kind === 'automatic'" class="mt-2.5 text-xs text-ink-faint">
          {{ result.fix.describesChange }}
          <span v-if="result.fix.reversible"> This can be undone.</span>
        </p>

        <div v-else-if="result.fix?.kind === 'manual'" class="mt-2.5 text-sm">
          <p class="text-ink-muted">{{ result.fix.instructions }}</p>
          <a
            v-if="result.fix.url"
            :href="result.fix.url"
            target="_blank"
            rel="noreferrer noopener"
            class="mt-1 inline-block text-brand-bright underline underline-offset-2"
          >
            {{ result.fix.label }}
          </a>
        </div>
      </div>

      <button
        v-if="result.fix?.kind === 'automatic'"
        type="button"
        :disabled="busy"
        class="btn btn-primary btn-sm shrink-0"
        @click="emit('fix', result.fix.action)"
      >
        {{ busy ? 'Working\u2026' : result.fix.label }}
      </button>
    </div>
  </div>
</template>
