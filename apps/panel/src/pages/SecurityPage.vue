<script setup lang="ts">
import { computed, ref } from 'vue';
import { KeyRound, Mail, ShieldCheck, ShieldOff } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import TotpEnrolment from '../components/TotpEnrolment.vue';
import RecoveryCodes from '../components/RecoveryCodes.vue';
import AlertMessage from '../components/AlertMessage.vue';
import PageHeader from '../components/PageHeader.vue';

/**
 * Account security.
 *
 * Two-factor authentication is optional, so this page has to make its absence
 * visible rather than quietly accepting it — an internet-facing panel guarded
 * by a password alone is a real risk, and the owner should be reminded every
 * time they look.
 *
 * Every change here re-asks for the password, and anything that weakens the
 * account also asks for a current code. A session cookie on its own is never
 * enough to alter how the account is protected.
 */

type Mode = 'idle' | 'enrolling' | 'disabling' | 'regenerating';
type AccountProfile = Awaited<ReturnType<typeof api.auth.profile.query>>;

const enrolled = ref(false);
const role = ref<'superadmin' | 'admin' | 'user'>('user');
const loading = ref(true);
const mode = ref<Mode>('idle');

const password = ref('');
const currentCode = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const totpUri = ref('');
const totpSecret = ref('');
const codes = ref<string[]>([]);
const codeStatus = ref<{ remaining: number; total: number }>({ remaining: 0, total: 0 });

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordBusy = ref(false);
const passwordError = ref<string | null>(null);
const passwordNotice = ref<string | null>(null);

const profile = ref<AccountProfile | null>(null);
const accountEmail = ref('');
const savedAccountEmail = ref('');
const outageNotifications = ref(false);
const profilePassword = ref('');
const profileBusy = ref(false);
const profileError = ref<string | null>(null);
const profileNotice = ref<string | null>(null);

const canStart = computed(
  () => password.value.length > 0 && (!enrolled.value || currentCode.value.trim().length === 6),
);

const needsBothFactors = computed(
  () => mode.value === 'disabling' || mode.value === 'regenerating',
);

const canSubmitStepUp = computed(() =>
  needsBothFactors.value
    ? password.value.length > 0 && currentCode.value.trim().length === 6
    : canStart.value,
);

const passwordProblem = computed(() => {
  if (newPassword.value.length === 0) return null;
  if (newPassword.value.length < 12) return 'Use at least 12 characters.';
  if (confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value) {
    return 'The two passwords do not match.';
  }
  return null;
});

const canChangePassword = computed(
  () =>
    currentPassword.value.length > 0 &&
    newPassword.value.length >= 12 &&
    newPassword.value === confirmPassword.value,
);

const accountEmailChanged = computed(() => accountEmail.value.trim().toLowerCase() !== savedAccountEmail.value);
const canSaveProfile = computed(
  () => !accountEmailChanged.value || profilePassword.value.length > 0,
);

