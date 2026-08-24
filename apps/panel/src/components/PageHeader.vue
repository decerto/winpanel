<script setup lang="ts">
/**
 * The heading block at the top of a page.
 *
 * Kept as a component so every page states what it is and why it exists in
 * the same place, rather than each one inventing its own arrangement.
 */

defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div class="min-w-0">
      <h2 class="text-xl font-semibold tracking-tight text-ink">{{ title }}</h2>
      <p v-if="description" class="mt-1 max-w-2xl text-sm text-ink-muted">{{ description }}</p>
    </div>

    <div class="page-header-actions flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
