<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WrapText,
  X,
} from 'lucide-vue-next';

/**
 * A text editor with the two things a config file actually needs.
 *
 * Line numbers, because a game that refuses to start reports the line it
 * choked on and nothing else, and find and replace, because Project Zomboid's
 * settings file is a thousand lines long and the setting you want is one of
 * them. A five-row textarea makes both of those jobs into scrolling puzzles.
 *
 * No editor library: the whole feature is a gutter, a selection and a regular
 * expression, and shipping a megabyte of CodeMirror to get them would cost
 * every page in the panel its load time.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Shown in the status bar so the file being edited is never ambiguous. */
    filename?: string;
    readonly?: boolean;
    ariaLabel?: string;
  }>(),
  { filename: '', readonly: false, ariaLabel: 'File contents' },
);

const emit = defineEmits<{ 'update:modelValue': [string]; save: [] }>();

/** One rem-based row height, shared by the gutter and the text so they align. */
const LINE_HEIGHT = '1.35rem';

const textarea = ref<HTMLTextAreaElement | null>(null);
const gutter = ref<HTMLElement | null>(null);
const findInput = ref<HTMLInputElement | null>(null);

const scrollTop = ref(0);
const caret = ref(0);
const finding = ref(false);
const replacing = ref(false);
const query = ref('');
const replacement = ref('');
const caseSensitive = ref(false);
const useRegex = ref(false);
const wrap = ref(false);
const activeMatch = ref(0);
const searchError = ref<string | null>(null);
const gotoLine = ref('');

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
});

const lines = computed(() => content.value.split('\n'));
const lineCount = computed(() => lines.value.length);
const gutterText = computed(() => Array.from({ length: lineCount.value }, (_, i) => i + 1).join('\n'));
const gutterWidth = computed(() => `${Math.max(2, String(lineCount.value).length) + 1.6}ch`);

/** Where the caret is, counted the way an error message counts. */
const position = computed(() => {
  const before = content.value.slice(0, caret.value);
  const line = before.split('\n').length;
  const column = caret.value - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
});

