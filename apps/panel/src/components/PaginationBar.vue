<script setup lang="ts">
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';

/**
 * Paging for anything that can grow without limit.
 *
 * A server with two hundred websites should not hand the browser two hundred
 * cards, and a person looking for one of them should not have to scroll past
 * the other hundred and ninety-nine.
 */

const props = defineProps<{
  page: number;
  total: number;
  pageSize: number;
  /** What is being counted, for the summary line. */
  noun: string;
}>();

const emit = defineEmits<{ 'update:page': [page: number] }>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const first = computed(() => (props.page - 1) * props.pageSize + 1);
const last = computed(() => Math.min(props.page * props.pageSize, props.total));

/**
 * Page numbers to show: always the first and last, always the neighbours of
 * the current one, and a gap for everything else.
 */
const pages = computed<Array<number | 'gap'>>(() => {
  const count = pageCount.value;
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);

  const around = [props.page - 1, props.page, props.page + 1].filter(
    (candidate) => candidate > 1 && candidate < count,
  );

  const result: Array<number | 'gap'> = [1];
  if ((around[0] ?? 2) > 2) result.push('gap');
  result.push(...around);
  if ((around.at(-1) ?? count - 1) < count - 1) result.push('gap');
  result.push(count);

  return result;
});

function go(page: number): void {
  emit('update:page', Math.min(pageCount.value, Math.max(1, page)));
}
</script>

<template>
  <nav
    v-if="total > pageSize"
    class="mt-5 flex flex-wrap items-center justify-between gap-3"
    aria-label="Pagination"
  >
    <p class="text-xs text-ink-faint">
      Showing {{ first }}&ndash;{{ last }} of {{ total }} {{ noun }}
    </p>

    <div class="flex items-center gap-1">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="page <= 1"
        aria-label="Previous page"
        @click="go(page - 1)"
      >
        <ChevronLeft :size="15" />
      </button>

      <template v-for="(entry, index) in pages" :key="`${entry}-${index}`">
        <span v-if="entry === 'gap'" class="px-1 text-xs text-ink-faint" aria-hidden="true">
          &hellip;
        </span>
        <button
          v-else
          type="button"
          class="btn btn-sm min-w-9"
          :class="entry === page ? 'btn-primary' : 'btn-ghost'"
          :aria-current="entry === page ? 'page' : undefined"
          :aria-label="`Page ${entry}`"
          @click="go(entry)"
        >
          {{ entry }}
        </button>
      </template>

      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="page >= pageCount"
        aria-label="Next page"
        @click="go(page + 1)"
      >
        <ChevronRight :size="15" />
      </button>
    </div>
  </nav>
</template>
