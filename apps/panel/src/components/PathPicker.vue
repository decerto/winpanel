<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight, CornerLeftUp, File, Folder, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';

/**
 * Picks a folder or a file out of what is actually on the server.
 *
 * These settings are paths inside a deployed release, and typing one blind is
 * guesswork: nobody remembers whether the build output is `dist`, `build`,
 * `.output/public` or `public` until they can see it. So this browses the same
 * files the Files tab shows, and gives back the path relative to whatever the
 * setting is measured from.
 *
 * Everything here is relative. `base` is the folder the value is measured
 * against (`current` for a git site, or the application root for a startup
 * file); the value handed back never includes it.
 */

interface Props {
  open: boolean;
  siteSlug: string;
  /** Folder the chosen path is relative to, itself relative to the site root. */
  base: string;
  /** Path relative to `base` that should be selected when this opens. */
  modelValue: string;
  mode?: 'folder' | 'file';
  title?: string;
  /** Shown when the base folder does not exist yet. */
  emptyHint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'folder',
  title: 'Choose a folder',
  emptyHint: 'There is nothing here yet. Deploy this website once, then choose a folder.',
});

const emit = defineEmits<{ 'update:modelValue': [string]; close: [] }>();

type Entry = Awaited<ReturnType<typeof api.files.list.query>>['entries'][number];

/** Where we are browsing, relative to `base`. */
const here = ref('');
const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
/** Only used in file mode; a folder is chosen by being open. */
const chosenFile = ref('');

const joined = (...parts: string[]): string =>
  parts.filter((part) => part.length > 0).join('/');

const selection = computed(() =>
  props.mode === 'file' ? joined(here.value, chosenFile.value) : here.value,
);

const canConfirm = computed(() => props.mode === 'folder' || chosenFile.value.length > 0);

const crumbs = computed(() => {
  const parts = here.value.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
});

const visible = computed(() =>
  props.mode === 'folder'
    ? entries.value.filter((entry) => entry.kind === 'directory')
    : entries.value,
);

async function load(target: string): Promise<void> {
  loading.value = true;
  error.value = null;

  /*
   * Browsing is a read, but a wedged server would otherwise leave this dialog
   * spinning with no way out but reloading the page.
   */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const result = await api.files.list.query(
      { siteSlug: props.siteSlug, path: joined(props.base, target) },
      { signal: controller.signal },
    );
    entries.value = result.entries;
    here.value = target;
  } catch (err) {
    error.value = controller.signal.aborted
      ? 'The server took too long to list that folder.'
      : describeError(err);
  } finally {
    clearTimeout(timer);
    loading.value = false;
  }
}

function open(entry: Entry): void {
  if (entry.kind === 'directory') {
    chosenFile.value = '';
    void load(joined(here.value, entry.name));
  } else if (props.mode === 'file') {
    chosenFile.value = entry.name;
  }
}

function up(): void {
  const parts = here.value.split('/').filter(Boolean);
  parts.pop();
  chosenFile.value = '';
  void load(parts.join('/'));
}

function confirm(): void {
  emit('update:modelValue', selection.value);
  emit('close');
}

// Reopening should start where the current value points, not where the last
// visit ended up.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;

    const value = props.modelValue.replace(/^\/+|\/+$/g, '');
    if (props.mode === 'file') {
      const parts = value.split('/');
      chosenFile.value = parts.pop() ?? '';
      void load(parts.join('/'));
    } else {
      void load(value);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="card flex max-h-[80vh] w-full max-w-lg flex-col p-5"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">{{ title }}</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Browsing this website&#8217;s files on the server.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Close"
          @click="emit('close')"
        >
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <!-- Where we are. The first crumb is the folder everything is measured from. -->
      <div class="mt-4 flex flex-wrap items-center gap-1 text-xs text-ink-faint">
        <button type="button" class="font-mono hover:text-ink" @click="load('')">
          {{ base || 'site' }}
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <ChevronRight :size="12" aria-hidden="true" />
          <button type="button" class="font-mono hover:text-ink" @click="load(crumb.path)">
            {{ crumb.name }}
          </button>
        </template>
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

      <ul class="mt-3 min-h-40 flex-1 overflow-y-auto rounded-card border border-line">
        <li v-if="here.length > 0">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-muted
                   hover:bg-elevated"
            @click="up"
          >
            <CornerLeftUp :size="15" aria-hidden="true" /> Up one folder
          </button>
        </li>

        <li v-if="loading" class="px-3 py-3 text-sm text-ink-faint">Loading&#8230;</li>

        <li v-else-if="visible.length === 0 && here.length === 0" class="px-3 py-3">
          <span class="text-sm text-ink-faint">{{ emptyHint }}</span>
        </li>
        <li v-else-if="visible.length === 0" class="px-3 py-3 text-sm text-ink-faint">
          This folder has nothing in it.
        </li>

        <li v-for="entry in visible" :key="entry.path">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"
            :class="
              mode === 'file' && entry.name === chosenFile
                ? 'bg-brand-soft/40 text-brand-bright'
                : 'text-ink'
            "
            @click="open(entry)"
          >
            <Folder v-if="entry.kind === 'directory'" :size="15" class="text-ink-faint" aria-hidden="true" />
            <File v-else :size="15" class="text-ink-faint" aria-hidden="true" />
            <span class="truncate font-mono">{{ entry.name }}</span>
          </button>
        </li>
      </ul>

      <p class="mt-3 text-xs text-ink-faint">
        Chosen:
        <span class="font-mono text-ink">{{ selection || '(the ' + (base || 'site') + ' folder)' }}</span>
      </p>

      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="!canConfirm" @click="confirm">
          Use this {{ mode === 'file' ? 'file' : 'folder' }}
        </button>
      </div>
    </div>
  </div>
</template>
