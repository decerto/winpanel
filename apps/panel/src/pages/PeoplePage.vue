<script setup lang="ts">
import { computed, ref } from 'vue';
import { KeyRound, Pencil, RefreshCw, Trash2, UserPlus, UsersRound } from 'lucide-vue-next';
import { PASSWORD_MIN_LENGTH, ROLE_LABELS, roleAtLeast, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { formatBytes, timeAgo } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';

/**
 * The people who can sign in to this server.
 *
 * A hosting panel has two audiences that must never be confused: the people
 * who run the machine, and the customers who have a website on it. This page
 * is where that line is drawn, so it is deliberately explicit about what each
 * role can reach rather than leaving it to a single word in a dropdown.
 *
 * Limits are entered in the units people actually think in — a number of
 * websites, a number of gigabytes — and left blank for "no limit", because an
 * empty field reads as unlimited far more naturally than a zero does.
 */

type Person = Awaited<ReturnType<typeof api.users.list.query>>[number];

const GB = 1024 ** 3;

const people = ref<Person[]>([]);
const me = ref<{ id: string; role: UserRole } | null>(null);

const loading = ref(true);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/** The roles the signed-in person is allowed to hand out. */
const assignableRoles = computed<UserRole[]>(() =>
  me.value?.role === 'superadmin' ? ['superadmin', 'admin', 'user'] : ['user'],
);

function canManage(person: Person): boolean {
  if (!me.value) return false;
  if (person.id === me.value.id) return false;
  if (me.value.role === 'superadmin') return true;
  // An admin manages customers only. Anyone at or above their own level is
  // the owner's to change.
  return !roleAtLeast(person.role, me.value.role);
}

async function refresh(): Promise<void> {
  error.value = null;

  try {
    const [list, current] = await Promise.all([api.users.list.query(), api.auth.me.query()]);
    people.value = list;
    me.value = current ? { id: current.id, role: current.role } : null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

void refresh();

async function run(key: string, action: () => Promise<void>): Promise<void> {
  busy.value = key;
  error.value = null;
  notice.value = null;

  try {
    await action();
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

/* --------------------------------------------------------------- the form */

interface FormState {
  open: boolean;
  /** Null when creating somebody new. */
  editing: Person | null;
  username: string;
  password: string;
  role: UserRole;
  /** Empty means no limit, which is what a blank field should mean. */
  siteLimit: string;
  mailQuotaGb: string;
  siteDiskQuotaGb: string;
}

function blankForm(): FormState {
  return {
    open: false,
    editing: null,
    username: '',
    password: '',
    role: 'user',
    siteLimit: '1',
    mailQuotaGb: '5',
    siteDiskQuotaGb: '20',
  };
}

const form = ref<FormState>(blankForm());

/** Limits only apply to customers, so the fields are hidden for the rest. */
const showLimits = computed(() => form.value.role === 'user');

function openCreate(): void {
  form.value = { ...blankForm(), open: true, password: suggestPassword() };
}

function openEdit(person: Person): void {
  form.value = {
    open: true,
    editing: person,
    username: person.username,
    password: '',
    role: person.role,
    siteLimit: person.siteLimit === null ? '' : String(person.siteLimit),
    mailQuotaGb: person.mailQuotaBytes === null ? '' : String(person.mailQuotaBytes / GB),
    siteDiskQuotaGb:
      person.siteDiskQuotaBytes === null ? '' : String(person.siteDiskQuotaBytes / GB),
  };
}

/**
 * A password nobody has to invent.
 *
 * Whoever creates the account has to read this out or paste it into a message,
 * so it leaves out the characters that are misread by eye or by ear.
 */
function suggestPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(20);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}

/** Blank means no limit; anything else has to be a sensible number. */
function toLimit(value: string, multiplier = 1): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * multiplier) : null;
}

const canSubmit = computed(() => {
  if (form.value.editing) return true;
  return form.value.username.trim().length >= 3 && form.value.password.length >= PASSWORD_MIN_LENGTH;
});

async function submitForm(): Promise<void> {
  const state = form.value;

  const limits =
    state.role === 'user'
      ? {
          siteLimit: toLimit(state.siteLimit),
          mailQuotaBytes: toLimit(state.mailQuotaGb, GB),
          siteDiskQuotaBytes: toLimit(state.siteDiskQuotaGb, GB),
        }
      : { siteLimit: null, mailQuotaBytes: null, siteDiskQuotaBytes: null };

  await run('form', async () => {
    if (state.editing) {
      await api.users.update.mutate({ userId: state.editing.id, role: state.role, ...limits });
      notice.value = `${state.editing.username} has been updated.`;
    } else {
      await api.users.create.mutate({
        username: state.username.trim(),
        password: state.password,
        role: state.role,
        ...limits,
      });
      notice.value =
        `${state.username.trim()} can now sign in. Give them their password — it is not ` +
        'shown again.';
    }

    form.value = blankForm();
  });
}

/* ------------------------------------------------------------ the actions */

const resetting = ref<{ person: Person; password: string } | null>(null);

function openReset(person: Person): void {
  resetting.value = { person, password: suggestPassword() };
}

async function confirmReset(): Promise<void> {
  const target = resetting.value;
  if (!target) return;

  await run(`reset:${target.person.id}`, async () => {
    await api.users.setPassword.mutate({ userId: target.person.id, password: target.password });
    notice.value =
      `${target.person.username} has a new password and has been signed out everywhere. ` +
      'Give it to them now — it is not shown again.';
    resetting.value = null;
  });
}

async function setDisabled(person: Person, disabled: boolean): Promise<void> {
  await run(`disable:${person.id}`, async () => {
    await api.users.update.mutate({ userId: person.id, disabled });
    notice.value = disabled
      ? `${person.username} has been switched off and signed out.`
      : `${person.username} can sign in again.`;
  });
}

async function remove(person: Person): Promise<void> {
  const warning =
    person.siteCount > 0
      ? `\n\nTheir ${person.siteCount} ${
          person.siteCount === 1 ? 'website stays' : 'websites stay'
        } on the server and will need giving to somebody else.`
      : '';

  if (!window.confirm(`Delete ${person.username}?${warning}`)) return;

  await run(`remove:${person.id}`, async () => {
    await api.users.remove.mutate({ userId: person.id });
    notice.value = `${person.username} has been deleted.`;
  });
}

function describeSites(person: Person): string {
  if (person.role !== 'user') return 'All websites';
  if (person.siteLimit === null) return `${person.siteCount} of unlimited`;
  return `${person.siteCount} of ${person.siteLimit}`;
}

function describeMail(person: Person): string {
  if (person.role !== 'user') return 'No limit';
  return person.mailQuotaBytes === null ? 'No limit' : formatBytes(person.mailQuotaBytes);
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl">
    <PageHeader
      title="People"
      description="Everyone who can sign in to this panel, and how much of the server each of
                   them can reach."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="busy !== null" @click="refresh">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button type="button" class="btn btn-primary" :disabled="busy !== null" @click="openCreate">
          <UserPlus :size="15" aria-hidden="true" />
          Add someone
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <div class="card overflow-hidden">
      <p v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">Loading&hellip;</p>

      <EmptyState
        v-else-if="people.length === 0"
        :icon="UsersRound"
        title="Nobody else yet"
        description="Add an account for anyone who needs their own websites on this server."
      />

      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
            <th scope="col" class="px-5 py-3 font-medium">Account</th>
            <th scope="col" class="px-5 py-3 font-medium">Can reach</th>
            <th scope="col" class="hidden px-5 py-3 font-medium sm:table-cell">Websites</th>
            <th scope="col" class="hidden px-5 py-3 font-medium lg:table-cell">Email</th>
            <th scope="col" class="hidden px-5 py-3 font-medium md:table-cell">Last signed in</th>
            <th scope="col" class="px-5 py-3 text-right font-medium">Manage</th>
          </tr>
        </thead>

        <tbody class="divide-y divide-line">
          <tr
            v-for="person in people"
            :key="person.id"
            class="transition-colors hover:bg-white/[0.03]"
          >
            <td class="whitespace-nowrap px-5 py-3">
              <span class="text-ink">{{ person.username }}</span>
              <span
                v-if="person.id === me?.id"
                class="ml-2 rounded-full bg-brand-soft/70 px-2 py-0.5 text-[0.7rem]
                       font-medium text-brand-bright"
              >
                You
              </span>
              <span
                v-if="person.disabled"
                class="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[0.7rem] font-medium
                       text-danger"
              >
                Switched off
              </span>
            </td>

            <td class="px-5 py-3">
              <span class="text-ink">{{ ROLE_LABELS[person.role].label }}</span>
              <p class="text-xs text-ink-faint">{{ ROLE_LABELS[person.role].description }}</p>
            </td>

            <td class="hidden whitespace-nowrap px-5 py-3 text-ink-muted sm:table-cell">
              {{ describeSites(person) }}
            </td>

            <td class="hidden whitespace-nowrap px-5 py-3 text-ink-muted lg:table-cell">
              {{ describeMail(person) }}
            </td>

            <td class="hidden whitespace-nowrap px-5 py-3 text-ink-muted md:table-cell">
              {{ person.lastLoginAt ? timeAgo(person.lastLoginAt) : 'Never' }}
            </td>

            <td class="whitespace-nowrap px-5 py-3 text-right">
              <div class="flex justify-end gap-1">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!canManage(person) || busy !== null"
                  title="Change role and limits"
                  @click="openEdit(person)"
                >
                  <Pencil :size="14" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!canManage(person) || busy !== null"
                  title="Set a new password"
                  @click="openReset(person)"
                >
                  <KeyRound :size="14" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!canManage(person) || busy !== null"
                  :title="person.disabled ? 'Let them sign in again' : 'Switch this account off'"
                  @click="setDisabled(person, !person.disabled)"
                >
                  {{ person.disabled ? 'Switch on' : 'Switch off' }}
                </button>

                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-danger"
                  :disabled="!canManage(person) || busy !== null"
                  title="Delete this account"
                  @click="remove(person)"
                >
                  <Trash2 :size="14" aria-hidden="true" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Add or edit -->
    <div
      v-if="form.open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      @click.self="form.open = false"
    >
      <form
        class="card w-full max-w-lg space-y-4 p-5"
        role="dialog"
        aria-modal="true"
        @submit.prevent="submitForm"
      >
        <h2 class="text-base font-semibold text-ink">
          {{ form.editing ? `Edit ${form.editing.username}` : 'Add someone' }}
        </h2>

        <div v-if="!form.editing" class="space-y-1">
          <label class="label" for="person-username">Username</label>
          <input
            id="person-username"
            v-model="form.username"
            class="field"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div v-if="!form.editing" class="space-y-1">
          <label class="label" for="person-password">First password</label>
          <input id="person-password" v-model="form.password" class="field font-mono" />
          <p class="text-xs text-ink-faint">
            Give this to them yourself. It is not shown again, and they can change it once they
            are in.
          </p>
        </div>

        <div class="space-y-1">
          <label class="label" for="person-role">Can reach</label>
          <select id="person-role" v-model="form.role" class="field">
            <option v-for="value in assignableRoles" :key="value" :value="value">
              {{ ROLE_LABELS[value].label }}
            </option>
          </select>
          <p class="text-xs text-ink-faint">{{ ROLE_LABELS[form.role].description }}</p>
        </div>

        <div v-if="showLimits" class="grid gap-3 sm:grid-cols-3">
          <div class="space-y-1">
            <label class="label" for="person-sites">Websites</label>
            <input
              id="person-sites"
              v-model="form.siteLimit"
              class="field"
              inputmode="numeric"
              placeholder="No limit"
            />
          </div>

          <div class="space-y-1">
            <label class="label" for="person-mail">Email (GB)</label>
            <input
              id="person-mail"
              v-model="form.mailQuotaGb"
              class="field"
              inputmode="decimal"
              placeholder="No limit"
            />
          </div>

          <div class="space-y-1">
            <label class="label" for="person-disk">Disk per site (GB)</label>
            <input
              id="person-disk"
              v-model="form.siteDiskQuotaGb"
              class="field"
              inputmode="decimal"
              placeholder="Server default"
            />
          </div>

          <p class="text-xs text-ink-faint sm:col-span-3">
            Leave a field empty for no limit. All three can be changed later.
          </p>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="btn btn-ghost" @click="form.open = false">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!canSubmit || busy !== null">
            {{ form.editing ? 'Save' : 'Create account' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Password reset -->
    <div
      v-if="resetting"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      @click.self="resetting = null"
    >
      <form
        class="card w-full max-w-md space-y-4 p-5"
        role="dialog"
        aria-modal="true"
        @submit.prevent="confirmReset"
      >
        <h2 class="text-base font-semibold text-ink">
          New password for {{ resetting.person.username }}
        </h2>

        <input v-model="resetting.password" class="field font-mono" aria-label="New password" />

        <p class="text-sm text-ink-muted">
          Setting this signs them out of every browser they are using. Copy it before you save
          &mdash; it is not shown again.
        </p>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-ghost" @click="resetting = null">Cancel</button>
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="resetting.password.length < PASSWORD_MIN_LENGTH || busy !== null"
          >
            Set password
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
