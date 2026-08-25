<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Check, Pencil, X } from 'lucide-vue-next';

interface DocumentRow {
  id: string;
  json: string;
  truncated: boolean;
}

const props = withDefaults(
  defineProps<{
    document: DocumentRow;
    saving?: boolean;
    saved?: boolean;
    disabled?: boolean;
  }>(),
  { saving: false, saved: false, disabled: false },
);

const emit = defineEmits<{ save: [documentId: string, json: string] }>();

const editing = ref(false);
const draft = ref(props.document.json);
const validationError = ref<string | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

const highlighted = computed(() => highlightJson(props.document.json));

watch(
  () => props.document.json,
  (value) => {
    if (!editing.value) draft.value = value;
  },
);

watch(
  () => props.saved,
  (value) => {
    if (!value) return;
    editing.value = false;
    draft.value = props.document.json;
    validationError.value = null;
  },
);

function beginEditing(): void {
  if (props.disabled || props.document.truncated) return;
  draft.value = props.document.json;
  validationError.value = null;
  editing.value = true;
  void nextTick(() => textarea.value?.focus());
}

function cancelEditing(): void {
  editing.value = false;
  draft.value = props.document.json;
  validationError.value = null;
}

function save(): void {
  if (props.saving) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.value);
  } catch {
    validationError.value = 'Enter valid JSON before updating.';
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    validationError.value = 'A document has to be a JSON object.';
    return;
  }

  validationError.value = null;
  emit('save', props.document.id, draft.value);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    save();
  }
}

const JSON_TOKEN =
  /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false)\b|\bnull\b/g;

function highlightJson(value: string): string {
  let output = '';
  let cursor = 0;

  for (const match of value.matchAll(JSON_TOKEN)) {
    const start = match.index ?? cursor;
    const token = match[0];
    output += escapeHtml(value.slice(cursor, start));

    let kind = 'number';
    if (token.startsWith('"')) {
      kind = /^\s*:/.test(value.slice(start + token.length)) ? 'key' : 'string';
    } else if (token === 'true' || token === 'false') {
      kind = 'boolean';
    } else if (token === 'null') {
      kind = 'null';
    }

    output += `<span class="json-${kind}">${escapeHtml(token)}</span>`;
    cursor = start + token.length;
  }

  return output + escapeHtml(value.slice(cursor));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}
</script>

<template>
  <li class="card overflow-hidden">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-ink-muted">Document</span>
        <span v-if="document.truncated" class="text-xs text-warn">Too large to edit</span>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="!editing"
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="disabled || document.truncated"
          @click="beginEditing"
        >
          <Pencil :size="14" aria-hidden="true" /> Edit
        </button>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="cancelEditing">
            <X :size="14" aria-hidden="true" /> Cancel
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="save">
            <Check :size="14" aria-hidden="true" /> {{ saving ? 'Updating...' : 'Update' }}
          </button>
        </template>
      </div>
    </div>

    <p v-if="validationError" class="border-b border-danger/30 bg-danger-soft/40 px-4 py-2 text-xs text-danger">
      {{ validationError }}
    </p>

    <textarea
      v-if="editing"
      ref="textarea"
      v-model="draft"
      class="min-h-56 w-full resize-y bg-black/25 px-4 py-4 font-mono text-xs leading-relaxed text-ink outline-none"
      aria-label="Document JSON"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      @keydown="onKeydown"
    />
    <pre
      v-else
      class="json-code max-h-96 overflow-auto whitespace-pre-wrap break-words bg-black/25 px-4 py-4 font-mono text-xs leading-relaxed"
      aria-label="Document JSON"
      v-html="highlighted"
    />
  </li>
</template>

<style scoped>
.json-code {
  color: var(--color-ink-muted);
}

.json-code :deep(.json-key) {
  color: var(--color-brand-bright);
}

.json-code :deep(.json-string) {
  color: var(--color-ok);
}

.json-code :deep(.json-number) {
  color: var(--color-warn);
}

.json-code :deep(.json-boolean) {
  color: var(--color-info);
}

.json-code :deep(.json-null) {
  color: var(--color-danger);
}
</style>