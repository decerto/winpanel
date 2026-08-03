<script setup lang="ts">
import { ref } from 'vue';
import { Lock } from 'lucide-vue-next';
import QrCode from './QrCode.vue';
import AlertMessage from './AlertMessage.vue';

/**
 * The scan-and-confirm half of two-factor enrolment.
 *
 * Shared by first-run setup and the Security page so there is one enrolment
 * experience: the same wording, the same manual-entry fallback, and the same
 * warning to keep the key. Enrolment is only ever finished by typing a code
 * back, which is what proves the authenticator app actually works before
 * anyone depends on it to sign in.
 */

defineProps<{
  uri: string;
  secret: string;
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
}>();

const emit = defineEmits<{ confirm: [code: string]; cancel: [] }>();

const code = ref('');
</script>

<template>
  <div>
    <div class="mb-4 flex justify-center">
      <div class="rounded-xl bg-white p-3 shadow-pop">
        <QrCode :value="uri" :size="192" label="Two-factor setup QR code" />
      </div>
    </div>

    <div class="mb-4 rounded-lg border border-line bg-black/20 p-4">
      <p class="mb-1.5 text-xs text-ink-faint">Cannot scan? Enter this key manually:</p>
      <code class="block break-all font-mono text-xs text-ink">{{ secret }}</code>
    </div>

    <form class="space-y-4" @submit.prevent="emit('confirm', code.trim())">
      <div>
        <label for="totp-code" class="label">Six-digit code</label>
        <input
          id="totp-code"
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="000000"
          class="field text-center font-mono text-lg tracking-[0.4em]"
        />
      </div>

      <AlertMessage v-if="error">{{ error }}</AlertMessage>

      <div class="flex gap-2">
        <button
          v-if="cancelLabel"
          type="button"
          class="btn btn-ghost btn-lg"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="submit"
          :disabled="code.trim().length !== 6 || busy"
          class="btn btn-primary btn-lg flex-1"
        >
          {{ busy ? 'Checking\u2026' : (confirmLabel ?? 'Turn on two-factor') }}
        </button>
      </div>
    </form>

    <p class="mt-4 flex items-start gap-2 text-xs text-ink-faint">
      <Lock :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
      Keep a copy of the key above somewhere safe. Without it, losing your phone means losing
      access to this panel.
    </p>
  </div>
</template>
