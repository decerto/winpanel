<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderPlus,
  Link2,
  Trash2,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';

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
const newFolderName = ref<string | null>(null);

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

/** Folders first, then files: the same order every desktop uses. */
const entries = computed(() =>
  [...(listing.value?.entries ?? [])].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  }),
);

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

function goTo(path: string): void {
  currentPath.value = path;
  void load();
}

function open(entry: { kind: string; path: string }): void {
  if (entry.kind === 'directory') goTo(entry.path);
}

async function createFolder(): Promise<void> {
  const name = (newFolderName.value ?? '').trim();
  if (!name) {
    newFolderName.value = null;
    return;
  }

  try {
    await api.files.createFolder.mutate({
      siteSlug: slug.value,
      parentPath: currentPath.value,
      name,
    });
    newFolderName.value = null;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function remove(entry: { name: string; path: string }): Promise<void> {
  // Deleting goes to a recycle folder, so this asks once rather than twice.
  if (!window.confirm(`Move "${entry.name}" to the recycle folder?`)) return;

  try {
    await api.files.remove.mutate({
      siteSlug: slug.value,
      paths: [entry.path],
      permanent: false,
    });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

watch([slug, showHidden], load, { immediate: true });
</script>

<template>
  <div class="space-y-4">
    <AlertMessage v-if="listing?.ephemeral" tone="warning">
      Files here are replaced every time you deploy. To change something permanently, edit it in
      your project and deploy again, or use the <strong>shared</strong> folder.
    </AlertMessage>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>

    <div class="card overflow-hidden">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <nav class="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Folder path">
          <button type="button" class="text-brand-bright hover:underline" @click="goTo('')">
            Site root
          </button>
          <template v-for="crumb in breadcrumbs" :key="crumb.path">
            <ChevronRight :size="14" class="shrink-0 text-ink-faint" aria-hidden="true" />
            <button
              type="button"
              class="truncate text-brand-bright hover:underline"
              @click="goTo(crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </nav>

        <button type="button" class="btn btn-ghost btn-sm" @click="newFolderName = ''">
          <FolderPlus :size="14" aria-hidden="true" /> New folder
        </button>
      </div>

      <form
        v-if="newFolderName !== null"
        class="flex gap-2 border-b border-line bg-sunken px-4 py-3"
        @submit.prevent="createFolder"
      >
        <input
          v-model="newFolderName"
          class="field max-w-xs"
          placeholder="Folder name"
          aria-label="Folder name"
          autofocus
        />
        <button type="submit" class="btn btn-primary btn-sm">Create</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="newFolderName = null">
          Cancel
        </button>
      </form>

      <div class="flex items-center justify-between gap-4 border-b border-line px-4 py-2">
        <label class="flex items-center gap-2 text-xs text-ink-muted">
          <input v-model="showHidden" type="checkbox" /> Show hidden files
        </label>

        <div v-if="listing" class="flex items-center gap-2 text-xs text-ink-muted">
          <div class="h-1.5 w-24 overflow-hidden rounded-full bg-black/40">
            <div
              class="h-full rounded-full"
              :class="quotaPercent > 80 ? 'bg-warn' : 'bg-brand'"
              :style="{ width: `${Math.max(2, quotaPercent)}%` }"
            />
          </div>
          {{ formatBytes(listing.quotaUsedBytes) }} of
          {{ formatBytes(listing.quotaTotalBytes) }} used
        </div>
      </div>

      <div v-if="loading" class="space-y-2 p-4">
        <div v-for="n in 6" :key="n" class="h-9 animate-pulse rounded-md bg-elevated/60" />
      </div>

      <EmptyState
        v-else-if="entries.length === 0"
        :icon="Folder"
        title="This folder is empty"
        description="Deploy your website, or create a folder to put something here."
        flush
      />

      <ul v-else class="divide-y divide-line">
        <li
          v-for="entry in entries"
          :key="entry.path"
          class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
        >
          <component
            :is="entry.kind === 'directory' ? Folder : FileIcon"
            :size="16"
            class="shrink-0"
            :class="entry.kind === 'directory' ? 'text-brand-bright' : 'text-ink-faint'"
            aria-hidden="true"
          />

          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-sm"
            :class="entry.kind === 'directory' ? 'text-ink hover:underline' : 'text-ink-muted'"
            @click="open(entry)"
          >
            {{ entry.name }}
          </button>

          <!-- Links are shown but never followed; a junction is the most
               direct way out of a contained folder. -->
          <Link2
            v-if="entry.isLink"
            :size="13"
            class="shrink-0 text-warn"
            aria-label="Shortcut to another location"
          />

          <span class="w-20 shrink-0 text-right font-mono text-xs text-ink-faint">
            {{ entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '' }}
          </span>

          <button
            type="button"
            class="shrink-0 rounded-md p-1.5 text-ink-faint opacity-0 transition
                   hover:bg-danger-soft hover:text-danger focus-visible:opacity-100
                   group-hover:opacity-100"
            :aria-label="`Delete ${entry.name}`"
            @click="remove(entry)"
          >
            <Trash2 :size="14" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
