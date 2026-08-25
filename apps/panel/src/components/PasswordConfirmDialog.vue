<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { KeyRound, X } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    busy?: boolean;
    error?: string | null;
  }>(),
  { confirmLabel: 'Confirm', busy: false, error: null },
);
const emit = defineEmits<{ close: []; confirm: [password: string] }>();

const password = ref('');
const passwordInput = ref<HTMLInputElement | null>(null);

function close(): void {
  if (!props.busy) emit('close');
}

function submit(): void {
  if (props.busy || password.value.length === 0) return;
  const value = password.value;
  password.value = '';
  emit('confirm', value);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      window.removeEventListener('keydown', onKeydown);
      password.value = '';
      return;
    }

    window.addEventListener('keydown', onKeydown);
    password.value = '';
    void nextTick(() => passwordInput.value?.focus());
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
      aria-labelledby="password-confirm-title"
      aria-describedby="password-confirm-description"
      @submit.prevent="submit"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-danger/30 bg-danger-soft/60 text-danger"
          aria-hidden="true"
        >
          <KeyRound :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 id="password-confirm-title" class="text-base font-semibold text-ink">{{ title }}</h2>
          <p id="password-confirm-description" class="mt-1 text-sm leading-relaxed text-ink-muted">
            {{ description }}
          </p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" :disabled="busy" @click="close">
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <div class="mt-5">
        <label for="destructive-confirm-password" class="label">Your account password</label>
        <input
          id="destructive-confirm-password"
          ref="passwordInput"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="field mt-1"
          :disabled="busy"
        />
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>

      <div class="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">Cancel</button>
        <button type="submit" class="btn btn-danger" :disabled="busy || password.length === 0">
          {{ busy ? 'Checking...' : confirmLabel }}
        </button>
      </div>
    </form>
  </div>
</template>
