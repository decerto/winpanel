<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ServerCog } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';

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
const recoveryCode = ref('');
const usingRecoveryCode = ref(false);
const needsCode = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const httpsWarning = ref(false);

const canSubmit = computed(() => {
  if (username.value.trim().length === 0 || password.value.length === 0) return false;
  if (!needsCode.value) return true;
  return usingRecoveryCode.value
    ? recoveryCode.value.trim().length >= 8
    : code.value.trim().length === 6;
});

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

  const secondFactor = usingRecoveryCode.value
    ? { recoveryCode: recoveryCode.value.trim() }
    : { totp: code.value.trim() };

  try {
    await api.auth.login.mutate({
      username: username.value.trim(),
      password: password.value,
      ...(needsCode.value ? secondFactor : {}),
    });
    await router.push('/sites');
  } catch (err) {
    const message = describeError(err);

    // The server asks for the code only after the password checks out.
    if (/authenticator app/i.test(message)) {
      needsCode.value = true;
      error.value = null;
    } else {
      error.value = message;
      code.value = '';
      recoveryCode.value = '';
    }
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
        <h1 class="text-xl font-semibold tracking-tight text-ink">Sign in to WinPanel</h1>
        <p class="mt-1 text-sm text-ink-muted">Manage the websites on this server.</p>
      </div>

      <AlertMessage v-if="httpsWarning" tone="warning" class="mb-4">
        This connection is not encrypted. Anyone on the network between you and this server can
        read your password.
      </AlertMessage>

      <div class="card p-7">
        <form class="space-y-4" @submit.prevent="signIn">
          <div>
            <label for="username" class="label">Username</label>
            <input
              id="username"
              v-model="username"
              autocomplete="username"
              :disabled="needsCode"
              class="field"
            />
          </div>

          <div>
            <label for="password" class="label">Password</label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              :disabled="needsCode"
              class="field"
            />
          </div>

          <div v-if="needsCode">
            <label :for="usingRecoveryCode ? 'recovery-code' : 'code'" class="label">
              {{ usingRecoveryCode ? 'Recovery code' : 'Code from your authenticator app' }}
            </label>
            <input
              v-if="usingRecoveryCode"
              id="recovery-code"
              v-model="recoveryCode"
              autocomplete="off"
              spellcheck="false"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autofocus
              class="field text-center font-mono tracking-wider"
            />
            <input
              v-else
              id="code"
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              autofocus
              class="field text-center font-mono text-lg tracking-[0.4em]"
            />
            <button
              type="button"
              class="mt-2 text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
              @click="usingRecoveryCode = !usingRecoveryCode; error = null"
            >
              {{
                usingRecoveryCode
                  ? 'Use my authenticator app instead'
                  : 'I have lost my authenticator app'
              }}
            </button>
          </div>

          <AlertMessage v-if="error">{{ error }}</AlertMessage>

          <button
            type="submit"
            :disabled="!canSubmit || busy"
            class="btn btn-primary btn-lg w-full"
          >
            {{ busy ? 'Signing in\u2026' : 'Sign in' }}
          </button>
        </form>

        <RouterLink to="/forgot-password" class="mt-4 block text-center text-sm text-ink-faint underline">
          Forgot your password?
        </RouterLink>
      </div>
    </div>
  </div>
</template>
