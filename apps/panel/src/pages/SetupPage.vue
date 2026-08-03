<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { KeyRound, ShieldCheck } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import TotpEnrolment from '../components/TotpEnrolment.vue';
import RecoveryCodes from '../components/RecoveryCodes.vue';
import AlertMessage from '../components/AlertMessage.vue';

/**
 * First run.
 *
 * There is deliberately no default password anywhere in this product. The
 * installer writes a one-time code to disk on the server; whoever can read it
 * already has console or remote-desktop access, and that is what authorises
 * creating the first account.
 *
 * Two-factor setup is offered here rather than forced. It is the right moment
 * to ask, and the recommendation is stated plainly, but a panel nobody can get
 * into because enrolment was abandoned halfway is worse than one protected by
 * a strong password alone. It can be turned on later from Security.
 */

const router = useRouter();

const step = ref<'account' | 'offerTwoFactor' | 'enrolTwoFactor' | 'recoveryCodes'>('account');
const setupToken = ref('');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');

const totpUri = ref('');
const totpSecret = ref('');
const recoveryCodes = ref<string[]>([]);

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
    await api.auth.completeSetup.mutate({
      setupToken: setupToken.value.trim(),
      username: username.value.trim(),
      password: password.value,
    });
    step.value = 'offerTwoFactor';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function startTwoFactor(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    // The password is still in memory from the form above, so enrolment does
    // not have to ask for it again the moment after it was chosen.
    const result = await api.auth.beginTotp.mutate({ password: password.value });
    totpUri.value = result.uri;
    totpSecret.value = result.secret;
    step.value = 'enrolTwoFactor';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function confirmTwoFactor(code: string): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await api.auth.confirmTotp.mutate({ code });
    recoveryCodes.value = result.recoveryCodes;
    step.value = 'recoveryCodes';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/** Leaves setup without two factors. */
async function finish(): Promise<void> {
  // An enrolment that was started and walked away from would otherwise sit in
  // the database unconfirmed, and reappear as a half-finished state later.
  await api.auth.cancelTotp.mutate().catch(() => undefined);
  await router.push('/sites');
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-md">
      <div class="mb-7 flex flex-col items-center text-center">
        <span
          class="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-b
                 from-brand to-brand-strong shadow-brand"
        >
          <component
            :is="step === 'account' ? KeyRound : ShieldCheck"
            :size="24"
            class="text-white"
            aria-hidden="true"
          />
        </span>

        <h1 class="text-xl font-semibold tracking-tight text-ink">
          <template v-if="step === 'account'">Set up your server</template>
          <template v-else-if="step === 'recoveryCodes'">Save your recovery codes</template>
          <template v-else>Add a second step</template>
        </h1>

        <p class="mt-1 max-w-sm text-sm text-ink-muted">
          <template v-if="step === 'account'">
            Enter the setup code shown by the installer, then choose how you will sign in.
          </template>
          <template v-else-if="step === 'offerTwoFactor'">
            Your account is ready. Before you finish, consider protecting it with an
            authenticator app.
          </template>
          <template v-else-if="step === 'enrolTwoFactor'">
            Scan this with your authenticator app, then enter the code it shows.
          </template>
          <template v-else>
            Two-factor is on. These get you back in if you lose your phone.
          </template>
        </p>
      </div>

      <div class="card p-7">
        <template v-if="step === 'account'">
          <form class="space-y-4" @submit.prevent="createAccount">
            <div>
              <label for="setup-code" class="label">Setup code</label>
              <input
                id="setup-code"
                v-model="setupToken"
                autocomplete="off"
                spellcheck="false"
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                class="field font-mono"
              />
              <p class="hint">Shown on the last page of the installer, and saved on the server.</p>
            </div>

            <div>
              <label for="username" class="label">Username</label>
              <input id="username" v-model="username" autocomplete="username" class="field" />
            </div>

            <div>
              <label for="password" class="label">Password</label>
              <input
                id="password"
                v-model="password"
                type="password"
                autocomplete="new-password"
                class="field"
              />
              <input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                placeholder="Confirm password"
                aria-label="Confirm password"
                class="field mt-2"
              />
              <p v-if="passwordProblem" class="mt-1.5 text-xs text-warn">{{ passwordProblem }}</p>
              <p v-else class="hint">At least 12 characters. Length matters more than symbols.</p>
            </div>

            <AlertMessage v-if="error">{{ error }}</AlertMessage>

            <button
              type="submit"
              :disabled="!canSubmitAccount || busy"
              class="btn btn-primary btn-lg w-full"
            >
              {{ busy ? 'Creating\u2026' : 'Continue' }}
            </button>
          </form>
        </template>

        <template v-else-if="step === 'offerTwoFactor'">
          <AlertMessage tone="warning" class="mb-4">
            Recommended. This panel is reachable from the internet and controls every website and
            mailbox on this server, so anyone who learns your password gets all of it. A second
            step means a stolen password on its own is not enough.
          </AlertMessage>

          <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

          <div class="space-y-2">
            <button
              type="button"
              :disabled="busy"
              class="btn btn-primary btn-lg w-full"
              @click="startTwoFactor"
            >
              {{ busy ? 'Preparing\u2026' : 'Set up two-factor authentication' }}
            </button>
            <button
              type="button"
              :disabled="busy"
              class="btn btn-ghost btn-lg w-full"
              @click="finish"
            >
              Skip for now
            </button>
          </div>

          <p class="mt-4 text-center text-xs text-ink-faint">
            You can turn this on at any time from Security.
          </p>
        </template>

        <TotpEnrolment
          v-else-if="step === 'enrolTwoFactor'"
          :uri="totpUri"
          :secret="totpSecret"
          :busy="busy"
          :error="error"
          confirm-label="Turn on two-factor"
          cancel-label="Skip"
          @confirm="confirmTwoFactor"
          @cancel="finish"
        />

        <RecoveryCodes
          v-else
          :codes="recoveryCodes"
          done-label="Finish setup"
          @done="router.push('/sites')"
        />
      </div>
    </div>
  </div>
</template>
