<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  CornerLeftUp,
  Download,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Folder,
  Link2,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { downloadUrl, uploadFile } from '../../lib/file-transfer';
import { formatBytes } from '../../lib/format';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import FileEditorDialog from '../../components/FileEditorDialog.vue';

/**
 * File manager for a website.
 *
 * Everything here works on the folder currently shown: uploads land in it,
 * paste moves into it, a new file is created in it. That is the one rule that
 * keeps a file manager comprehensible — there is never a second, invisible
 * "target" folder to reason about.
 *
 * The panel warns before you edit anything under `release/`, because the next
 * deployment replaces that folder wholesale and the change would silently
 * disappear.
 */

const route = useRoute();
const slug = computed(() => (route.params['slug'] as string) ?? '');

/*
 * Open where the files are, not at the site root.
 *
 * The root holds `release`, `shared` and `logs` — all panel bookkeeping. For
 * a website that is just HTML, landing there means the first thing you see is
 * four folders none of which are yours.
 */
const { site } = inject(siteContextKey)!;
const startPath = computed(() => site.value?.contentFolder ?? '');

type Listing = Awaited<ReturnType<typeof api.files.list.query>>;
type Entry = Listing['entries'][number];

const listing = ref<Listing | null>(null);
const currentPath = ref('');
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const showHidden = ref(false);
const sortBy = ref<'name' | 'size' | 'modified'>('name');
const sortDir = ref<'asc' | 'desc'>('asc');

const selected = ref<Set<string>>(new Set());
const renaming = ref<{ path: string; name: string } | null>(null);
const creating = ref<{ kind: 'folder' | 'file'; name: string } | null>(null);
const editing = ref<string | null>(null);
/** Cut or copied paths, waiting for a folder to be pasted into. */
const clipboard = ref<{ paths: string[]; copy: boolean } | null>(null);
const transfer = ref<{ name: string; index: number; total: number; fraction: number } | null>(null);
const dragging = ref(false);

const entries = computed(() => listing.value?.entries ?? []);

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

const selectedEntries = computed(() => entries.value.filter((e) => selected.value.has(e.path)));
const allSelected = computed(
  () => entries.value.length > 0 && selected.value.size === entries.value.length,
);
/** Only a single file can be renamed or edited at a time. */
const soleSelection = computed(() =>
  selectedEntries.value.length === 1 ? selectedEntries.value[0]! : null,
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
      sortBy: sortBy.value,
      sortDir: sortDir.value,
    });
    // A path that no longer exists in this folder cannot be acted on, and a
    // stale tick is how someone deletes the wrong thing.
    const present = new Set(listing.value.entries.map((entry) => entry.path));
    selected.value = new Set([...selected.value].filter((path) => present.has(path)));
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

