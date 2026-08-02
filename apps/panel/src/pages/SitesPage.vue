<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Globe, Plus } from 'lucide-vue-next';
import EmptyState from '../components/EmptyState.vue';
import { api, describeError } from '../lib/api';

/**
 * The websites list.
 *
 * Shows what a person actually wants to know at a glance: what it is called,
 * where it answers, and whether it is running.
 */

const router = useRouter();

type Site = Awaited<ReturnType<typeof api.sites.list.query>>[number];

const sites = ref<Site[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    sites.value = await api.sites.list.query();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <div v-if="sites.length > 0" class="mb-4 flex justify-end">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md bg-[--color-brand] px-3 py-2 text-sm
               font-medium text-white hover:bg-[--color-brand-hover]"
        @click="router.push('/sites/new')"
      >
        <Plus :size="15" aria-hidden="true" /> Add a website
      </button>
    </div>

    <p
      v-if="error"
      class="mb-4 rounded-md bg-[--color-status-blocked-bg] px-4 py-3 text-sm
             text-[--color-status-blocked]"
    >
      {{ error }}
    </p>

    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 3"
        :key="n"
        class="h-20 animate-pulse rounded-[--radius-card] border border-[--color-border]
               bg-[--color-surface]"
      />
    </div>

    <EmptyState
      v-else-if="sites.length === 0"
      :icon="Globe"
      title="No websites yet"
      description="Add your first website and the panel will work out how to build it, point your
                   domain here, and secure it with HTTPS."
      action-label="Add a website"
      @action="router.push('/sites/new')"
    />

    <ul v-else class="space-y-3">
      <li v-for="site in sites" :key="site.id">
        <button
          type="button"
          class="w-full rounded-[--radius-card] border border-[--color-border]
                 bg-[--color-surface] p-4 text-left transition-colors
                 hover:border-[--color-brand]"
          @click="router.push(`/sites/${site.slug}`)"
        >
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <h3 class="font-medium text-[--color-text]">{{ site.displayName }}</h3>
              <p class="truncate text-sm text-[--color-text-muted]">
                {{ site.domains.join(', ') || 'No web address yet' }}
              </p>
            </div>

            <span class="shrink-0 font-mono text-xs text-[--color-text-muted]">
              {{ site.activePort ? `port ${site.activePort}` : 'not deployed' }}
            </span>
          </div>
        </button>
      </li>
    </ul>
  </div>
</template>
