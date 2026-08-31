<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ServerCog } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';

const route = useRoute();
const router = useRouter();
const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''));
const password = ref('');
const confirmation = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const problem = computed(() => {
  if (password.value.length > 0 && password.value.length < 12) return 'Use at least 12 characters.';
  if (confirmation.value && password.value !== confirmation.value) return 'The passwords do not match.';
  return null;
});

async function resetPassword(): Promise<void> {
  if (!token.value || problem.value || password.value.length < 12) return;
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.auth.resetPassword.mutate({ token: token.value, password: password.value });
    notice.value = 'Your password has been changed. You can sign in with it now.';
    password.value = '';
    confirmation.value = '';
    setTimeout(() => void router.push('/login'), 1200);
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
        <h1 class="text-xl font-semibold tracking-tight text-ink">Choose a new password</h1>
        <p class="mt-1 text-sm text-ink-muted">This reset link can be used once.</p>
      </div>

      <div class="card p-7">
        <form class="space-y-4" @submit.prevent="resetPassword">
          <div>
            <label for="new-password" class="label">New password</label>
            <input
              id="new-password"
              v-model="password"
              class="field"
              type="password"
              autocomplete="new-password"
              autofocus
              :disabled="!token"
              required
            />
            <input
              v-model="confirmation"
              class="field mt-2"
              type="password"
              autocomplete="new-password"
              placeholder="Confirm new password"
              aria-label="Confirm new password"
              :disabled="!token"
              required
            />
            <p v-if="problem" class="mt-1.5 text-xs text-warn">{{ problem }}</p>
            <p v-else class="hint">At least 12 characters. Length matters more than symbols.</p>
          </div>

          <AlertMessage v-if="!token">This reset link is missing or incomplete.</AlertMessage>
          <AlertMessage v-if="error">{{ error }}</AlertMessage>
          <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

          <button
            type="submit"
            class="btn btn-primary btn-lg w-full"
            :disabled="busy || !token || Boolean(problem)"
          >
            {{ busy ? 'Changing...' : 'Set new password' }}
          </button>
        </form>

        <RouterLink to="/login" class="mt-4 block text-center text-sm text-ink-faint underline">
          Back to sign in
        </RouterLink>
      </div>
    </div>
  </div>
</template>
