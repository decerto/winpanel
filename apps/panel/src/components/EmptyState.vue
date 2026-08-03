<script setup lang="ts">
import type { Component } from 'vue';

/**
 * Empty states.
 *
 * Treated as a real screen rather than an afterthought: an empty list is
 * usually the first thing a new user sees, and it is the best opportunity to
 * explain what the page is for and what to do next.
 */

defineProps<{
  icon?: Component;
  title: string;
  description: string;
  actionLabel?: string;
  busy?: boolean;
  /** Drops the frame, for when this sits inside a card that already has one. */
  flush?: boolean;
}>();

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div
    class="flex flex-col items-center justify-center px-6 py-14 text-center"
    :class="flush ? '' : 'rounded-card border border-dashed border-line bg-surface/60'"
  >
    <span
      v-if="icon"
      class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line
             bg-brand-soft/50 text-brand-bright"
      aria-hidden="true"
    >
      <component :is="icon" :size="22" />
    </span>

    <h3 class="text-base font-semibold text-ink">{{ title }}</h3>
    <p class="mt-1.5 max-w-md text-sm leading-relaxed text-ink-muted">{{ description }}</p>

    <button
      v-if="actionLabel"
      type="button"
      class="btn btn-primary mt-5"
      :disabled="busy"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </button>

    <slot />
  </div>
</template>
