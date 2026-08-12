<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';

/**
 * What a panel shows while its data is on the way.
 *
 * An empty box reads as "broken"; a moving spinner reads as "working on it".
 * Sizing and background come from the caller's classes, so the block can stand
 * in for whatever shape the loaded content will have.
 */

withDefaults(defineProps<{ label?: string; iconSize?: number }>(), { iconSize: 20 });
</script>

<template>
  <div
    class="flex items-center justify-center gap-2.5 text-ink-faint"
    role="status"
    :aria-label="label ?? 'Loading'"
  >
    <LoaderCircle :size="iconSize" class="animate-spin" aria-hidden="true" />
    <span v-if="label" class="text-sm">{{ label }}</span>
  </div>
</template>
