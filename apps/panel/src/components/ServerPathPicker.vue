<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronRight, CornerLeftUp, File, Folder, HardDrive, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import Tooltip from './Tooltip.vue';

/**
 * Picks a file or folder from the server's own disk.
 *
 * The sibling of PathPicker, which browses inside one website. This one is for
 * the handful of fields that mean "somewhere on this machine" — where nobody
 * can be expected to type a Windows path correctly from memory.
 *
 * All path arithmetic happens on the server: it hands back the folder it
 * listed, its parent, and an absolute path for every entry, so nothing here
 * has to know which way the slashes lean.
 */

interface Props {
  open: boolean;
  modelValue: string;
  mode?: 'file' | 'folder';
  /** Lower-case, with the dot. Folders are always listed. */
  extensions?: string[];
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'file',
  extensions: () => [],
  title: 'Choose a file on this server',
});

const emit = defineEmits<{ 'update:modelValue': [string]; close: [] }>();

type Listing = Awaited<ReturnType<typeof api.system.browse.query>>;

const listing = ref<Listing | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const chosenFile = ref('');

const selection = computed(() =>
  props.mode === 'file' ? chosenFile.value : (listing.value?.path ?? ''),
);

const canConfirm = computed(() => selection.value.length > 0);

/** Every folder above this one, so any of them can be jumped back to. */
const crumbs = computed(() => {
  const here = listing.value?.path;
  if (!here) return [];

  const parts = here.split(/[\\/]+/).filter(Boolean);
  const separator = here.includes('\\') ? '\\' : '/';

  return parts.map((name, index) => ({
    name: index === 0 ? name + separator : name,
    path: parts.slice(0, index + 1).join(separator) + (index === 0 ? separator : ''),
  }));
});

async function load(target: string | null): Promise<void> {
  loading.value = true;
  error.value = null;

  // A drive that has gone away can take a long time to answer, and a dialog
  // with no way out but reloading the page is worse than an error.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const result = await api.system.browse.query(
      {
        ...(target ? { path: target } : {}),
        ...(props.mode === 'file' && props.extensions.length > 0
          ? { extensions: props.extensions }
          : {}),
      },
      { signal: controller.signal },
    );

    listing.value = result;
    if (result.selected) chosenFile.value = result.selected;
  } catch (err) {
    error.value = controller.signal.aborted
      ? 'The server took too long to list that folder.'
      : describeError(err);
  } finally {
    clearTimeout(timer);
    loading.value = false;
  }
}

// Not called `open`: a binding in <script setup> shadows the prop of the same
// name in the template, so `v-if="open"` would test a function and the dialog
// could never be closed.
function openEntry(entry: Listing['entries'][number]): void {
  if (entry.kind === 'directory') {
    chosenFile.value = '';
    void load(entry.path);
  } else if (props.mode === 'file') {
    chosenFile.value = entry.path;
  }
}

function confirm(): void {
  emit('update:modelValue', selection.value);
  emit('close');
}

// A dialog with no keyboard way out is a trap when a button misbehaves.
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

// Reopening starts where the current value points rather than where the last
// visit ended up.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      window.removeEventListener('keydown', closeOnEscape);
      return;
    }

    window.addEventListener('keydown', closeOnEscape);
    chosenFile.value = '';
    void load(props.modelValue.trim() || null);
  },
  { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('keydown', closeOnEscape));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="card flex max-h-[80vh] w-full max-w-xl flex-col p-5"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">{{ title }}</h2>
          <p class="mt-1 text-sm text-ink-muted">Browsing this server&#8217;s own disks.</p>
        </div>
        <Tooltip text="Close">
          <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="emit('close')">
            <X :size="15" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-1 text-xs text-ink-faint">
        <button type="button" class="font-mono hover:text-ink" @click="load(null)">
          This server
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <ChevronRight :size="12" aria-hidden="true" />
          <button type="button" class="font-mono hover:text-ink" @click="load(crumb.path)">
            {{ crumb.name }}
          </button>
        </template>
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

      <ul class="mt-3 min-h-48 flex-1 overflow-y-auto rounded-card border border-line">
        <li v-if="listing?.parent">
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-muted
                   hover:bg-elevated"
            @click="load(listing.parent)"
          >
            <CornerLeftUp :size="15" aria-hidden="true" /> Up one folder
          </button>
        </li>

        <li v-if="loading" class="px-3 py-3 text-sm text-ink-faint">Loading&#8230;</li>

        <!-- No folder open: the drives are the only sensible starting point. -->
        <template v-else-if="listing && listing.path === null">
          <li v-for="drive in listing.drives" :key="drive">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink
                     hover:bg-elevated"
              @click="load(drive)"
            >
              <HardDrive :size="15" class="text-ink-faint" aria-hidden="true" />
              <span class="font-mono">{{ drive }}</span>
            </button>
          </li>
        </template>

        <template v-else-if="listing">
          <li v-if="listing.entries.length === 0" class="px-3 py-3 text-sm text-ink-faint">
            {{
              mode === 'file' && extensions.length > 0
                ? `No folders, and no ${extensions.join(' or ')} files, in here.`
                : 'This folder has nothing in it.'
            }}
          </li>

          <li v-for="entry in listing.entries" :key="entry.path">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"
              :class="entry.path === chosenFile ? 'bg-brand-soft/40 text-brand-bright' : 'text-ink'"
              @click="openEntry(entry)"
            >
              <Folder
                v-if="entry.kind === 'directory'"
                :size="15"
                class="text-ink-faint"
                aria-hidden="true"
              />
              <File v-else :size="15" class="text-ink-faint" aria-hidden="true" />
              <span class="truncate font-mono">{{ entry.name }}</span>
            </button>
          </li>

          <li v-if="listing.truncated" class="px-3 py-2 text-xs text-ink-faint">
            Only the first 1000 items are shown.
          </li>
        </template>
      </ul>

      <p class="mt-3 truncate text-xs text-ink-faint">
        Chosen: <span class="font-mono text-ink">{{ selection || 'nothing yet' }}</span>
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