const highlightOffset = computed(
  () => `calc(${LINE_HEIGHT} * ${position.value.line - 1} - ${scrollTop.value}px + 0.75rem)`,
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every hit for the current search, as offsets into the text. */
const matches = computed<Array<{ start: number; end: number }>>(() => {
  if (!finding.value || query.value === '') return [];

  let pattern: RegExp;
  try {
    pattern = new RegExp(
      useRegex.value ? query.value : escapeRegex(query.value),
      caseSensitive.value ? 'gm' : 'gim',
    );
  } catch {
    return [];
  }

  const found: Array<{ start: number; end: number }> = [];
  for (const match of content.value.matchAll(pattern)) {
    if (match.index === undefined) continue;
    // A pattern that can match nothing would otherwise loop forever over the
    // same offset and report thousands of hits for an empty search.
    if (match[0] === '') continue;
    found.push({ start: match.index, end: match.index + match[0].length });
    if (found.length >= 5000) break;
  }
  return found;
});

watch([query, useRegex, caseSensitive], () => {
  activeMatch.value = 0;
  searchError.value = null;
  if (useRegex.value && query.value !== '') {
    try {
      new RegExp(query.value);
    } catch {
      searchError.value = 'That is not a valid regular expression.';
    }
  }
});

function syncScroll(event: Event): void {
  const target = event.target as HTMLTextAreaElement;
  scrollTop.value = target.scrollTop;
  if (gutter.value) gutter.value.scrollTop = target.scrollTop;
}

function trackCaret(): void {
  caret.value = textarea.value?.selectionStart ?? 0;
}

/** Puts an offset on screen with a few lines of context above it. */
function revealOffset(start: number, end: number): void {
  const element = textarea.value;
  if (!element) return;
  element.focus();
  element.setSelectionRange(start, end);

  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 21;
  const line = content.value.slice(0, start).split('\n').length;
  const target = (line - 4) * lineHeight;
  const bottom = target + element.clientHeight;
  if (target < element.scrollTop || (line + 2) * lineHeight > bottom) {
    element.scrollTop = Math.max(0, target);
  }
  trackCaret();
}

function step(delta: number): void {
  if (matches.value.length === 0) return;
  const count = matches.value.length;
  activeMatch.value = (activeMatch.value + delta + count) % count;
  const hit = matches.value[activeMatch.value];
  if (hit) revealOffset(hit.start, hit.end);
}

function openFind(withReplace = false): void {
  finding.value = true;
  replacing.value = withReplace || replacing.value;
  const selected = textarea.value;
  if (selected && selected.selectionEnd > selected.selectionStart) {
    const chosen = content.value.slice(selected.selectionStart, selected.selectionEnd);
    if (!chosen.includes('\n')) query.value = chosen;
  }
  void nextTick(() => findInput.value?.select());
}

function closeFind(): void {
  finding.value = false;
  replacing.value = false;
  textarea.value?.focus();
}

/** Replaces the hit currently selected, then moves to the next one. */
function replaceCurrent(): void {
  if (props.readonly || matches.value.length === 0) return;
  const hit = matches.value[activeMatch.value] ?? matches.value[0];
  if (!hit) return;

  const before = content.value.slice(0, hit.start);
  const after = content.value.slice(hit.end);
  content.value = `${before}${replacement.value}${after}`;
  void nextTick(() => {
    if (matches.value.length === 0) return;
    activeMatch.value = Math.min(activeMatch.value, matches.value.length - 1);
    const next = matches.value[activeMatch.value];
    if (next) revealOffset(next.start, next.end);
  });
}

function replaceAll(): void {
  if (props.readonly || query.value === '' || matches.value.length === 0) return;
  const total = matches.value.length;
  // Applied back to front so an earlier replacement cannot shift the offsets
  // of the hits that have not been dealt with yet.
  let next = content.value;
  for (const hit of [...matches.value].reverse()) {
    next = `${next.slice(0, hit.start)}${replacement.value}${next.slice(hit.end)}`;
  }
  content.value = next;
  activeMatch.value = 0;
  searchError.value = `Replaced ${total} ${total === 1 ? 'match' : 'matches'}.`;
}

function jumpToLine(): void {
  const wanted = Number.parseInt(gotoLine.value, 10);
  if (!Number.isFinite(wanted) || wanted < 1) return;
  const line = Math.min(wanted, lineCount.value);
  const offset = lines.value.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  revealOffset(offset, offset + (lines.value[line - 1]?.length ?? 0));
  gotoLine.value = '';
}

/** Indents or outdents, so Tab does not leap out of the editor. */
function onTab(event: KeyboardEvent): void {
  const element = textarea.value;
  if (!element || props.readonly) return;
  event.preventDefault();

  const { selectionStart, selectionEnd } = element;
  const text = content.value;
  const spansLines = text.slice(selectionStart, selectionEnd).includes('\n');

  if (!spansLines && !event.shiftKey) {
    content.value = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
    void nextTick(() => element.setSelectionRange(selectionStart + 2, selectionStart + 2));
    return;
  }

  const from = text.lastIndexOf('\n', selectionStart - 1) + 1;
  const to = text.indexOf('\n', selectionEnd) === -1 ? text.length : text.indexOf('\n', selectionEnd);
  const block = text.slice(from, to);
  const shifted = block
    .split('\n')
    .map((line) => (event.shiftKey ? line.replace(/^ {1,2}/, '') : `  ${line}`))
    .join('\n');

  content.value = `${text.slice(0, from)}${shifted}${text.slice(to)}`;
  void nextTick(() => element.setSelectionRange(from, from + shifted.length));
}

function onKeydown(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey;

  if (event.key === 'Tab') {
    onTab(event);
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFind(false);
    return;
  }
  if (modifier && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    openFind(true);
    return;
  }
  if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    // Stopped here so a host that also listens for Ctrl+S does not save twice.
    event.stopPropagation();
    emit('save');
    return;
  }
  // Escape belongs to the search bar while it is open; only once it is shut
  // does it mean "leave the editor" to whatever is hosting this.
  if (event.key === 'Escape' && finding.value) {
    event.preventDefault();
    event.stopPropagation();
    closeFind();
  }
}

function onFindKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeFind();
  }
}

defineExpose({ focus: () => textarea.value?.focus(), openFind });
</script>

