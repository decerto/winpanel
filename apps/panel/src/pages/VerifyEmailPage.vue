<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ServerCog } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';

const route = useRoute();
const busy = ref(true);
const verified = ref(false);
const error = ref<string | null>(null);

async function verify(): Promise<void> {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  if (!token) {
    error.value = 'This verification link is missing or incomplete.';
    busy.value = false;
    return;
  }

  try {
    await api.auth.verifyEmail.mutate({ token });
    verified.value = true;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

void verify();
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
        <h1 class="text-xl font-semibold tracking-tight text-ink">Confirm your email</h1>
      </div>

      <div class="card p-7 text-center">
        <p v-if="busy" class="text-sm text-ink-muted">Checking the link...</p>
        <template v-else-if="verified">
          <AlertMessage tone="success">Your email address is verified.</AlertMessage>
          <p class="mt-4 text-sm text-ink-muted">You can use it for password recovery now.</p>
        </template>
        <AlertMessage v-else-if="error">{{ error }}</AlertMessage>

        <RouterLink to="/login" class="mt-5 inline-block text-sm text-ink-faint underline">
          Go to sign in
        </RouterLink>
      </div>
    </div>
  </div>
</template>
