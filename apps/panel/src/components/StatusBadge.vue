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
    /**
     * Overrides the wording. The states are shared with the server checks,
     * where "absent" means "not installed"; elsewhere it has to say what is
     * actually absent.
     */
    label?: string;
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
const text = computed(() => props.label ?? presentation.value.label);
const icon = computed(() => ICONS[props.state]);

const classes = computed(() => {
  const map: Record<CheckState, string> = {
    blocked: 'text-danger bg-danger-soft/70 ring-danger/25',
    warning: 'text-warn bg-warn-soft/70 ring-warn/25',
    ok: 'text-ok bg-ok-soft/70 ring-ok/25',
    absent: 'text-idle bg-idle-soft/70 ring-line',
    checking: 'text-info bg-info-soft/70 ring-info/25',
    unknown: 'text-idle bg-idle-soft/70 ring-line',
  };
  return map[props.state];
});

const iconSize = computed(() => (props.size === 'sm' ? 14 : 16));
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset"
    :class="[classes, size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm']"
  >
    <component
      :is="icon"
      :size="iconSize"
      :class="state === 'checking' ? 'animate-spin' : ''"
      aria-hidden="true"
    />
    <span v-if="showLabel">{{ text }}</span>
    <!-- Announced to screen readers even when the label is hidden. -->
    <span v-else class="sr-only">{{ text }}</span>
  </span>
</template>
