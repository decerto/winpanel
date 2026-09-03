<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Database,
  Gamepad2,
  Globe2,
  Inbox,
  KeyRound,
  ListChecks,
  Mail,
  Pencil,
  RefreshCw,
  Trash2,
  UserPlus,
  UsersRound,
} from 'lucide-vue-next';
import { PASSWORD_MIN_LENGTH, ROLE_LABELS, roleAtLeast, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { formatBytes, timeAgo } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import Tooltip from '../components/Tooltip.vue';

/**
 * The people who can sign in to this server.
 *
 * A hosting panel has two audiences that must never be confused: the people
 * who run the machine, and the customers who have a website on it. This page
 * is where that line is drawn, so it is deliberately explicit about what each
 * role can reach rather than leaving it to a single word in a dropdown.
 *
 * Limits are entered in the units people actually think in — a number of
 * websites, a number of gigabytes — with an explicit mode so zero can keep
 * its useful meaning: no access for count limits, and no storage for quotas.
 */

type Person = Awaited<ReturnType<typeof api.users.list.query>>[number];
type GameServerCatalogEntry = Awaited<ReturnType<typeof api.gameServers.catalogue.query>>[number];

const GB = 1024 ** 3;

const people = ref<Person[]>([]);
const gameCatalogue = ref<ReadonlyArray<GameServerCatalogEntry>>([]);
const me = ref<{ id: string; role: UserRole } | null>(null);
/** Whether this machine runs a database server at all. */
const databasesAvailable = ref(false);

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
    const catalogueRequest = api.gameServers?.catalogue?.query?.() ?? Promise.resolve([]);
    const engineRequest =
      api.databases?.engines?.query?.() ?? Promise.resolve({ engines: [] as unknown[] });

    const [list, current, catalogue, engines] = await Promise.all([
      api.users.list.query(),
      api.auth.me.query(),
      catalogueRequest.catch(() => []),
      engineRequest.catch(() => ({ engines: [] as unknown[] })),
    ]);
    people.value = list;
    gameCatalogue.value = catalogue.filter((entry) => entry.status === 'ready');
    me.value = current ? { id: current.id, role: current.role } : null;
    // Not `visible`: an administrator is asking on somebody else's behalf, so
    // what matters is whether the machine has a database server — setting the
    // allowance is exactly how they make it visible to that customer.
    databasesAvailable.value = engines.engines.length > 0;
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

type LimitMode = 'limited' | 'unlimited';
type SiteDiskMode = 'limited' | 'server-default';
type CountLimitKey = 'site' | 'subdomain' | 'backup' | 'mailbox' | 'gameServer' | 'database';

interface FormState {
  open: boolean;
  /** Null when creating somebody new. */
  editing: Person | null;
  username: string;
  password: string;
  email: string;
  role: UserRole;
  siteLimit: string;
  siteLimitMode: LimitMode;
  subdomainLimit: string;
  subdomainLimitMode: LimitMode;
  backupLimit: string;
  backupLimitMode: LimitMode;
  mailboxLimit: string;
  mailboxLimitMode: LimitMode;
  mailQuotaGb: string;
  mailQuotaMode: LimitMode;
  siteDiskQuotaGb: string;
  siteDiskQuotaMode: SiteDiskMode;
  gameServerLimit: string;
  gameServerLimitMode: LimitMode;
  databaseLimit: string;
  databaseLimitMode: LimitMode;
  databaseQuotaGb: string;
  databaseQuotaMode: LimitMode;
  gameServerProviders: string[];
}

function blankForm(): FormState {
  return {
    open: false,
    editing: null,
    username: '',
    password: '',
    email: '',
    role: 'user',
    siteLimit: '1',
    siteLimitMode: 'limited',
    subdomainLimit: '5',
    subdomainLimitMode: 'limited',
    backupLimit: '1',
    backupLimitMode: 'limited',
    mailboxLimit: '5',
    mailboxLimitMode: 'limited',
    mailQuotaGb: '5',
    mailQuotaMode: 'limited',
    siteDiskQuotaGb: '20',
    siteDiskQuotaMode: 'limited',
    gameServerLimit: '1',
    gameServerLimitMode: 'limited',
    /*
     * Databases start at none. A customer who was not sold databases should
     * not find the whole section waiting in their panel — raising this is how
     * an administrator decides they were.
     */
    databaseLimit: '0',
    databaseLimitMode: 'limited',
    databaseQuotaGb: '',
    databaseQuotaMode: 'unlimited',
    gameServerProviders: [],
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
    email: person.email ?? '',
    role: person.role,
    siteLimit: person.siteLimit === null ? '' : String(person.siteLimit),
    siteLimitMode: person.siteLimit === null ? 'unlimited' : 'limited',
    subdomainLimit:
      person.subdomainLimit === null || person.subdomainLimit === undefined
        ? ''
        : String(person.subdomainLimit),
    subdomainLimitMode:
      person.subdomainLimit === null || person.subdomainLimit === undefined ? 'unlimited' : 'limited',
    backupLimit:
      person.backupLimit === null || person.backupLimit === undefined
        ? ''
        : String(person.backupLimit),
    backupLimitMode:
      person.backupLimit === null || person.backupLimit === undefined ? 'unlimited' : 'limited',
    mailboxLimit:
      person.mailboxLimit === null || person.mailboxLimit === undefined ? '' : String(person.mailboxLimit),
    mailboxLimitMode:
      person.mailboxLimit === null || person.mailboxLimit === undefined ? 'unlimited' : 'limited',
    mailQuotaGb: person.mailQuotaBytes === null ? '' : String(person.mailQuotaBytes / GB),
    mailQuotaMode: person.mailQuotaBytes === null ? 'unlimited' : 'limited',
    siteDiskQuotaGb:
      person.siteDiskQuotaBytes === null ? '' : String(person.siteDiskQuotaBytes / GB),
    siteDiskQuotaMode: person.siteDiskQuotaBytes === null ? 'server-default' : 'limited',
    gameServerLimit:
      person.gameServerLimit === null || person.gameServerLimit === undefined
        ? ''
        : String(person.gameServerLimit),
    gameServerLimitMode:
      person.gameServerLimit === null || person.gameServerLimit === undefined ? 'unlimited' : 'limited',
    databaseLimit:
      person.databaseLimit === null || person.databaseLimit === undefined
        ? ''
        : String(person.databaseLimit),
    databaseLimitMode:
      person.databaseLimit === null || person.databaseLimit === undefined ? 'unlimited' : 'limited',
    databaseQuotaGb:
      person.databaseQuotaBytes === null || person.databaseQuotaBytes === undefined
        ? ''
        : String(person.databaseQuotaBytes / GB),
    databaseQuotaMode:
      person.databaseQuotaBytes === null || person.databaseQuotaBytes === undefined
        ? 'unlimited'
        : 'limited',
    gameServerProviders: [...(person.gameServerProviders ?? [])],
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

const countLimitFields = {
  site: { value: 'siteLimit', mode: 'siteLimitMode' },
  subdomain: { value: 'subdomainLimit', mode: 'subdomainLimitMode' },
  backup: { value: 'backupLimit', mode: 'backupLimitMode' },
  mailbox: { value: 'mailboxLimit', mode: 'mailboxLimitMode' },
  gameServer: { value: 'gameServerLimit', mode: 'gameServerLimitMode' },
  database: { value: 'databaseLimit', mode: 'databaseLimitMode' },
} as const;

function setCountLimitMode(key: CountLimitKey, mode: LimitMode): void {
  const fields = countLimitFields[key];
  form.value[fields.mode] = mode;
  if (mode === 'unlimited') {
    form.value[fields.value] = '';
  } else if (form.value[fields.value].trim() === '') {
    // Zero is an intentional, visible "no access" starting point.
    form.value[fields.value] = '0';
  }
}

function setMailQuotaMode(mode: LimitMode): void {
  form.value.mailQuotaMode = mode;
  if (mode === 'unlimited') {
    form.value.mailQuotaGb = '';
  }
}

function setSiteDiskQuotaMode(mode: SiteDiskMode): void {
  form.value.siteDiskQuotaMode = mode;
  if (mode === 'server-default') {
    form.value.siteDiskQuotaGb = '';
  }
}

function setDatabaseQuotaMode(mode: LimitMode): void {
  form.value.databaseQuotaMode = mode;
  if (mode === 'unlimited') {
    form.value.databaseQuotaGb = '';
  } else if (form.value.databaseQuotaGb.trim() === '') {
    form.value.databaseQuotaGb = '0';
  }
}

function validateCountLimit(label: string, value: string, mode: LimitMode, maximum: number): string | null {
  if (mode === 'unlimited') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    return `${label}: enter a whole number, or choose No limit.`;
  }
  if (Number(trimmed) > maximum) return `${label}: enter a number up to ${maximum}.`;
  return null;
}

function validateGbQuota(
  label: string,
  value: string,
  mode: LimitMode | SiteDiskMode,
  minimum: number,
): string | null {
  if (mode === 'unlimited' || mode === 'server-default') return null;
  const parsed = Number(value.trim());
  if (!value.trim() || !Number.isFinite(parsed) || parsed < minimum) {
    const minimumText = minimum === 0 ? 'zero or more' : `at least ${minimum} GB`;
    return `${label}: enter ${minimumText}, or choose the unlimited/default option.`;
  }
  if (!Number.isSafeInteger(Math.round(parsed * GB))) {
    return `${label}: enter a smaller value.`;
  }
  return null;
}

const formValidationError = computed(() => {
  if (form.value.role !== 'user') return null;

  const checks = [
    validateCountLimit('Websites', form.value.siteLimit, form.value.siteLimitMode, 1000),
    validateCountLimit('Subdomains', form.value.subdomainLimit, form.value.subdomainLimitMode, 1000),
    validateCountLimit('Backups', form.value.backupLimit, form.value.backupLimitMode, 1000),
    validateCountLimit('Mailboxes', form.value.mailboxLimit, form.value.mailboxLimitMode, 10000),
    validateGbQuota('Email storage', form.value.mailQuotaGb, form.value.mailQuotaMode, 0),
    validateGbQuota('Disk per site', form.value.siteDiskQuotaGb, form.value.siteDiskQuotaMode, 0),
    validateCountLimit('Game servers', form.value.gameServerLimit, form.value.gameServerLimitMode, 1000),
    databasesAvailable.value
      ? validateCountLimit('Databases', form.value.databaseLimit, form.value.databaseLimitMode, 1000)
      : null,
    databasesAvailable.value
      ? validateGbQuota('Database storage', form.value.databaseQuotaGb, form.value.databaseQuotaMode, 0)
      : null,
  ];
  return checks.find((message): message is string => message !== null) ?? null;
});

function countValue(value: string, mode: LimitMode): number | null {
  return mode === 'unlimited' ? null : Number(value.trim());
}

function quotaValue(value: string, mode: LimitMode | SiteDiskMode): number | null {
  if (mode === 'unlimited' || mode === 'server-default') return null;
  return Math.round(Number(value.trim()) * GB);
}

function databaseQuotaValue(value: string, mode: LimitMode): number | null {
  return mode === 'unlimited' ? null : Math.round(Number(value.trim()) * GB);
}

const canSubmit = computed(() => {
  if (formValidationError.value) return false;
  if (form.value.editing) return true;
  return form.value.username.trim().length >= 3 && form.value.password.length >= PASSWORD_MIN_LENGTH;
});

async function submitForm(): Promise<void> {
  const state = form.value;
  if (formValidationError.value) return;

  const requestedEmail = state.email.trim();
  const previousEmail = state.editing?.email?.trim() ?? '';
  const emailChanged = !state.editing || requestedEmail.toLowerCase() !== previousEmail.toLowerCase();

  const limits =
    state.role === 'user'
      ? {
          siteLimit: countValue(state.siteLimit, state.siteLimitMode),
          subdomainLimit: countValue(state.subdomainLimit, state.subdomainLimitMode),
          backupLimit: countValue(state.backupLimit, state.backupLimitMode),
          mailboxLimit: countValue(state.mailboxLimit, state.mailboxLimitMode),
          mailQuotaBytes: quotaValue(state.mailQuotaGb, state.mailQuotaMode),
          siteDiskQuotaBytes: quotaValue(state.siteDiskQuotaGb, state.siteDiskQuotaMode),
          gameServerLimit: countValue(state.gameServerLimit, state.gameServerLimitMode),
          databaseLimit: countValue(state.databaseLimit, state.databaseLimitMode),
          databaseQuotaBytes: databaseQuotaValue(state.databaseQuotaGb, state.databaseQuotaMode),
          gameServerProviders: state.gameServerProviders,
        }
      : {
          siteLimit: null,
          subdomainLimit: null,
          backupLimit: null,
          mailboxLimit: null,
          mailQuotaBytes: null,
          siteDiskQuotaBytes: null,
          gameServerLimit: null,
          databaseLimit: null,
          databaseQuotaBytes: null,
          gameServerProviders: [],
        };

  await run('form', async () => {
    const email = { email: state.email.trim() || null };

    if (state.editing) {
      const result = await api.users.update.mutate({
        userId: state.editing.id,
        role: state.role,
        ...email,
        ...limits,
      });
      notice.value = `${state.editing.username} has been updated.`;
      if (emailChanged && requestedEmail) {
        notice.value += result.verificationSent
          ? ' A verification email is on its way.'
          : ' The account was saved, but the verification email could not be sent.';
      }
    } else {
      const result = await api.users.create.mutate({
        username: state.username.trim(),
        password: state.password,
        role: state.role,
        ...email,
        ...limits,
      });
      notice.value =
        `${state.username.trim()} can now sign in. Give them their password — it is not ` +
        'shown again.';
      if (requestedEmail) {
        notice.value += result.verificationSent
          ? ' A verification email is on its way.'
          : ' The account was saved, but the verification email could not be sent.';
      }
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
  if (person.siteLimit === 0) return 'No websites';
  return `${person.siteCount} of ${person.siteLimit}`;
}

function describeSubdomains(person: Person): string {
  if (person.role !== 'user') return 'All subdomains';
  if (person.subdomainLimit === null || person.subdomainLimit === undefined) {
    return `${person.subdomainCount ?? 0} of unlimited`;
  }
  if (person.subdomainLimit === 0) return 'No subdomains';
  return `${person.subdomainCount ?? 0} of ${person.subdomainLimit}`;
}

function describeBackups(person: Person): string {
  if (person.role !== 'user') return 'All backups';
  if (person.backupLimit === null || person.backupLimit === undefined) return 'Unlimited';
  if (person.backupLimit === 0) return 'No backups';
  return `${person.backupLimit} allowed`;
}

function describeMailboxes(person: Person): string {
  if (person.role !== 'user') return 'All mailboxes';
  if (person.mailboxCount === null || person.mailboxCount === undefined) {
    if (person.mailboxLimit === 0) return 'No mailboxes';
    return person.mailboxLimit === null || person.mailboxLimit === undefined
      ? 'Usage unavailable'
      : `Usage unavailable of ${person.mailboxLimit}`;
  }
  if (person.mailboxLimit === null || person.mailboxLimit === undefined) {
    return `${person.mailboxCount} of unlimited`;
  }
  if (person.mailboxLimit === 0) return 'No mailboxes';
  return `${person.mailboxCount} of ${person.mailboxLimit}`;
}

function describeMail(person: Person): string {
  if (person.role !== 'user') return 'No limit';
  if (person.mailQuotaBytes === null) {
    return person.mailUsedBytes == null
      ? 'Usage unavailable'
      : `${formatBytes(person.mailUsedBytes)} used of unlimited`;
  }
  if (person.mailQuotaBytes === 0) return 'No storage';
  if (person.mailUsedBytes == null) {
    return `Usage unavailable of ${formatBytes(person.mailQuotaBytes)}`;
  }
  return `${formatBytes(person.mailUsedBytes)} used of ${formatBytes(person.mailQuotaBytes)}`;
}

function describeGameServers(person: Person): string {
  if (person.role !== 'user') return 'All games';
  if (person.gameServerLimit === null || person.gameServerLimit === undefined) {
    return `${person.gameServerCount ?? 0} of unlimited`;
  }
  if (person.gameServerLimit === 0) return 'No game servers';
  return `${person.gameServerCount ?? 0} of ${person.gameServerLimit}`;
}

function describeDatabases(person: Person): string {
  if (person.role !== 'user') return 'All databases';
  if (person.databaseLimit === null || person.databaseLimit === undefined) {
    return `${person.databaseCount ?? 0} of unlimited`;
  }
  if (person.databaseLimit === 0) return 'No databases';
  return `${person.databaseCount ?? 0} of ${person.databaseLimit}`;
}

function describeDatabaseStorage(person: Person): string {
  if (
    person.role !== 'user' ||
    person.databaseQuotaBytes === null ||
    person.databaseQuotaBytes === undefined
  ) {
    return 'No limit';
  }
  if (person.databaseQuotaBytes === 0) return 'No storage';
  if (person.databaseUsedBytes == null) {
    return `Usage unavailable of ${formatBytes(person.databaseQuotaBytes)}`;
  }
  return `${formatBytes(person.databaseUsedBytes)} used of ${formatBytes(person.databaseQuotaBytes)}`;
}

function toggleGameProvider(catalogId: string): void {
  const providers = form.value.gameServerProviders;
  form.value.gameServerProviders = providers.includes(catalogId)
    ? providers.filter((id) => id !== catalogId)
    : [...providers, catalogId];
}

const allowsAnyGame = computed(() => form.value.gameServerProviders.length === 0);
const gameServersBlocked = computed(
  () => form.value.gameServerLimitMode === 'limited' && Number(form.value.gameServerLimit) === 0,
);

function setGameAccess(mode: 'any' | 'selected'): void {
  if (mode === 'any') {
    form.value.gameServerProviders = [];
    return;
  }

  // Selecting the first ready title gives the restricted mode a useful
  // starting point without making administrators tick every title.
  if (form.value.gameServerProviders.length === 0 && gameCatalogue.value[0]) {
    form.value.gameServerProviders = [gameCatalogue.value[0].id];
  }
}

const gamePickerQuery = ref('');

const filteredGameCatalogue = computed(() => {
  const query = gamePickerQuery.value.trim().toLowerCase();
  if (!query) return gameCatalogue.value;
  return gameCatalogue.value.filter((entry) =>
    entry.name.toLowerCase().includes(query) || entry.genre.toLowerCase().includes(query),
  );
});

function selectAllGames(): void {
  form.value.gameServerProviders = gameCatalogue.value.map((entry) => entry.id);
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

    <section class="card overflow-hidden">
      <p v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">Loading&hellip;</p>

      <EmptyState
        v-else-if="error"
        :icon="RefreshCw"
        title="Could not load people"
        description="Use Refresh to try again."
      />

      <EmptyState
        v-else-if="people.length === 0"
        :icon="UsersRound"
        title="Nobody else yet"
        description="Add an account for anyone who needs their own websites on this server."
      />

      <div v-else class="divide-y divide-line">
        <article
          v-for="person in people"
          :key="person.id"
          data-person-row
          class="p-5 transition-colors hover:bg-white/[0.03]"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-ink">{{ person.username }}</span>
                <span
                  v-if="person.id === me?.id"
                  class="rounded-full bg-brand-soft/70 px-2 py-0.5 text-[0.7rem]
                         font-medium text-brand-bright"
                >
                  You
                </span>
                <span
                  v-if="person.disabled"
                  class="rounded-full bg-danger/15 px-2 py-0.5 text-[0.7rem] font-medium
                         text-danger"
                >
                  Switched off
                </span>
                <span class="text-sm text-ink-muted">{{ ROLE_LABELS[person.role].label }}</span>
              </div>
              <p class="mt-1 max-w-2xl text-sm leading-5 text-ink-faint">
                {{ ROLE_LABELS[person.role].description }}
              </p>
              <p
                v-if="person.email"
                class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint"
              >
                <Mail :size="13" aria-hidden="true" />
                <span>{{ person.email }}</span>
                <span :class="person.emailVerified ? 'text-ok' : 'text-warn'">
                  {{ person.emailVerified ? 'Verified' : 'Needs verification' }}
                </span>
              </p>
            </div>

            <div class="flex flex-wrap justify-end gap-1">
                <Tooltip :text="`Change role and limits for ${person.username}`">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="!canManage(person) || busy !== null"
                    :aria-label="`Change role and limits for ${person.username}`"
                    @click="openEdit(person)"
                  >
                    <Pencil :size="14" aria-hidden="true" />
                  </button>
                </Tooltip>

                <Tooltip :text="`Set a new password for ${person.username}`">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="!canManage(person) || busy !== null"
                    :aria-label="`Set a new password for ${person.username}`"
                    @click="openReset(person)"
                  >
                    <KeyRound :size="14" aria-hidden="true" />
                  </button>
                </Tooltip>

                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!canManage(person) || busy !== null"
                  :title="person.disabled ? 'Let them sign in again' : 'Switch this account off'"
                  @click="setDisabled(person, !person.disabled)"
                >
                  {{ person.disabled ? 'Switch on' : 'Switch off' }}
                </button>

                <Tooltip :text="`Delete ${person.username}`">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm text-danger"
                    :disabled="!canManage(person) || busy !== null"
                    :aria-label="`Delete ${person.username}`"
                    @click="remove(person)"
                  >
                    <Trash2 :size="14" aria-hidden="true" />
                  </button>
                </Tooltip>
            </div>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3 lg:grid-cols-8">
            <div>
              <dt class="text-xs text-ink-faint">Websites</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeSites(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Subdomains</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeSubdomains(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Backups</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeBackups(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Game servers</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeGameServers(person) }}</dd>
            </div>
            <div v-if="databasesAvailable">
              <dt class="text-xs text-ink-faint">Databases</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeDatabases(person) }}</dd>
            </div>
            <div v-if="databasesAvailable">
              <dt class="text-xs text-ink-faint">Database storage</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeDatabaseStorage(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Mailboxes</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeMailboxes(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Email storage</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">{{ describeMail(person) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-faint">Last signed in</dt>
              <dd class="mt-0.5 text-sm text-ink-muted">
                {{ person.lastLoginAt ? timeAgo(person.lastLoginAt) : 'Never' }}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </section>

    <!-- Add or edit -->
    <div
      v-if="form.open"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      @click.self="form.open = false"
    >
      <form
        data-person-dialog
        class="card my-auto w-full max-w-3xl space-y-4 p-5"
        role="dialog"
        aria-modal="true"
        @submit.prevent="submitForm"
      >
        <div class="flex items-start justify-between gap-4 border-b border-line pb-4">
          <div>
            <h2 class="text-base font-semibold text-ink">
              {{ form.editing ? `Edit ${form.editing.username}` : 'Add someone' }}
            </h2>
            <p class="mt-1 text-sm text-ink-faint">Set their role and the resources available to them.</p>
          </div>
          <UsersRound :size="20" class="mt-0.5 shrink-0 text-brand-bright" aria-hidden="true" />
        </div>

        <section class="form-section form-section-first" data-limit-section="account">
          <div class="section-heading">
            <div class="section-icon"><UsersRound :size="16" aria-hidden="true" /></div>
            <div>
              <h3 class="section-title">Account</h3>
              <p class="section-description">Sign-in details and administrative role.</p>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
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
              <p class="hint">Give this to them yourself. It is not shown again.</p>
            </div>

            <div class="space-y-1 sm:col-span-2">
              <label class="label" for="person-email">
                Notification email <span class="text-ink-faint">(optional)</span>
              </label>
              <input
                id="person-email"
                v-model="form.email"
                class="field"
                type="email"
                autocomplete="email"
                spellcheck="false"
                placeholder="owner@example.com"
              />
              <p class="hint">
                We will send them a verification link. They can enter or replace this in Account
                settings later, and the address must be verified before panel alerts are sent.
              </p>
            </div>

            <div class="space-y-1 sm:col-span-2">
              <label class="label" for="person-role">Role</label>
              <select id="person-role" v-model="form.role" class="field">
                <option v-for="value in assignableRoles" :key="value" :value="value">
                  {{ ROLE_LABELS[value].label }}
                </option>
              </select>
              <p class="hint">{{ ROLE_LABELS[form.role].description }}</p>
            </div>
          </div>
        </section>

        <div v-if="showLimits" class="space-y-5">
          <section class="form-section" data-limit-section="hosting">
            <div class="section-heading">
              <div class="section-icon"><Globe2 :size="16" aria-hidden="true" /></div>
              <div>
                <h3 class="section-title">Hosting</h3>
                <p class="section-description">Websites, subdomains, and disk assigned to each site.</p>
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-sites">Websites</label>
                  <p class="limit-caption">Customer-owned websites</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Website limit mode">
                  <label class="limit-mode-option" :class="form.siteLimitMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="site-limit-mode"
                      class="sr-only"
                      :checked="form.siteLimitMode === 'limited'"
                      @change="setCountLimitMode('site', 'limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.siteLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="site-limit-mode"
                      class="sr-only"
                      :checked="form.siteLimitMode === 'unlimited'"
                      @change="setCountLimitMode('site', 'unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.siteLimitMode === 'limited'" class="limit-input">
                  <input id="person-sites" v-model="form.siteLimit" class="field" type="text" inputmode="numeric" />
                  <span>sites</span>
                </div>
                <p v-if="form.siteLimitMode === 'limited' && form.siteLimit.trim() === '0'" class="limit-zero">
                  No websites can be created.
                </p>
              </div>

              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-subdomains">Subdomains</label>
                  <p class="limit-caption">Additional sites under their domains</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Subdomain limit mode">
                  <label class="limit-mode-option" :class="form.subdomainLimitMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="subdomain-limit-mode"
                      class="sr-only"
                      :checked="form.subdomainLimitMode === 'limited'"
                      @change="setCountLimitMode('subdomain', 'limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.subdomainLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="subdomain-limit-mode"
                      class="sr-only"
                      :checked="form.subdomainLimitMode === 'unlimited'"
                      @change="setCountLimitMode('subdomain', 'unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.subdomainLimitMode === 'limited'" class="limit-input">
                  <input id="person-subdomains" v-model="form.subdomainLimit" class="field" type="text" inputmode="numeric" />
                  <span>subdomains</span>
                </div>
                <p v-if="form.subdomainLimitMode === 'limited' && form.subdomainLimit.trim() === '0'" class="limit-zero">
                  No subdomains can be created.
                </p>
              </div>

              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-backups">Backups</label>
                  <p class="limit-caption">Saved website copies across their account</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Backup limit mode">
                  <label class="limit-mode-option" :class="form.backupLimitMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="backup-limit-mode"
                      class="sr-only"
                      :checked="form.backupLimitMode === 'limited'"
                      @change="setCountLimitMode('backup', 'limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.backupLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="backup-limit-mode"
                      class="sr-only"
                      :checked="form.backupLimitMode === 'unlimited'"
                      @change="setCountLimitMode('backup', 'unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.backupLimitMode === 'limited'" class="limit-input">
                  <input id="person-backups" v-model="form.backupLimit" class="field" type="text" inputmode="numeric" />
                  <span>backups</span>
                </div>
                <p v-if="form.backupLimitMode === 'limited' && form.backupLimit.trim() === '0'" class="limit-zero">
                  No website backups can be kept.
                </p>
              </div>

              <div class="limit-item sm:col-span-2">
                <div>
                  <label class="label mb-0" for="person-disk">Disk per site</label>
                  <p class="limit-caption">Storage available to each new website</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Disk per site mode">
                  <label class="limit-mode-option" :class="form.siteDiskQuotaMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="site-disk-mode"
                      class="sr-only"
                      :checked="form.siteDiskQuotaMode === 'limited'"
                      @change="setSiteDiskQuotaMode('limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.siteDiskQuotaMode === 'server-default' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="site-disk-mode"
                      class="sr-only"
                      :checked="form.siteDiskQuotaMode === 'server-default'"
                      @change="setSiteDiskQuotaMode('server-default')"
                    />
                    Server default
                  </label>
                </div>
                <div v-if="form.siteDiskQuotaMode === 'limited'" class="limit-input">
                  <input id="person-disk" v-model="form.siteDiskQuotaGb" class="field" type="text" inputmode="decimal" />
                  <span>GB per site</span>
                </div>
                <p v-if="form.siteDiskQuotaMode === 'limited' && form.siteDiskQuotaGb.trim() === '0'" class="limit-zero">
                  No disk storage will be available.
                </p>
              </div>
            </div>
          </section>

          <section class="form-section" data-limit-section="email">
            <div class="section-heading">
              <div class="section-icon"><Inbox :size="16" aria-hidden="true" /></div>
              <div>
                <h3 class="section-title">Email</h3>
                <p class="section-description">Mailbox count and total storage across their domains.</p>
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-mailboxes">Mailboxes</label>
                  <p class="limit-caption">Total mailboxes they can create</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Mailbox limit mode">
                  <label class="limit-mode-option" :class="form.mailboxLimitMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="mailbox-limit-mode"
                      class="sr-only"
                      :checked="form.mailboxLimitMode === 'limited'"
                      @change="setCountLimitMode('mailbox', 'limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.mailboxLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="mailbox-limit-mode"
                      class="sr-only"
                      :checked="form.mailboxLimitMode === 'unlimited'"
                      @change="setCountLimitMode('mailbox', 'unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.mailboxLimitMode === 'limited'" class="limit-input">
                  <input id="person-mailboxes" v-model="form.mailboxLimit" class="field" type="text" inputmode="numeric" />
                  <span>mailboxes</span>
                </div>
                <p v-if="form.mailboxLimitMode === 'limited' && form.mailboxLimit.trim() === '0'" class="limit-zero">
                  No mailboxes can be created.
                </p>
              </div>

              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-mail">Email storage</label>
                  <p class="limit-caption">Combined storage for all mailboxes</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Email storage mode">
                  <label class="limit-mode-option" :class="form.mailQuotaMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="mail-quota-mode"
                      class="sr-only"
                      :checked="form.mailQuotaMode === 'limited'"
                      @change="setMailQuotaMode('limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.mailQuotaMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="mail-quota-mode"
                      class="sr-only"
                      :checked="form.mailQuotaMode === 'unlimited'"
                      @change="setMailQuotaMode('unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.mailQuotaMode === 'limited'" class="limit-input">
                  <input id="person-mail" v-model="form.mailQuotaGb" class="field" type="text" inputmode="decimal" />
                  <span>GB total</span>
                </div>
                <p v-if="form.mailQuotaMode === 'limited' && form.mailQuotaGb.trim() === '0'" class="limit-zero">
                  No email storage will be available.
                </p>
              </div>
            </div>
          </section>

          <section v-if="databasesAvailable" class="form-section" data-limit-section="databases">
            <div class="section-heading">
              <div class="section-icon"><Database :size="16" aria-hidden="true" /></div>
              <div>
                <h3 class="section-title">Databases</h3>
                <p class="section-description">Database count and the total storage they may allocate.</p>
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-databases">Databases</label>
                  <p class="limit-caption">Across every supported database engine</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Database limit mode">
                  <label class="limit-mode-option" :class="form.databaseLimitMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="database-limit-mode"
                      class="sr-only"
                      :checked="form.databaseLimitMode === 'limited'"
                      @change="setCountLimitMode('database', 'limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.databaseLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="database-limit-mode"
                      class="sr-only"
                      :checked="form.databaseLimitMode === 'unlimited'"
                      @change="setCountLimitMode('database', 'unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.databaseLimitMode === 'limited'" class="limit-input">
                  <input id="person-databases" v-model="form.databaseLimit" class="field" type="text" inputmode="numeric" />
                  <span>databases</span>
                </div>
                <p v-if="form.databaseLimitMode === 'limited' && form.databaseLimit.trim() === '0'" class="limit-zero">
                  No databases can be created.
                </p>
              </div>

              <div class="limit-item">
                <div>
                  <label class="label mb-0" for="person-database-storage">Database storage</label>
                  <p class="limit-caption">Combined allocation across their databases</p>
                </div>
                <div class="limit-mode" role="group" aria-label="Database storage mode">
                  <label class="limit-mode-option" :class="form.databaseQuotaMode === 'limited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="database-quota-mode"
                      class="sr-only"
                      :checked="form.databaseQuotaMode === 'limited'"
                      @change="setDatabaseQuotaMode('limited')"
                    />
                    Set a limit
                  </label>
                  <label class="limit-mode-option" :class="form.databaseQuotaMode === 'unlimited' ? 'limit-mode-on' : ''">
                    <input
                      type="radio"
                      name="database-quota-mode"
                      class="sr-only"
                      :checked="form.databaseQuotaMode === 'unlimited'"
                      @change="setDatabaseQuotaMode('unlimited')"
                    />
                    No limit
                  </label>
                </div>
                <div v-if="form.databaseQuotaMode === 'limited'" class="limit-input">
                  <input id="person-database-storage" v-model="form.databaseQuotaGb" class="field" type="text" inputmode="decimal" />
                  <span>GB total</span>
                </div>
                <p v-if="form.databaseQuotaMode === 'unlimited'" class="limit-status">No limit: storage allocation is unlimited.</p>
                <p v-else class="limit-caption">A positive value is required. Zero means No limit here.</p>
              </div>
            </div>
          </section>

          <section class="form-section" data-limit-section="game-servers">
            <div class="section-heading">
              <div class="section-icon"><Gamepad2 :size="16" aria-hidden="true" /></div>
              <div>
                <h3 class="section-title">Game servers</h3>
                <p class="section-description">How many servers they may run and which games they may choose.</p>
              </div>
            </div>

            <div class="limit-item">
              <div>
                <label class="label mb-0" for="person-game-servers">Game servers</label>
                <p class="limit-caption">Customer-owned game servers</p>
              </div>
              <div class="limit-mode" role="group" aria-label="Game server limit mode">
                <label class="limit-mode-option" :class="form.gameServerLimitMode === 'limited' ? 'limit-mode-on' : ''">
                  <input
                    type="radio"
                    name="game-server-limit-mode"
                    class="sr-only"
                    :checked="form.gameServerLimitMode === 'limited'"
                    @change="setCountLimitMode('gameServer', 'limited')"
                  />
                  Set a limit
                </label>
                <label class="limit-mode-option" :class="form.gameServerLimitMode === 'unlimited' ? 'limit-mode-on' : ''">
                  <input
                    type="radio"
                    name="game-server-limit-mode"
                    class="sr-only"
                    :checked="form.gameServerLimitMode === 'unlimited'"
                    @change="setCountLimitMode('gameServer', 'unlimited')"
                  />
                  No limit
                </label>
              </div>
              <div v-if="form.gameServerLimitMode === 'limited'" class="limit-input max-w-sm">
                <input id="person-game-servers" v-model="form.gameServerLimit" class="field" type="text" inputmode="numeric" />
                <span>servers</span>
              </div>
              <p v-if="form.gameServerLimitMode === 'limited' && form.gameServerLimit.trim() === '0'" class="limit-zero">
                No game servers can be created.
              </p>
            </div>

            <div v-if="gameCatalogue.length > 0" class="mt-4 border-t border-line pt-4">
              <div v-if="gameServersBlocked" class="limit-blocked">
                <Gamepad2 :size="17" class="shrink-0" aria-hidden="true" />
                <span>Game access is unavailable while the game-server limit is 0.</span>
              </div>
              <fieldset v-else class="space-y-3" data-game-access>
                <legend class="label">Game access</legend>
                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="game-access-card" :class="allowsAnyGame ? 'game-access-card-on' : ''">
                    <input
                      type="radio"
                      name="game-access"
                      class="sr-only"
                      :checked="allowsAnyGame"
                      data-game-access-mode="any"
                      @change="setGameAccess('any')"
                    />
                    <Gamepad2 :size="18" class="mt-0.5 shrink-0 text-brand-bright" aria-hidden="true" />
                    <span>
                      <strong class="font-medium text-ink">Any supported game</strong>
                      <span class="mt-0.5 block text-xs text-ink-faint">
                        They can choose any game when they create a server.
                      </span>
                    </span>
                  </label>
                  <label class="game-access-card" :class="!allowsAnyGame ? 'game-access-card-on' : ''">
                    <input
                      type="radio"
                      name="game-access"
                      class="sr-only"
                      :checked="!allowsAnyGame"
                      data-game-access-mode="selected"
                      @change="setGameAccess('selected')"
                    />
                    <ListChecks :size="18" class="mt-0.5 shrink-0 text-brand-bright" aria-hidden="true" />
                    <span>
                      <strong class="font-medium text-ink">Selected games</strong>
                      <span class="mt-0.5 block text-xs text-ink-faint">
                        Only the games picked below are available to them.
                      </span>
                    </span>
                  </label>

                  <div
                    v-if="!allowsAnyGame"
                    data-game-picker
                    class="rounded-lg border border-line bg-black/15 p-3 sm:col-span-2"
                  >
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span class="text-xs text-ink-faint">{{ form.gameServerProviders.length }} selected</span>
                      <button type="button" class="text-xs text-brand-bright hover:underline" @click="selectAllGames">
                        Select all supported games
                      </button>
                    </div>
                    <div class="space-y-2">
                      <input
                        v-model="gamePickerQuery"
                        class="field"
                        placeholder="Search games"
                        aria-label="Search supported games"
                      />
                      <div class="max-h-64 overflow-y-auto rounded-lg border border-line bg-black/10 p-2">
                        <label
                          v-for="entry in filteredGameCatalogue"
                          :key="entry.id"
                          class="flex items-center gap-2 rounded px-2 py-1 text-sm text-ink-muted hover:bg-white/[0.03]"
                        >
                          <input
                            type="checkbox"
                            :checked="form.gameServerProviders.includes(entry.id)"
                            @change="toggleGameProvider(entry.id)"
                          />
                          <span class="min-w-0 flex-1">{{ entry.name }}</span>
                          <span class="shrink-0 text-xs text-ink-faint">{{ entry.genre }}</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </fieldset>
            </div>
          </section>
        </div>

        <p v-if="formValidationError" class="form-error" role="alert">{{ formValidationError }}</p>

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

<style scoped>
.form-section {
  border-top: 1px solid var(--color-line);
  padding-top: 1.25rem;
}

.form-section-first {
  border-top: 0;
  padding-top: 0;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin-bottom: 1rem;
}

.section-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 1.875rem;
  height: 1.875rem;
  border: 1px solid oklch(63% 0.2 300 / 0.35);
  border-radius: 0.5rem;
  background: oklch(30% 0.085 300 / 0.5);
  color: var(--color-brand-bright);
}

.section-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-ink);
}

.section-description,
.limit-caption {
  margin-top: 0.15rem;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--color-ink-faint);
}

.limit-item {
  min-width: 0;
  border: 1px solid var(--color-line);
  border-radius: 0.625rem;
  background: oklch(0% 0 0 / 0.12);
  padding: 0.875rem;
}

.limit-mode {
  display: flex;
  gap: 0.2rem;
  margin-top: 0.75rem;
  border: 1px solid var(--color-line);
  border-radius: 0.5rem;
  background: oklch(0% 0 0 / 0.2);
  padding: 0.2rem;
}

.limit-mode-option {
  flex: 1 1 0;
  cursor: pointer;
  border-radius: 0.35rem;
  padding: 0.4rem 0.5rem;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-ink-faint);
  transition: background-color 130ms ease, color 130ms ease;
}

.limit-mode-option:hover {
  color: var(--color-ink);
}

.limit-mode-on {
  background: var(--color-brand-soft);
  color: var(--color-brand-bright);
}

.limit-mode-option:has(input:focus-visible) {
  outline: 2px solid var(--color-brand-bright);
  outline-offset: 1px;
}

.limit-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.limit-input > .field {
  min-width: 0;
}

.limit-input > span {
  flex: 0 0 auto;
  font-size: 0.75rem;
  color: var(--color-ink-muted);
}

.limit-zero,
.limit-blocked,
.form-error {
  color: var(--color-danger);
}

.limit-zero,
.limit-status {
  margin-top: 0.55rem;
  font-size: 0.75rem;
  line-height: 1.35;
}

.limit-status {
  color: var(--color-brand-bright);
}

.limit-blocked {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid oklch(71% 0.19 20 / 0.35);
  border-radius: 0.5rem;
  background: oklch(28% 0.08 20 / 0.25);
  padding: 0.75rem;
  font-size: 0.8125rem;
}

.form-error {
  border: 1px solid oklch(71% 0.19 20 / 0.35);
  border-radius: 0.5rem;
  background: oklch(28% 0.08 20 / 0.25);
  padding: 0.7rem 0.8rem;
  font-size: 0.8125rem;
}

/*
 * The two game-access options are peers, so they present as peers: same
 * width, an icon each, and a visible selected border rather than a bare radio
 * dot that reads as decoration.
 */
.game-access-card {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  cursor: pointer;
  border: 1px solid var(--color-line);
  border-radius: 0.5rem;
  background: rgb(0 0 0 / 0.15);
  padding: 0.75rem;
  font-size: 0.875rem;
  color: var(--color-ink-muted);
  transition: border-color 140ms ease, background 140ms ease;
}

.game-access-card:hover {
  border-color: var(--color-line-strong, rgb(255 255 255 / 0.22));
}

.game-access-card-on {
  border-color: var(--color-brand);
  background: rgb(0 0 0 / 0.25);
}

.game-access-card:has(input:focus-visible) {
  outline: 2px solid var(--color-brand-bright);
  outline-offset: 2px;
}
</style>
