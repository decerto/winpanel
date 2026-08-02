<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { Activity, Globe, HardDrive, Mail, Settings, ShieldCheck } from 'lucide-vue-next';
import { computed } from 'vue';

/**
 * Application shell: persistent sidebar, top bar, content area.
 *
 * Wording throughout uses what things do rather than what they are called
 * internally — "Websites", not "Sites"; "Email", not "Stalwart".
 */

const route = useRoute();

const NAV = [
  { to: '/health', label: 'Server health', icon: Activity },
  { to: '/sites', label: 'Websites', icon: Globe },
  { to: '/files', label: 'Files', icon: HardDrive },
  { to: '/email', label: 'Email', icon: Mail },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

const title = computed(() => (route.meta['title'] as string | undefined) ?? 'WinPanel');

// Sign-in and first-run setup are full-screen: there is nothing useful to
// navigate to until you are through them.
const bare = computed(() => route.meta['bare'] === true);
</script>

<template>
  <RouterView v-if="bare" />

  <div v-else class="flex min-h-screen bg-[--color-surface-sunken]">
    <aside
      class="hidden w-60 shrink-0 border-r border-[--color-border] bg-[--color-surface] md:block"
    >
      <div class="flex h-14 items-center gap-2 border-b border-[--color-border] px-4">
        <span class="text-sm font-semibold text-[--color-text]">WinPanel</span>
      </div>

      <nav class="p-2" aria-label="Main">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="item.to"
          class="mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors"
          :class="
            route.path.startsWith(item.to)
              ? 'bg-[--color-brand-subtle] font-medium text-[--color-brand]'
              : 'text-[--color-text-muted] hover:bg-[--color-surface-sunken]'
          "
        >
          <component :is="item.icon" :size="16" aria-hidden="true" />
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 items-center justify-between border-b border-[--color-border]
               bg-[--color-surface] px-6"
      >
        <h1 class="text-base font-semibold text-[--color-text]">{{ title }}</h1>
      </header>

      <main class="flex-1 overflow-y-auto p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
