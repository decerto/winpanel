<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  Link2,
  Trash2,
  TriangleAlert,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import EmptyState from '../components/EmptyState.vue';

/**
 * File browser for a website.
 *
 * The panel warns before you edit anything under `releases/`, because the next
 * deployment replaces that folder wholesale and the change would silently
 * disappear.
 */

const route = useRoute();
const slug = computed(() => (route.params['slug'] as string) ?? '');

type Listing = Awaited<ReturnType<typeof api.files.list.query>>;

const listing = ref<Listing | null>(null);
const currentPath = ref('');
const loading = ref(true);
const error = ref<string | null>(null);
const showHidden = ref(false);

const breadcrumbs = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join('/'),
  }));
});

const quotaPercent = computed(() => {
  if (!listing.value) return 0;
  return Math.min(100, (listing.value.quotaUsedBytes / listing.value.quotaTotalBytes) * 100);
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '\u2014';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function load(): Promise<void> {
  if (!slug.value) return;
  loading.value = true;
  error.value = null;

  try {
    listing.value = await api.files.list.query({
      siteSlug: slug.value,
      path: currentPath.value,
      showHidden: showHidden.value,
      sortBy: 'name',
      sortDir: 'asc',
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

function open(entry: { kind: string; path: string }): void {
  if (entry.kind === 'directory') {
    currentPath.value = entry.path;
    void load();
  }
}

async function remove(entryPath: string): Promise<void> {
  try {
    await api.files.remove.mutate({
      siteSlug: slug.value,
      paths: [entryPath],
      // Soft delete: recoverable from the recycle folder.
      permanent: false,
    });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

watch([slug, showHidden], load);
onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <nav class="mb-3 flex items-center gap-1 text-sm" aria-label="Folder path">
      <button type="button" class="text-[--color-brand] hover:underline"
              @click="currentPath = ''; load()">
        {{ slug || 'Files' }}
      </button>
      <template v-for="crumb in breadcrumbs" :key="crumb.path">
        <ChevronRight :size="14" class="text-[--color-text-muted]" aria-hidden="true" />
        <button type="button" class="text-[--color-brand] hover:underline"
                @click="currentPath = crumb.path; load()">
          {{ crumb.name }}
        </button>
      </template>
    </nav>

    <div
      v-if="listing?.ephemeral"
      class="mb-3 flex items-start gap-2 rounded-md bg-[--color-status-warn-bg] px-3 py-2
             text-sm text-[--color-status-warn]"
    >
      <TriangleAlert :size="15" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        Files here are replaced every time you deploy. To change something permanently,
        edit it in your project and deploy again, or use the <strong>shared</strong> folder.
      </span>
    </div>

    <p v-if="error" class="mb-3 rounded-md bg-[--color-status-blocked-bg] px-4 py-3 text-sm
                           text-[--color-status-blocked]">
      {{ error }}
    </p>

    <div class="rounded-[--radius-card] border border-[--color-border] bg-[--color-surface]">
      <div class="flex items-center justify-between border-b border-[--color-border] px-4 py-2">
        <label class="flex items-center gap-2 text-sm text-[--color-text-muted]">
          <input type="checkbox" v-model="showHidden" /> Show hidden files
        </label>

        <span v-if="listing" class="text-xs text-[--color-text-muted]">
          {{ formatBytes(listing.quotaUsedBytes) }} of
          {{ formatBytes(listing.quotaTotalBytes) }} used
        </span>
      </div>

      <div v-if="quotaPercent > 80" class="px-4 pt-2">
        <div class="h-1.5 overflow-hidden rounded-full bg-[--color-surface-sunken]">
          <div class="h-full bg-[--color-status-warn]" :style="{ width: `${quotaPercent}%` }" />
        </div>
      </div>

      <div v-if="loading" class="space-y-2 p-4">
        <div v-for="n in 5" :key="n"
             class="h-8 animate-pulse rounded bg-[--color-surface-sunken]" />
      </div>

      <EmptyState
        v-else-if="!listing || listing.entries.length === 0"
        :icon="Folder"
        title="This folder is empty"
        description="Nothing here yet."
      />

      <ul v-else class="divide-y divide-[--color-border]">
        <li v-for="entry in listing.entries" :key="entry.path"
            class="flex items-center gap-3 px-4 py-2 hover:bg-[--color-surface-sunken]">
          <component :is="entry.kind === 'directory' ? Folder : FileIcon" :size="16"
                     class="shrink-0 text-[--color-text-muted]" aria-hidden="true" />

          <button type="button" class="min-w-0 flex-1 truncate text-left text-sm"
                  :class="entry.kind === 'directory' ? 'text-[--color-brand]' : 'text-[--color-text]'"
                  @click="open(entry)">
            {{ entry.name }}
          </button>

          <!-- Links are shown but never followed; a junction is the most
               direct way out of a contained folder. -->
          <Link2 v-if="entry.isLink" :size="13" class="text-[--color-status-warn]"
                 aria-label="Shortcut to another location" />

          <span class="w-20 shrink-0 text-right font-mono text-xs text-[--color-text-muted]">
            {{ entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '' }}
          </span>

          <button type="button" class="shrink-0 text-[--color-text-muted] hover:text-[--color-status-blocked]"
                  :aria-label="`Delete ${entry.name}`" @click="remove(entry.path)">
            <Trash2 :size="14" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