async function refresh(): Promise<void> {
  try {
    const user = await api.auth.me.query();
    const account = await api.auth.profile.query();
    role.value = user?.role ?? 'user';
    enrolled.value = user?.totpEnrolled ?? false;
    profile.value = account;
    accountEmail.value = account.email ?? '';
    savedAccountEmail.value = account.email ?? '';
    outageNotifications.value = account.outageNotifications;
    codeStatus.value = enrolled.value
      ? await api.auth.recoveryCodeStatus.query()
      : { remaining: 0, total: 0 };
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function saveProfile(): Promise<void> {
  profileBusy.value = true;
  profileError.value = null;
  profileNotice.value = null;

  try {
    const result = await api.auth.updateProfile.mutate({
      email: accountEmail.value.trim() || null,
      outageNotifications: outageNotifications.value,
      ...(accountEmailChanged.value ? { currentPassword: profilePassword.value } : {}),
    });
    profile.value = result.profile;
    accountEmail.value = result.profile.email ?? '';
    savedAccountEmail.value = result.profile.email ?? '';
    profilePassword.value = '';
    profileNotice.value = result.verificationSent
      ? 'A verification link is on its way. Password recovery stays off until you confirm it.'
      : result.profile.email && !result.profile.emailVerified
        ? 'Saved. Configure panel email or resend the verification message when delivery is ready.'
        : 'Account settings saved.';
  } catch (err) {
    profileError.value = describeError(err);
  } finally {
    profileBusy.value = false;
  }
}

async function resendVerification(): Promise<void> {
  profileBusy.value = true;
  profileError.value = null;
  profileNotice.value = null;

  try {
    const result = await api.auth.resendEmailVerification.mutate();
    profileNotice.value = result.sent
      ? 'A new verification link is on its way.'
      : 'There is no unverified account email to send.';
  } catch (err) {
    profileError.value = describeError(err);
  } finally {
    profileBusy.value = false;
  }
}

void refresh();

function reset(): void {
  mode.value = 'idle';
  password.value = '';
  currentCode.value = '';
  totpUri.value = '';
  totpSecret.value = '';
  codes.value = [];
  error.value = null;
  notice.value = null;
}

async function beginEnrolment(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.auth.beginTotp.mutate({
      password: password.value,
      ...(enrolled.value ? { currentCode: currentCode.value.trim() } : {}),
    });
    totpUri.value = result.uri;
    totpSecret.value = result.secret;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function confirmEnrolment(code: string): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await api.auth.confirmTotp.mutate({ code });
    // Straight to the codes: they are readable exactly once.
    totpUri.value = '';
    codes.value = result.recoveryCodes;
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function cancelEnrolment(): Promise<void> {
  await api.auth.cancelTotp.mutate().catch(() => undefined);
  reset();
}

async function regenerate(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.auth.regenerateRecoveryCodes.mutate({
      password: password.value,
      code: currentCode.value.trim(),
    });
    codes.value = result.recoveryCodes;
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function disable(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.auth.disableTotp.mutate({
      password: password.value,
      code: currentCode.value.trim(),
    });
    reset();
    notice.value =
      'Two-factor authentication is off. Your password is now the only thing protecting '
      + 'this panel.';
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function changePassword(): Promise<void> {
  passwordBusy.value = true;
  passwordError.value = null;
  passwordNotice.value = null;

  try {
    await api.auth.changePassword.mutate({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    passwordNotice.value =
      'Password changed. Any other browser signed in to this panel has been signed out.';
  } catch (err) {
    passwordError.value = describeError(err);
  } finally {
    passwordBusy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl">
    <PageHeader
      title="Security"
      description="How this panel decides it is really you. Every change here re-asks for your
                   password, and anything that weakens the account also asks for a code."
    />

    <section class="card mb-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
                 bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Mail :size="19" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Account email</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Used for password recovery and account security messages. It is never shown to other
            customers.
          </p>
        </div>
      </div>

      <form class="mt-5 max-w-xl space-y-4" @submit.prevent="saveProfile">
        <div>
          <label for="account-email" class="label">Email address</label>
          <input
            id="account-email"
            v-model="accountEmail"
            class="field"
            type="email"
            autocomplete="email"
            spellcheck="false"
            placeholder="you@example.com"
          />
          <p v-if="profile?.emailVerified" class="mt-1.5 text-xs text-ok">Verified</p>
          <p v-else-if="accountEmail" class="mt-1.5 text-xs text-warn">
            Not verified. Password recovery is unavailable until this address is confirmed.
          </p>
        </div>

        <label v-if="role === 'user'" class="flex items-start gap-2 text-sm text-ink-muted">
          <input v-model="outageNotifications" type="checkbox" class="mt-0.5" />
          <span>Send me an email when one of my websites goes down or comes back.</span>
        </label>

        <div v-if="accountEmailChanged" class="max-w-sm">
          <label for="profile-password" class="label">Current password</label>
          <input
            id="profile-password"
            v-model="profilePassword"
            class="field"
            type="password"
            autocomplete="current-password"
            placeholder="Required to change the address"
          />
        </div>

        <AlertMessage v-if="profileError">{{ profileError }}</AlertMessage>
        <AlertMessage v-if="profileNotice" tone="success">{{ profileNotice }}</AlertMessage>

        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-primary" :disabled="profileBusy || !canSaveProfile">
            {{ profileBusy ? 'Saving...' : 'Save account settings' }}
          </button>
          <button
            v-if="accountEmail && profile && !profile.emailVerified"
            type="button"
            class="btn btn-ghost"
            :disabled="profileBusy"
            @click="resendVerification"
          >
            Resend verification
          </button>
        </div>
      </form>
    </section>

    <section class="card p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line"
          :class="enrolled ? 'bg-ok-soft/50 text-ok' : 'bg-warn-soft/50 text-warn'"
          aria-hidden="true"
        >
          <component :is="enrolled ? ShieldCheck : ShieldOff" :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Two-factor authentication</h2>
          <p v-if="loading" class="mt-1 text-sm text-ink-muted">Checking…</p>
          <p v-else-if="enrolled" class="mt-1 text-sm text-ink-muted">
            On. Signing in needs your password and a code from your authenticator app.
          </p>
          <p v-else class="mt-1 text-sm text-ink-muted">
            Off. Your password is the only thing protecting this panel.
          </p>
        </div>
      </div>

      <AlertMessage v-if="!loading && !enrolled" tone="warning" class="mt-4">
        Recommended. This panel is reachable from the internet and controls every website and
        mailbox on this server. Without a second step, anyone who learns your password has all
        of it.
      </AlertMessage>

      <AlertMessage v-if="notice" tone="info" class="mt-4">{{ notice }}</AlertMessage>

      <!-- Nothing in progress: offer the actions that apply. -->
      <div v-if="mode === 'idle'" class="mt-5 flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary" @click="reset(); mode = 'enrolling'">
          {{ enrolled ? 'Replace authenticator' : 'Turn on two-factor' }}
        </button>
        <button
          v-if="enrolled"
          type="button"
          class="btn btn-danger"
          @click="reset(); mode = 'disabling'"
        >
          Turn off
        </button>
      </div>

      <!-- A fresh set of codes, shown once. -->
      <div v-else-if="codes.length > 0" class="mt-5 border-t border-line pt-5">
        <RecoveryCodes :codes="codes" @done="reset" />
      </div>

      <!-- Step-up: prove the password, and possession of the current device. -->
      <form
        v-else-if="!totpUri"
        class="mt-5 space-y-4 border-t border-line pt-5"
        @submit.prevent="
          mode === 'disabling' ? disable() : mode === 'regenerating' ? regenerate() : beginEnrolment()
        "
      >
        <p class="text-sm text-ink-muted">
          <template v-if="mode === 'disabling'">
            Turning two-factor off needs both factors, so that a stolen password on its own
            cannot remove it.
          </template>
          <template v-else-if="mode === 'regenerating'">
            New codes replace all of your existing ones, used or not.
          </template>
          <template v-else-if="enrolled">
            Replacing your authenticator needs a code from the current one. You keep signing in
            with it until the new one is confirmed.
          </template>
          <template v-else>Confirm your password to continue.</template>
        </p>

        <div>
          <label for="sec-password" class="label">Password</label>
          <input
            id="sec-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="field"
          />
        </div>

        <div v-if="enrolled">
          <label for="sec-code" class="label">Code from your current authenticator app</label>
          <input
            id="sec-code"
            v-model="currentCode"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            class="field text-center font-mono text-lg tracking-[0.4em]"
          />
        </div>

        <AlertMessage v-if="error">{{ error }}</AlertMessage>

        <div class="flex gap-2">
          <button type="button" class="btn btn-ghost" @click="reset">Cancel</button>
          <button
            type="submit"
            :disabled="busy || !canSubmitStepUp"
            class="btn"
            :class="mode === 'disabling' ? 'btn-danger' : 'btn-primary'"
          >
            <template v-if="busy">Working…</template>
            <template v-else-if="mode === 'disabling'">Turn off two-factor</template>
            <template v-else-if="mode === 'regenerating'">Generate new codes</template>
            <template v-else>Continue</template>
          </button>
        </div>
      </form>

      <!-- Scan and confirm. -->
      <div v-else class="mt-5 border-t border-line pt-5">
        <TotpEnrolment
          :uri="totpUri"
          :secret="totpSecret"
          :busy="busy"
          :error="error"
          :confirm-label="enrolled ? 'Confirm new authenticator' : 'Turn on two-factor'"
          cancel-label="Cancel"
          @confirm="confirmEnrolment"
          @cancel="cancelEnrolment"
        />
      </div>
    </section>

    <section v-if="enrolled" class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
                 bg-elevated text-ink-muted"
          aria-hidden="true"
        >
          <KeyRound :size="19" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Recovery codes</h2>
          <p class="mt-1 text-sm text-ink-muted">
            {{ codeStatus.remaining }} of {{ codeStatus.total }} left. Each one signs you in
            once if you lose your authenticator app.
          </p>
        </div>
      </div>

      <AlertMessage v-if="codeStatus.remaining <= 2" tone="warning" class="mt-4">
        You are nearly out. Generate a new set now, while you can still sign in to do it.
      </AlertMessage>

      <button
        v-if="mode === 'idle'"
        type="button"
        class="btn btn-ghost mt-5"
        @click="reset(); mode = 'regenerating'"
      >
        Generate new codes
      </button>
    </section>

    <section class="card mt-4 p-6">
      <h2 class="text-base font-semibold text-ink">Password</h2>

      <form class="mt-4 max-w-sm space-y-4" @submit.prevent="changePassword">
        <div>
          <label for="pw-current" class="label">Current password</label>
          <input
            id="pw-current"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            class="field"
          />
        </div>

        <div>
          <label for="pw-new" class="label">New password</label>
          <input
            id="pw-new"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            class="field"
          />
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            placeholder="Confirm new password"
            aria-label="Confirm new password"
            class="field mt-2"
          />
          <p v-if="passwordProblem" class="mt-1.5 text-xs text-warn">{{ passwordProblem }}</p>
          <p v-else class="hint">At least 12 characters. Length matters more than symbols.</p>
        </div>

        <AlertMessage v-if="passwordError">{{ passwordError }}</AlertMessage>
        <AlertMessage v-if="passwordNotice" tone="success">{{ passwordNotice }}</AlertMessage>

        <button
          type="submit"
          :disabled="!canChangePassword || passwordBusy"
          class="btn btn-primary"
        >
          {{ passwordBusy ? 'Changing…' : 'Change password' }}
        </button>
      </form>
    </section>

    <section class="card mt-4 flex items-start gap-3 p-6">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
               bg-elevated text-ink-muted"
        aria-hidden="true"
      >
        <KeyRound :size="19" />
      </span>
      <div>
        <h2 class="text-base font-semibold text-ink">Lost your authenticator?</h2>
        <p class="mt-1 text-sm text-ink-muted">
          Sign in with one of your recovery codes, then replace the authenticator here. If you
          have run out of codes as well, you will need console or remote-desktop access to the
          server itself — the same access that authorised setting this panel up.
        </p>
      </div>
    </section>
  </div>
</template>
