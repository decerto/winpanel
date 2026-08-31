<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Check, ChevronDown, Search } from 'lucide-vue-next';

/**
 * A dropdown that scales past a handful of options.
 *
 * A plain `<select>` is fine until there are fifty accounts on the server, at
 * which point scrolling an unsorted list to find one name is the slowest part
 * of the page. This keeps the closed state compact and adds a filter box the
 * moment it opens: type a little of the name, the list narrows to match.
 *
 * Options are plain values with a label, so the caller does not have to shape
 * its data for the component's sake.
 */

export interface SearchableOption {
  value: string;
  label: string;
  /** Extra text the filter also matches, e.g. a secondary line. */
  hint?: string;
}

const DEFAULT_OPTION_LIMIT = 10;

const props = defineProps<{
  /** The currently selected value, or '' for none. */
  modelValue: string;
  options: SearchableOption[];
  id?: string;
  /** What the closed control says when nothing is chosen. */
  placeholder?: string;
  /** Accessible name for the control. */
  label?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const query = ref('');
const root = ref<HTMLElement | null>(null);
const searchBox = ref<HTMLInputElement | null>(null);

/*
 * The pointerdown that opened the menu must not immediately close it again.
 * The document listener is registered the moment `open` flips, which is the
 * same event that is still bubbling up from the trigger — so it is armed on
 * the next task rather than synchronously, letting that first event pass.
 */
let ignoreUntil = 0;

const selected = computed(() => props.options.find((option) => option.value === props.modelValue));

/** The filter matches label and hint, case-insensitively, on any substring. */
const matching = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.options;

  return props.options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.hint ?? '').toLowerCase().includes(needle),
  );
});

const visibleOptions = computed(() => {
  if (query.value.trim()) return matching.value;
  if (matching.value.length <= DEFAULT_OPTION_LIMIT) return matching.value;

  const initial = matching.value.slice(0, DEFAULT_OPTION_LIMIT);
  if (selected.value && !initial.some((option) => option.value === selected.value!.value)) {
    initial[DEFAULT_OPTION_LIMIT - 1] = selected.value;
  }
  return initial;
});

function choose(value: string): void {
  emit('update:modelValue', value);
  open.value = false;
  query.value = '';
}

async function toggle(): Promise<void> {
  if (props.disabled) return;

  open.value = !open.value;
  if (open.value) {
    query.value = '';
    await nextTick();
    searchBox.value?.focus();
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open.value = false;
    query.value = '';
  }
}

/** Clicking anywhere outside closes it, the way a native select behaves. */
function onPointerDown(event: PointerEvent): void {
  if (Date.now() < ignoreUntil) return;
  if (open.value && root.value && !root.value.contains(event.target as Node)) {
    open.value = false;
    query.value = '';
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    ignoreUntil = Date.now() + 50;
    document.addEventListener('pointerdown', onPointerDown, true);
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true);
  }
});

// Tests drive the open state directly, without a real pointer sequence.
defineExpose({ open });
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeydown">
    <button
      :id="id"
      type="button"
      class="field flex w-full items-center justify-between gap-2 text-left"
      :aria-expanded="open"
      :aria-label="label"
      :disabled="disabled"
      @click="toggle"
    >
      <span :class="selected ? 'text-ink' : 'text-ink-faint'" class="truncate">
        {{ selected?.label ?? placeholder ?? 'Choose…' }}
      </span>
      <ChevronDown
        :size="14"
        class="shrink-0 text-ink-faint transition-transform"
        :class="open ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <div
      v-if="open"
      class="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
    >
      <div class="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search :size="13" class="shrink-0 text-ink-faint" aria-hidden="true" />
        <input
          ref="searchBox"
          v-model="query"
          type="text"
          class="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          placeholder="Type to filter…"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <ul class="max-h-96 overflow-y-auto py-1" role="listbox">
        <li v-if="matching.length === 0" class="px-3 py-2 text-sm text-ink-faint">
          Nothing matches that.
        </li>

        <li v-for="option in visibleOptions" :key="option.value">
          <button
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm
                   transition-colors hover:bg-white/[0.04]"
            :class="option.value === modelValue ? 'text-brand-bright' : 'text-ink'"
            @click="choose(option.value)"
          >
            <span class="min-w-0">
              <span class="block truncate">{{ option.label }}</span>
              <span v-if="option.hint" class="block truncate text-xs text-ink-faint">
                {{ option.hint }}
              </span>
            </span>
            <Check
              v-if="option.value === modelValue"
              :size="14"
              class="shrink-0"
              aria-hidden="true"
            />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
