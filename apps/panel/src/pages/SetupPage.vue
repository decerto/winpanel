<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { KeyRound, Lock, ShieldCheck } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';

/**
 * First run.
 *
 * There is deliberately no default password anywhere in this product. The
 * installer writes a one-time code to disk on the server; whoever can read it
 * already has console or remote-desktop access, and that is what authorises
 * creating the first account.
 *
 * Two-factor setup is part of this flow rather than an optional extra,
 * because the panel is reachable from the internet.
 */

const router = useRouter();

const step = ref<'account' | 'twoFactor'>('account');
const setupToken = ref('');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const code = ref('');

const totpUri = ref('');
const totpSecret = ref('');

const busy = ref(false);
const error = ref<string | null>(null);

const passwordProblem = computed(() => {
  if (password.value.length === 0) return null;
  if (password.value.length < 12) return 'Use at least 12 characters.';
  if (confirmPassword.value.length > 0 && password.value !== confirmPassword.value) {
    return 'The two passwords do not match.';
  }
  return null;
});

const canSubmitAccount = computed(
  () =>
    setupToken.value.trim().length > 0 &&
    username.value.trim().length >= 3 &&
    password.value.length >= 12 &&
    password.value === confirmPassword.value,
);

async function createAccount(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await api.auth.completeSetup.mutate({
      setupToken: setupToken.value.trim(),
      username: username.value.trim(),
      password: password.value,
    });

    totpUri.value = result.totpUri;
    totpSecret.value = result.totpSecret;
    step.value = 'twoFactor';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function confirmTwoFactor(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    await api.auth.confirmTotp.mutate({ code: code.value.trim() });
    await router.push('/health');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-[--color-surface-sunken] p-6">
    <div
      class="w-full max-w-md rounded-[--radius-card] border border-[--color-border]
             bg-[--color-surface] p-8"
    >
      <template v-if="step === 'account'">
        <div class="mb-6 text-center">
          <KeyRound :size="28" class="mx-auto mb-3 text-[--color-brand]" aria-hidden="true" />
          <h1 class="text-lg font-semibold text-[--color-text]">Set up your server</h1>
          <p class="mt-1 text-sm text-[--color-text-muted]">
            Enter the setup code shown by the installer, then choose how you will sign in.
          </p>
        </div>

        <form class="space-y-4" @submit.prevent="createAccount">
          <div>
            <label for="setup-code" class="mb-1 block text-sm font-medium text-[--color-text]">
              Setup code
            </label>
            <input
              id="setup-code"
              v-model="setupToken"
              autocomplete="off"
              spellcheck="false"
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 font-mono text-sm text-[--color-text]"
            />
            <p class="mt-1 text-xs text-[--color-text-muted]">
              Shown on the last page of the installer, and saved on the server.
            </p>
          </div>

          <div>
            <label for="username" class="mb-1 block text-sm font-medium text-[--color-text]">
              Username
            </label>
            <input
              id="username"
              v-model="username"
              autocomplete="username"
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-sm text-[--color-text]"
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
              autocomplete="new-password"
              class="w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-sm text-[--color-text]"
            />
            <input
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              placeholder="Confirm password"
              aria-label="Confirm password"
              class="mt-2 w-full rounded-md border border-[--color-border] bg-[--color-surface]
                     px-3 py-2 text-sm text-[--color-text]"
            />
            <p v-if="passwordProblem" class="mt-1 text-xs text-[--color-status-warn]">
              {{ passwordProblem }}
            </p>
            <p v-else class="mt-1 text-xs text-[--color-text-muted]">
              At least 12 characters. Length matters more than symbols.
            </p>
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
            :disabled="!canSubmitAccount || busy"
            class="w-full rounded-md bg-[--color-brand] px-4 py-2.5 text-sm font-medium text-white
                   hover:bg-[--color-brand-hover] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ busy ? 'Creating\u2026' : 'Continue' }}
          </button>
        </form>
      </template>

      <template v-else>
        <div class="mb-6 text-center">
          <ShieldCheck :size="28" class="mx-auto mb-3 text-[--color-brand]" aria-hidden="true" />
          <h1 class="text-lg font-semibold text-[--color-text]">Add a second step</h1>
          <p class="mt-1 text-sm text-[--color-text-muted]">
            This panel can be reached from the internet, so a password on its own is not
            enough. Scan this with your authenticator app.
          </p>
        </div>

        <div class="mb-4 rounded-md bg-[--color-surface-sunken] p-4">
          <p class="mb-2 text-xs text-[--color-text-muted]">
            Cannot scan? Enter this key manually:
          </p>
          <code class="block break-all font-mono text-xs text-[--color-text]">
            {{ totpSecret }}
          </code>
        </div>

        <form class="space-y-4" @submit.prevent="confirmTwoFactor">
          <div>
            <label for="code" class="mb-1 block text-sm font-medium text-[--color-text]">
              Six-digit code
            </label>
            <input
              id="code"
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
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
            :disabled="code.trim().length !== 6 || busy"
            class="w-full rounded-md bg-[--color-brand] px-4 py-2.5 text-sm font-medium text-white
                   hover:bg-[--color-brand-hover] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ busy ? 'Checking\u2026' : 'Finish setup' }}
          </button>
        </form>

        <p class="mt-4 flex items-start gap-2 text-xs text-[--color-text-muted]">
          <Lock :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
          Keep a copy of the key above somewhere safe. Without it, losing your phone means
          losing access to this panel.
        </p>
      </template>
    </div>
  </div>
</template>
