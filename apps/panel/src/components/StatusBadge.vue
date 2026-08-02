<script setup lang="ts">
import { computed } from 'vue';
import type { CheckState } from '@winpanel/shared';
import { statusPresentation } from '@winpanel/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-vue-next';

/**
 * The status indicator used everywhere a check result appears.
 *
 * Colour is deliberately never the only signal: each state also carries a
 * distinct icon shape and a text label. That keeps the meaning intact for
 * colour-blind users, in high-contrast mode, and on the washed-out monitors
 * that servers tend to be administered from.
 */

const props = withDefaults(
  defineProps<{
    state: CheckState;
    /** Hide the text label where the surrounding context already says it. */
    showLabel?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { showLabel: true, size: 'md' },
);

const ICONS = {
  blocked: CircleX,
  warning: TriangleAlert,
  ok: CircleCheck,
  absent: CircleDashed,
  checking: LoaderCircle,
  unknown: CircleHelp,
} as const;

const presentation = computed(() => statusPresentation[props.state]);
const icon = computed(() => ICONS[props.state]);

const classes = computed(() => {
  const map: Record<CheckState, string> = {
    blocked: 'text-[--color-status-blocked] bg-[--color-status-blocked-bg]',
    warning: 'text-[--color-status-warn] bg-[--color-status-warn-bg]',
    ok: 'text-[--color-status-ok] bg-[--color-status-ok-bg]',
    absent: 'text-[--color-status-absent] bg-[--color-status-absent-bg]',
    checking: 'text-[--color-status-checking] bg-[--color-status-checking-bg]',
    unknown: 'text-[--color-status-absent] bg-[--color-status-absent-bg]',
  };
  return map[props.state];
});

const iconSize = computed(() => (props.size === 'sm' ? 14 : 16));
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full font-medium"
    :class="[classes, size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm']"
  >
    <component
      :is="icon"
      :size="iconSize"
      :class="state === 'checking' ? 'animate-spin' : ''"
      aria-hidden="true"
    />
    <span v-if="showLabel">{{ presentation.label }}</span>
    <!-- Announced to screen readers even when the label is hidden. -->
    <span v-else class="sr-only">{{ presentation.label }}</span>
  </span>
</template>