<template>
  <div class="flex min-h-0 flex-col" @keydown.capture="onKeydown">
    <div class="flex flex-wrap items-center gap-2 pb-2">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :class="finding ? 'text-brand-bright' : ''"
        @click="finding ? closeFind() : openFind(false)"
      >
        <Search :size="14" aria-hidden="true" /> Find
      </button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="readonly" @click="openFind(true)">
        <Replace :size="14" aria-hidden="true" /> Replace
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :class="wrap ? 'text-brand-bright' : ''"
        :aria-pressed="wrap"
        title="Wrap long lines. Line numbers are hidden while wrapping, because a wrapped line covers several rows."
        @click="wrap = !wrap"
      >
        <WrapText :size="14" aria-hidden="true" /> Wrap
      </button>
      <form class="ml-auto flex items-center gap-1.5" @submit.prevent="jumpToLine">
        <label class="text-xs text-ink-faint" for="code-editor-goto">Go to line</label>
        <input
          id="code-editor-goto"
          v-model="gotoLine"
          class="field !w-20 !py-1 text-center font-mono text-xs"
          inputmode="numeric"
          placeholder="1"
        />
      </form>
    </div>

    <div v-if="finding" class="mb-2 rounded-lg border border-line bg-elevated/50 p-2">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            ref="findInput"
            v-model="query"
            class="field !py-1 font-mono text-xs"
            placeholder="Find"
            spellcheck="false"
            aria-label="Find"
            @keydown="onFindKeydown"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm !px-2"
            :class="caseSensitive ? 'text-brand-bright' : 'text-ink-faint'"
            :aria-pressed="caseSensitive"
            title="Match case"
            @click="caseSensitive = !caseSensitive"
          >
            <CaseSensitive :size="15" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm !px-2"
            :class="useRegex ? 'text-brand-bright' : 'text-ink-faint'"
            :aria-pressed="useRegex"
            title="Use a regular expression"
            @click="useRegex = !useRegex"
          >
            <Regex :size="15" aria-hidden="true" />
          </button>
        </div>
        <span class="min-w-24 text-right font-mono text-xs text-ink-faint">
          {{ matches.length === 0 ? (query ? 'No matches' : '') : `${activeMatch + 1} of ${matches.length}` }}
        </span>
        <button type="button" class="btn btn-ghost btn-sm !px-2" :disabled="matches.length === 0" title="Previous match" @click="step(-1)">
          <ArrowUp :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-ghost btn-sm !px-2" :disabled="matches.length === 0" title="Next match" @click="step(1)">
          <ArrowDown :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-ghost btn-sm !px-2" aria-label="Close find" @click="closeFind">
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <div v-if="replacing" class="mt-2 flex flex-wrap items-center gap-2">
        <input
          v-model="replacement"
          class="field !py-1 flex-1 font-mono text-xs"
          placeholder="Replace with"
          spellcheck="false"
          aria-label="Replace with"
          :disabled="readonly"
          @keydown.enter.prevent="replaceCurrent"
        />
        <button type="button" class="btn btn-ghost btn-sm" :disabled="readonly || matches.length === 0" @click="replaceCurrent">
          <Replace :size="14" aria-hidden="true" /> Replace
        </button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="readonly || matches.length === 0" @click="replaceAll">
          <ReplaceAll :size="14" aria-hidden="true" /> All
        </button>
      </div>

      <p v-if="searchError" class="mt-2 text-xs text-ink-muted">{{ searchError }}</p>
    </div>

    <div class="relative flex min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-black/30">
      <div
        v-if="!wrap"
        ref="gutter"
        class="shrink-0 select-none overflow-hidden border-r border-line bg-black/20 py-3 pr-2 text-right font-mono text-xs text-ink-faint"
        :style="{ width: gutterWidth, lineHeight: LINE_HEIGHT }"
        aria-hidden="true"
      ><pre class="m-0 font-mono" :style="{ lineHeight: LINE_HEIGHT }">{{ gutterText }}</pre></div>

      <div
        v-if="!wrap"
        class="pointer-events-none absolute left-0 h-[1.35rem] w-full bg-brand/[0.07]"
        :style="{ top: highlightOffset }"
        aria-hidden="true"
      />

      <textarea
        ref="textarea"
        v-model="content"
        class="min-h-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-xs text-ink outline-none"
        :class="wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'"
        :style="{ lineHeight: LINE_HEIGHT }"
        :readonly="readonly"
        :aria-label="ariaLabel"
        :wrap="wrap ? 'soft' : 'off'"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        @scroll="syncScroll"
        @keyup="trackCaret"
        @click="trackCaret"
        @select="trackCaret"
      />
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 font-mono text-[0.7rem] text-ink-faint">
      <span v-if="filename" class="truncate text-ink-muted">{{ filename }}</span>
      <span>Ln {{ position.line }}, Col {{ position.column }}</span>
      <span>{{ lineCount }} {{ lineCount === 1 ? 'line' : 'lines' }}</span>
      <span class="ml-auto">Ctrl+F find · Ctrl+H replace · Ctrl+S save</span>
    </div>
  </div>
</template>
