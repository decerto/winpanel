<script setup lang="ts">
import { computed } from 'vue';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-vue-next';

/**
 * A message about something that just happened, or about to.
 *
 * Every tone pairs its colour with a distinct icon, for the same reason
 * StatusBadge does: colour alone is not a message.
 */

const props = withDefaults(
  defineProps<{
    tone?: 'danger' | 'warning' | 'success' | 'info';
    title?: string;
    dismissible?: boolean;
  }>(),
  { tone: 'danger' },
);

const emit = defineEmits<{ dismiss: [] }>();

const TONES = {
  danger: { icon: CircleAlert, classes: 'border-danger/35 bg-danger-soft/60 text-danger' },
  warning: { icon: TriangleAlert, classes: 'border-warn/35 bg-warn-soft/60 text-warn' },
  success: { icon: CircleCheck, classes: 'border-ok/35 bg-ok-soft/60 text-ok' },
  info: { icon: Info, classes: 'border-line bg-elevated/70 text-ink-muted' },
} as const;

// Not named `tone`: a setup binding shadows the prop of the same name in the
// template, which is how a dialog once ended up permanently open.
const appearance = computed(() => TONES[props.tone]);
</script>

<template>
  <div
    class="relative flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 pr-12 text-sm"
    :class="appearance.classes"
    role="status"
  >
    <component :is="appearance.icon" :size="16" class="mt-0.5 shrink-0" aria-hidden="true" />
    <div class="min-w-0">
      <p v-if="title" class="font-semibold">{{ title }}</p>
      <div class="min-w-0 [&_a]:underline [&_a]:underline-offset-2">
        <slot />
      </div>
    </div>
    <button
      v-if="dismissible"
      type="button"
      class="btn btn-ghost btn-sm absolute right-2 top-2"
      aria-label="Dismiss message"
      title="Dismiss"
      @click="emit('dismiss')"
    >
      <X :size="14" aria-hidden="true" />
    </button>
  </div>
</template>
