<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Maximize2, Minimize2, RotateCcw, Save, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import CodeEditor from './CodeEditor.vue';
import LoadingBlock from './LoadingBlock.vue';

/**
 * The panel's editor, for whichever file someone opened.
 *
 * The common reason to open the file manager at all is a one-line change to a
 * config file or an index page, and making someone download, edit and
 * re-upload for that is absurd. Anything the agent considers binary or too
 * large is refused there rather than mangled here.
 *
 * It takes over the window rather than sitting in a corner. The files people
 * actually come here to edit — a game server's settings, a long .env — run to
 * hundreds of lines, and a small box turns a one-line change into a scrolling
 * exercise. Full screen is one click further for the files that are longer
 * still.
 *
 * The modified time the file had when it was opened travels back with the
 * save, so a deployment or a second tab cannot be silently overwritten.
 */

const props = defineProps<{
  open: boolean;
  path: string;
  /** Exactly one of these says which file store the path belongs to. */
  siteSlug?: string;
  gameServerSlug?: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const content = ref('');
const original = ref('');
const modifiedAt = ref<Date | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const maximised = ref(false);

const dirty = computed(() => content.value !== original.value);
const filename = computed(() => props.path.split('/').pop() ?? props.path);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const file = props.gameServerSlug
      ? await api.gameServers.files.read.query({ gameServerSlug: props.gameServerSlug, path: props.path })
      : await api.files.read.query({ siteSlug: props.siteSlug ?? '', path: props.path });
    content.value = file.content;
    original.value = file.content;
    modifiedAt.value = file.modifiedAt;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value || loading.value) return;
  saving.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = props.gameServerSlug
      ? await api.gameServers.files.write.mutate({
          gameServerSlug: props.gameServerSlug,
          path: props.path,
          content: content.value,
          expectedModifiedAt: modifiedAt.value,
        })
      : await api.files.write.mutate({
          siteSlug: props.siteSlug ?? '',
          path: props.path,
          content: content.value,
          expectedModifiedAt: modifiedAt.value,
        });
    modifiedAt.value = result.modifiedAt;
    original.value = content.value;
    notice.value = 'Saved.';
    emit('saved');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    saving.value = false;
  }
}

/** Throws away the edits rather than the window, which is a different mistake. */
function revert(): void {
  if (!dirty.value) return;
  if (!window.confirm('Discard your changes and go back to the saved file?')) return;
  content.value = original.value;
}

/** Closing with unsaved edits asks first; every other close is silent. */
function requestClose(): void {
  if (dirty.value && !window.confirm('Close without saving your changes?')) return;
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    requestClose();
    return;
  }
  // Ctrl+S is muscle memory, and the browser's own "save page" dialog is
  // never what someone editing a file here wants.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!saving.value && !loading.value) void save();
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      window.removeEventListener('keydown', onKeydown);
      return;
    }

    window.addEventListener('keydown', onKeydown);
    content.value = '';
    original.value = '';
    modifiedAt.value = null;
    notice.value = null;
    void load();
  },
  { immediate: true },
);

watch(content, () => {
  notice.value = null;
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
    @click.self="requestClose"
  >
    <div
      class="card flex w-full flex-col p-4 sm:p-5"
      :class="maximised ? 'h-full max-w-none' : 'h-[92vh] max-w-6xl'"
      role="dialog"
      aria-modal="true"
      :aria-label="`Edit ${filename}`"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-base font-semibold text-ink">{{ filename }}</h2>
          <p class="mt-1 truncate font-mono text-xs text-ink-faint">{{ path }}</p>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :aria-pressed="maximised"
          :title="maximised ? 'Leave full screen' : 'Full screen'"
          @click="maximised = !maximised"
        >
          <component :is="maximised ? Minimize2 : Maximize2" :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="requestClose">
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

      <LoadingBlock v-if="loading" class="mt-4 flex-1 rounded-card bg-elevated/60" />
      <CodeEditor
        v-else
        v-model="content"
        class="mt-3 flex-1"
        :aria-label="`Contents of ${filename}`"
        @save="save"
      />

      <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
        <span v-if="dirty" class="mr-auto text-xs text-warn">Unsaved changes</span>
        <span v-else-if="notice" class="mr-auto text-xs text-ok">{{ notice }}</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!dirty || saving" @click="revert">
          <RotateCcw :size="14" aria-hidden="true" /> Revert
        </button>
        <button type="button" class="btn btn-ghost" @click="requestClose">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="loading || saving || !dirty"
          @click="save"
        >
          <Save :size="14" aria-hidden="true" /> {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>
