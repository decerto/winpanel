<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { LogIn, TriangleAlert } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';

/**
 * Sign in.
 *
 * The two-factor field only appears once the server says it is needed, so the
 * first screen stays as simple as possible. Error text is deliberately vague
 * about which half was wrong — telling someone the username was right is a
 * free hint for anyone guessing.
 */

const router = useRouter();

const username = ref('');
const password = ref('');
const code = ref('');
const needsCode = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const httpsWarning = ref(false);

const canSubmit = computed(
  () =>
    username.value.trim().length > 0 &&
    password.value.length > 0 &&
    (!needsCode.value || code.value.trim().length === 6),
);

// Surfaced permanently when the panel is served without encryption, because
// the password and session cookie then cross the network in the clear.
void (async () => {
  try {
    const state = await api.auth.state.query();
    httpsWarning.value = !state.httpsEnabled;
  } catch {
    // The banner is a nicety; failing to fetch it must not block sign-in.
  }
})();

async function signIn(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    await api.auth.login.mutate({
      username: username.value.trim(),
      password: password.value,
      ...(needsCode.value ? { totp: code.value.trim() } : {}),
    });
    await router.push('/health');
  } catch (err) {
    const message = describeError(err);

    // The server asks for the code only after the password checks out.
    if (/authenticator app/i.test(message)) {
      needsCode.value = true;
      error.value = null;
    } else {
      error.value = message;
      code.value = '';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-[--color-surface-sunken] p-6">
    <div class="w-full max-w-sm">
      <div
        v-if="httpsWarning"
        class="mb-4 flex items-start gap-2 rounded-md bg-[--color-status-warn-bg] px-3 py-2
               text-xs text-[--color-status-warn]"
      >
        <TriangleAlert :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          This connection is not encrypted. Anyone on the network between you and this
          server can read your password.
        </span>
      </div>

      <div
        class="rounded-[--radius-card] border border-[--color-border] bg-[--color-surface] p-8"
      >
        <div class="mb-6 text-center">
          <LogIn :size="26" class="mx-auto mb-3 text-[--color-brand]" aria-hidden="true" />
          <h1 class="text-lg font-semibold text-[--color-text]">Sign in</h1>
        </div>

        <form class="space-y-4" @submit.prevent="signIn">
          <div>
            <label for="username" class="mb-1 block text-sm font-medium text-[--color-text]">
              Username
            </label>
            <input
              id="username"
              v-model="username"
              autocomplete="username"
              :disabled="needsCode"
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-sm text-[--color-text] disabled:opacity-60"
            />
          </div>

          <div>
            <label for="password" class="mb-1 block text-sm font-medium text-[--color-text]">
              Password
            </label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              :disabled="needsCode"
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-sm text-[--color-text] disabled:opacity-60"
            />
          </div>

          <div v-if="needsCode">
            <label for="code" class="mb-1 block text-sm font-medium text-[--color-text]">
              Code from your authenticator app
            </label>
            <input
              id="code"
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              autofocus
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-center font-mono text-lg tracking-widest text-[--color-text]"
            />
          </div>

          <p
            v-if="error"
            class="rounded-md bg-[--color-status-blocked-bg] px-3 py-2 text-sm
                   text-[--color-status-blocked]"
          >
            {{ error }}
          </p>

          <button
            type="submit"
            :disabled="!canSubmit || busy"
            class="w-full rounded-md bg-[--color-brand] px-4 py-2.5 text-sm font-medium text-white
                   hover:bg-[--color-brand-hover] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ busy ? 'Signing in\u2026' : 'Sign in' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