/** Runs an operation, showing whatever the agent said if it refused. */
async function run(action: () => Promise<string | void>): Promise<void> {
  error.value = null;
  notice.value = null;

  try {
    const message = await action();
    if (message) notice.value = message;
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

function goTo(path: string): void {
  currentPath.value = path;
  selected.value = new Set();
  renaming.value = null;
  creating.value = null;
  void load();
}

function goUp(): void {
  const parts = currentPath.value.split('/').filter(Boolean);
  parts.pop();
  goTo(parts.join('/'));
}

function open(entry: Entry): void {
  if (entry.kind === 'directory') goTo(entry.path);
  else editing.value = entry.path;
}

function toggle(path: string): void {
  const next = new Set(selected.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(entries.value.map((e) => e.path));
}

function sortByColumn(column: 'name' | 'size' | 'modified'): void {
  if (sortBy.value === column) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  else {
    sortBy.value = column;
    sortDir.value = 'asc';
  }
  void load();
}

function startCreate(kind: 'folder' | 'file'): void {
  creating.value = { kind, name: '' };
}

async function create(): Promise<void> {
  const pending = creating.value;
  const name = (pending?.name ?? '').trim();
  if (!pending || !name) {
    creating.value = null;
    return;
  }

  await run(async () => {
    if (pending.kind === 'folder') {
      await api.files.createFolder.mutate({
        siteSlug: slug.value,
        parentPath: currentPath.value,
        name,
      });
    } else {
      // An empty write is the create: there is no separate "touch" call, and
      // an empty file is what a new one should be anyway.
      await api.files.write.mutate({
        siteSlug: slug.value,
        path: currentPath.value ? `${currentPath.value}/${name}` : name,
        content: '',
        expectedModifiedAt: null,
      });
    }
    creating.value = null;
  });
}

function startRename(entry: Entry): void {
  renaming.value = { path: entry.path, name: entry.name };
}

async function rename(): Promise<void> {
  const pending = renaming.value;
  const name = (pending?.name ?? '').trim();
  if (!pending || !name) {
    renaming.value = null;
    return;
  }

  await run(async () => {
    await api.files.rename.mutate({ siteSlug: slug.value, path: pending.path, newName: name });
    renaming.value = null;
  });
}

function cut(): void {
  clipboard.value = { paths: selectedEntries.value.map((e) => e.path), copy: false };
  notice.value = `${clipboard.value.paths.length} item(s) ready to move. Open a folder and choose Paste.`;
}

function copy(): void {
  clipboard.value = { paths: selectedEntries.value.map((e) => e.path), copy: true };
  notice.value = `${clipboard.value.paths.length} item(s) ready to copy. Open a folder and choose Paste.`;
}

async function paste(): Promise<void> {
  const pending = clipboard.value;
  if (!pending) return;

  await run(async () => {
    await api.files.move.mutate({
      siteSlug: slug.value,
      sourcePaths: pending.paths,
      destinationPath: currentPath.value,
      copy: pending.copy,
    });
    clipboard.value = null;
    selected.value = new Set();
  });
}

async function remove(targets: Entry[], permanent = false): Promise<void> {
  if (targets.length === 0) return;

  const what =
    targets.length === 1 ? `"${targets[0]!.name}"` : `these ${targets.length} items`;
  const question = permanent
    ? `Permanently delete ${what}? This cannot be undone.`
    : `Move ${what} to the recycle folder?`;
  if (!window.confirm(question)) return;

  await run(async () => {
    const result = await api.files.remove.mutate({
      siteSlug: slug.value,
      paths: targets.map((entry) => entry.path),
      permanent,
    });
    selected.value = new Set();
    return result.note;
  });
}

function download(entry: Entry): void {
  window.location.href = downloadUrl(slug.value, entry.path);
}

/** Uploads land in the folder on screen, one after another. */
async function upload(files: File[]): Promise<void> {
  error.value = null;
  notice.value = null;

  for (const [index, file] of files.entries()) {
    transfer.value = { name: file.name, index: index + 1, total: files.length, fraction: 0 };

    try {
      await uploadFile(slug.value, currentPath.value, file, (fraction) => {
        if (transfer.value) transfer.value.fraction = fraction;
      }).promise;
    } catch (err) {
      error.value = describeError(err);
      break;
    }
  }

  transfer.value = null;
  await load();
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  // Reset first, so picking the same file twice in a row still fires.
  input.value = '';
  if (files.length > 0) void upload(files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) void upload(files);
}

watch([slug, showHidden], load, { immediate: true });

/*
 * The site loads after this page mounts, so the starting folder is only known
 * once it arrives. Applied once, and never afterwards, so it cannot yank the
 * user back out of a folder they have navigated into.
 */
const startApplied = ref(false);
watch(
  startPath,
  (folder) => {
    if (startApplied.value || !folder) return;
    startApplied.value = true;
    currentPath.value = folder;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="space-y-4">
    <AlertMessage v-if="listing?.ephemeral" tone="warning">
      Files here are replaced every time you deploy. To change something permanently, edit it in
      your project and deploy again, or use the <strong>shared</strong> folder.
    </AlertMessage>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="info">{{ notice }}</AlertMessage>

    <div
      class="card overflow-hidden"
      :class="dragging ? 'ring-2 ring-brand' : ''"
      @dragover.prevent="dragging = true"
      @dragleave.self="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="currentPath === ''"
          aria-label="Go up one folder"
          @click="goUp"
        >
          <CornerLeftUp :size="14" aria-hidden="true" />
        </button>

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

        <button type="button" class="btn btn-ghost btn-sm" aria-label="Refresh" @click="load">
          <RefreshCw :size="14" aria-hidden="true" />
        </button>
      </div>

      <!-- Actions on the folder itself, then actions on what is ticked. -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-4 py-2.5">
        <label class="btn btn-primary btn-sm cursor-pointer">
          <Upload :size="14" aria-hidden="true" /> Upload
          <input type="file" class="sr-only" multiple aria-label="Upload files" @change="onFilePicked" />
        </label>

        <button type="button" class="btn btn-ghost btn-sm" @click="startCreate('folder')">
          <FolderPlus :size="14" aria-hidden="true" /> New folder
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="startCreate('file')">
          <FilePlus :size="14" aria-hidden="true" /> New file
        </button>

        <span class="mx-1 h-5 w-px bg-line" aria-hidden="true" />

        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="selected.size === 0"
          @click="copy"
        >
          <Copy :size="14" aria-hidden="true" /> Copy
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="selected.size === 0"
          @click="cut"
        >
          <Scissors :size="14" aria-hidden="true" /> Cut
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="!clipboard"
          @click="paste"
        >
          <ClipboardPaste :size="14" aria-hidden="true" /> Paste
        </button>

        <span class="mx-1 h-5 w-px bg-line" aria-hidden="true" />

        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="!soleSelection"
          @click="soleSelection && startRename(soleSelection)"
        >
          <Pencil :size="14" aria-hidden="true" /> Rename
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="selected.size === 0"
          @click="remove(selectedEntries)"
        >
          <Trash2 :size="14" aria-hidden="true" /> Delete
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm text-danger"
          :disabled="selected.size === 0"
          @click="remove(selectedEntries, true)"
        >
          Delete permanently
        </button>
      </div>

      <form
        v-if="creating"
        class="flex gap-2 border-b border-line bg-sunken px-4 py-3"
        @submit.prevent="create"
      >
        <input
          v-model="creating.name"
          class="field max-w-xs"
          :placeholder="creating.kind === 'folder' ? 'Folder name' : 'File name'"
          :aria-label="creating.kind === 'folder' ? 'Folder name' : 'File name'"
          autofocus
        />
        <button type="submit" class="btn btn-primary btn-sm">Create</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="creating = null">Cancel</button>
      </form>

      <div v-if="transfer" class="border-b border-line px-4 py-2.5">
        <p class="text-xs text-ink-muted">
          Uploading {{ transfer.name }} ({{ transfer.index }} of {{ transfer.total }})
        </p>
        <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/40">
          <div
            class="h-full rounded-full bg-brand transition-[width]"
            :style="{ width: `${Math.round(transfer.fraction * 100)}%` }"
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-2">
        <div class="flex items-center gap-4">
          <label class="flex items-center gap-2 text-xs text-ink-muted">
            <input :checked="allSelected" type="checkbox" aria-label="Select everything" @change="toggleAll" />
            Select all
          </label>
          <label class="flex items-center gap-2 text-xs text-ink-muted">
            <input v-model="showHidden" type="checkbox" /> Show hidden files
          </label>
        </div>

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

      <div
        class="flex items-center gap-3 border-b border-line px-4 py-1.5 text-xs text-ink-faint"
      >
        <span class="w-4 shrink-0" aria-hidden="true" />
        <span class="w-4 shrink-0" aria-hidden="true" />
        <button type="button" class="flex-1 text-left hover:text-ink" @click="sortByColumn('name')">
          Name
        </button>
        <button type="button" class="w-24 text-right hover:text-ink" @click="sortByColumn('modified')">
          Modified
        </button>
        <button type="button" class="w-20 text-right hover:text-ink" @click="sortByColumn('size')">
          Size
        </button>
        <span class="w-[86px] shrink-0" aria-hidden="true" />
      </div>

      <div v-if="loading" class="space-y-2 p-4">
        <div v-for="n in 6" :key="n" class="h-9 animate-pulse rounded-md bg-elevated/60" />
      </div>

      <EmptyState
        v-else-if="entries.length === 0"
        :icon="Folder"
        title="This folder is empty"
        description="Drop files here to upload them, or create a folder to put something in."
        flush
      />

      <ul v-else class="divide-y divide-line">
        <li
          v-for="entry in entries"
          :key="entry.path"
          class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
          :class="selected.has(entry.path) ? 'bg-brand/10' : ''"
        >
          <input
            type="checkbox"
            class="shrink-0"
            :checked="selected.has(entry.path)"
            :aria-label="`Select ${entry.name}`"
            @change="toggle(entry.path)"
          />

          <component
            :is="entry.kind === 'directory' ? Folder : FileIcon"
            :size="16"
            class="shrink-0"
            :class="entry.kind === 'directory' ? 'text-brand-bright' : 'text-ink-faint'"
            aria-hidden="true"
          />

          <form
            v-if="renaming?.path === entry.path"
            class="flex flex-1 gap-2"
            @submit.prevent="rename"
          >
            <input
              v-model="renaming.name"
              class="field max-w-xs"
              :aria-label="`New name for ${entry.name}`"
              autofocus
            />
            <button type="submit" class="btn btn-primary btn-sm">Rename</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="renaming = null">
              Cancel
            </button>
          </form>

          <template v-else>
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-sm text-ink hover:underline"
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

            <span class="w-24 shrink-0 text-right text-xs text-ink-faint">
              {{ entry.modifiedAt.toLocaleDateString() }}
            </span>
            <span class="w-20 shrink-0 text-right font-mono text-xs text-ink-faint">
              {{ entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '' }}
            </span>

            <div class="flex w-[86px] shrink-0 justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <button
                v-if="entry.kind === 'file'"
                type="button"
                class="rounded-md p-1.5 text-ink-faint transition hover:bg-elevated hover:text-ink"
                :aria-label="`Edit ${entry.name}`"
                @click="editing = entry.path"
              >
                <Pencil :size="14" />
              </button>
              <button
                v-if="entry.kind === 'file'"
                type="button"
                class="rounded-md p-1.5 text-ink-faint transition hover:bg-elevated hover:text-ink"
                :aria-label="`Download ${entry.name}`"
                @click="download(entry)"
              >
                <Download :size="14" />
              </button>
              <button
                type="button"
                class="rounded-md p-1.5 text-ink-faint transition hover:bg-danger-soft hover:text-danger"
                :aria-label="`Delete ${entry.name}`"
                @click="remove([entry])"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </template>
        </li>
      </ul>
    </div>

    <FileEditorDialog
      v-if="editing"
      :open="editing !== null"
      :site-slug="slug"
      :path="editing"
      @close="editing = null"
      @saved="load"
    />
  </div>
</template>
