<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Save, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import LoadingBlock from './LoadingBlock.vue';

/**
 * Editing a text file in place.
 *
 * The common reason to open the file manager at all is a one-line change to a
 * config file or an index page, and making someone download, edit and
 * re-upload for that is absurd. Anything the agent considers binary or too
 * large is refused there rather than mangled here.
 *
 * The modified time the file had when it was opened travels back with the
 * save, so a deployment or a second tab cannot be silently overwritten.
 */

const props = defineProps<{ open: boolean; siteSlug: string; path: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const content = ref('');
const original = ref('');
const modifiedAt = ref<Date | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const dirty = computed(() => content.value !== original.value);
const filename = computed(() => props.path.split('/').pop() ?? props.path);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const file = await api.files.read.query({ siteSlug: props.siteSlug, path: props.path });
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
  saving.value = true;
  error.value = null;

  try {
    const result = await api.files.write.mutate({
      siteSlug: props.siteSlug,
      path: props.path,
      content: content.value,
      expectedModifiedAt: modifiedAt.value,
    });
    modifiedAt.value = result.modifiedAt;
    original.value = content.value;
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    saving.value = false;
  }
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
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    @click.self="requestClose"
  >
    <div
      class="card flex h-[85vh] w-full max-w-4xl flex-col p-5"
      role="dialog"
      aria-modal="true"
      :aria-label="`Edit ${filename}`"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-base font-semibold text-ink">{{ filename }}</h2>
          <p class="mt-1 truncate font-mono text-xs text-ink-faint">{{ path }}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="requestClose">
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

      <LoadingBlock v-if="loading" class="mt-4 flex-1 rounded-card bg-elevated/60" />
      <textarea
        v-else
        v-model="content"
        class="field mt-4 min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
        spellcheck="false"
        :aria-label="`Contents of ${filename}`"
      />

      <div class="mt-4 flex items-center justify-end gap-2">
        <span v-if="dirty" class="mr-auto text-xs text-warn">Unsaved changes</span>
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
