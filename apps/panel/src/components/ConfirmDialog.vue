<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { KeyRound, X } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    busyLabel?: string;
    busy?: boolean;
    error?: string | null;
  }>(),
  {
    confirmLabel: 'Confirm',
    busyLabel: 'Confirming...',
    busy: false,
    error: null,
  },
);
const emit = defineEmits<{ close: []; confirm: [] }>();

const confirmButton = ref<HTMLButtonElement | null>(null);

function close(): void {
  if (!props.busy) emit('close');
}

function submit(): void {
  if (props.busy) return;
  emit('confirm');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      window.removeEventListener('keydown', onKeydown);
      return;
    }

    window.addEventListener('keydown', onKeydown);
    void nextTick(() => confirmButton.value?.focus());
  },
  { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    @click.self="close"
  >
    <form
      class="card w-full max-w-md p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      @submit.prevent="submit"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft/60 text-brand-bright"
          aria-hidden="true"
        >
          <KeyRound :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 id="confirm-dialog-title" class="text-base font-semibold text-ink">{{ title }}</h2>
          <p id="confirm-dialog-description" class="mt-1 text-sm leading-relaxed text-ink-muted">
            {{ description }}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Close"
          :disabled="busy"
          @click="close"
        >
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <p class="mt-4 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5 text-sm text-ink-muted">
        The current password will stop working as soon as you confirm.
      </p>

      <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>

      <div class="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">
          Cancel
        </button>
        <button
          ref="confirmButton"
          type="submit"
          class="btn btn-primary"
          :disabled="busy"
          :aria-busy="busy"
        >
          {{ busy ? busyLabel : confirmLabel }}
        </button>
      </div>
    </form>
  </div>
</template>