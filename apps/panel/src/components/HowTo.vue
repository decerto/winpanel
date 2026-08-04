<script setup lang="ts">
import { ListChecks } from 'lucide-vue-next';

/**
 * Numbered instructions for something the user has to do elsewhere.
 *
 * The panel can do a great deal on its own, but not everything: pasting a key
 * into GitHub, or an A record into a DNS provider, happens on someone else's
 * screen. When that is the case, saying so in short numbered steps is the
 * difference between a five-minute job and an abandoned one — so it gets a
 * consistent, obviously-a-checklist shape rather than a paragraph of prose.
 */

defineProps<{ title: string }>();
</script>

<template>
  <div class="rounded-lg border border-line bg-black/20 p-4">
    <h3 class="flex items-center gap-1.5 text-sm font-medium text-ink">
      <ListChecks :size="15" class="shrink-0 text-brand-bright" aria-hidden="true" />
      {{ title }}
    </h3>

    <ol
      class="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-muted
             marker:font-semibold marker:text-brand-bright
             [&_a]:text-brand-bright [&_a]:underline [&_a]:underline-offset-2
             [&_strong]:font-medium [&_strong]:text-ink"
    >
      <slot />
    </ol>

    <div class="empty:hidden">
      <slot name="footer" />
    </div>
  </div>
</template>
