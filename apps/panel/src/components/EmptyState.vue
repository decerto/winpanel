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
}>();

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div
    class="flex flex-col items-center justify-center rounded-[--radius-card] border
           border-dashed border-[--color-border] bg-[--color-surface] px-6 py-12 text-center"
  >
    <component
      v-if="icon"
      :is="icon"
      :size="32"
      class="mb-3 text-[--color-text-muted]"
      aria-hidden="true"
    />
    <h3 class="text-base font-medium text-[--color-text]">{{ title }}</h3>
    <p class="mt-1 max-w-md text-sm text-[--color-text-muted]">{{ description }}</p>

    <button
      v-if="actionLabel"
      type="button"
      class="mt-4 rounded-md bg-[--color-brand] px-4 py-2 text-sm font-medium text-white
             transition-colors hover:bg-[--color-brand-hover]"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </button>
  </div>
</template>
