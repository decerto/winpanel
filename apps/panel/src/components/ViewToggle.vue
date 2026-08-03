<script setup lang="ts">
import type { Component } from 'vue';

/**
 * A segmented control for choosing how a list is shown.
 *
 * The choice is remembered (see `usePreference`), so this is set once rather
 * than every visit.
 */

defineProps<{
  modelValue: string;
  options: ReadonlyArray<{ value: string; label: string; icon: Component }>;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div
    class="inline-flex rounded-lg border border-line bg-black/20 p-0.5"
    role="group"
    aria-label="Layout"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium
             transition-colors"
      :class="
        modelValue === option.value
          ? 'bg-brand-soft text-brand-bright'
          : 'text-ink-faint hover:text-ink'
      "
      :aria-pressed="modelValue === option.value"
      @click="emit('update:modelValue', option.value)"
    >
      <component :is="option.icon" :size="14" aria-hidden="true" />
      {{ option.label }}
    </button>
  </div>
</template>
