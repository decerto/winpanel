<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ServerCog } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';

const email = ref('');
const busy = ref(false);
const notice = ref<string | null>(null);
const error = ref<string | null>(null);

async function requestReset(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.auth.requestPasswordReset.mutate({ email: email.value.trim() });
    notice.value =
      'If a verified account uses that address, a password reset link is on its way.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-sm">
      <div class="mb-7 flex flex-col items-center text-center">
        <span
          class="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-b
                 from-brand to-brand-strong shadow-brand"
        >
          <ServerCog :size="24" class="text-white" aria-hidden="true" />
        </span>
        <h1 class="text-xl font-semibold tracking-tight text-ink">Reset your password</h1>
        <p class="mt-1 text-sm text-ink-muted">Use the verified email on your account.</p>
      </div>

      <div class="card p-7">
        <form class="space-y-4" @submit.prevent="requestReset">
          <div>
            <label for="reset-email" class="label">Email address</label>
            <input
              id="reset-email"
              v-model="email"
              class="field"
              type="email"
              autocomplete="email"
              autofocus
              required
            />
          </div>

          <AlertMessage v-if="error">{{ error }}</AlertMessage>
          <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

          <button type="submit" class="btn btn-primary btn-lg w-full" :disabled="busy">
            {{ busy ? 'Sending...' : 'Email me a reset link' }}
          </button>
        </form>

        <RouterLink to="/login" class="mt-4 block text-center text-sm text-ink-faint underline">
          Back to sign in
        </RouterLink>
      </div>
    </div>
  </div>
</template>
