<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Plug,
  Plus,
  ShieldCheck,
  Table2,
  Trash2,
} from 'lucide-vue-next';
import { roleAtLeast, type DatabaseConnection, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { formatBytes } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DatabaseAccessCard from '../components/DatabaseAccessCard.vue';
import DatabaseConnectionCard from '../components/DatabaseConnectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationBar from '../components/PaginationBar.vue';
import PasswordConfirmDialog from '../components/PasswordConfirmDialog.vue';
import SearchableSelect from '../components/SearchableSelect.vue';

/**
 * Every database on the server, in one place.
 *
 * The page exists because a database is not a property of a website. Plenty of
 * what people self-host is not a website on this machine at all — a bot, a
 * mobile app's backend, something on another box entirely — and all of it
 * still needs somewhere to put its data. Databases that do belong to a website
 * appear here too, labelled with it, so this is the complete picture and the
 * website tab is the shortcut rather than the other way round.
 *
 * Nothing is shown for an engine the server does not have. The whole page is
 * hidden from the sidebar until at least one is installed.
 */

type Overview = Awaited<ReturnType<typeof api.databases.listAll.query>>;
type Engines = Awaited<ReturnType<typeof api.databases.engines.query>>;
type Row = Overview['databases'][number];
type AttachableSite = Awaited<ReturnType<typeof api.databases.attachableSites.query>>[number];

const PAGE_SIZE = 12;
const GB = 1024 ** 3;

const overview = ref<Overview | null>(null);
const engines = ref<Engines | null>(null);
const attachable = ref<AttachableSite[]>([]);
const role = ref<UserRole | null>(null);
const isAdmin = computed(() => role.value !== null && roleAtLeast(role.value, 'admin'));

const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);
const page = ref(1);

// The "add a database" form.
const adding = ref(false);
const newEngine = ref<Row['engine'] | ''>('');
const newName = ref('');
const newSite = ref('');
const ownPassword = ref(false);
const newPassword = ref('');
const newSizeGb = ref('0');

// Shown once, the moment it is made, and then gone.
const revealed = ref<{
  name: string;
  username: string;
  password: string;
  generated: boolean;
  connection: DatabaseConnection;
} | null>(null);

/**
 * The row whose connection details are open.
 *
 * Kept open across a reveal, so pressing Show fills the password into the
 * connection string in front of you rather than replacing the block with an
 * alert somewhere else on the page.
 */
const expanded = ref<string | null>(null);
/** The password revealed for the expanded row, if it has been. */
const expandedPassword = ref<string | null>(null);
/** The row whose remote-access panel is open. */
const accessOpen = ref<string | null>(null);
const sizeOpen = ref<string | null>(null);
const sizeLimitGb = ref('0');
const databaseToDelete = ref<Row | null>(null);
const deletePasswordError = ref<string | null>(null);
const passwordReset = ref<{ row: Row; own: boolean; password: string } | null>(null);
const passwordChangeConfirmationOpen = ref(false);
const passwordResetError = ref<string | null>(null);

function toggleConnection(row: Row): void {
  if (expanded.value === row.id) {
    expanded.value = null;
    expandedPassword.value = null;
    return;
  }
  expanded.value = row.id;
  expandedPassword.value = null;
}

function passwordIsVisible(row: Row): boolean {
  return expanded.value === row.id && expandedPassword.value !== null;
}

function toggleAccess(row: Row): void {
  accessOpen.value = accessOpen.value === row.id ? null : row.id;
}

function openSize(row: Row): void {
  if (sizeOpen.value === row.id) {
    sizeOpen.value = null;
    return;
  }
  sizeOpen.value = row.id;
  sizeLimitGb.value = String((row.sizeLimitBytes ?? 0) / GB);
}

/**
 * The websites this database could be tied to.
 *
 * Its current one is included even when it is not otherwise on offer, so the
 * dropdown always shows where the database actually is.
 */
function siteOptions(row: Row): Array<{ slug: string; name: string }> {
  const options = attachable.value.map((site) => ({ slug: site.slug, name: site.name }));
  if (row.siteSlug && !options.some((option) => option.slug === row.siteSlug)) {
    options.unshift({ slug: row.siteSlug, name: row.siteName ?? row.siteSlug });
  }
  return options.sort((left, right) => left.name.localeCompare(right.name));
}

const attachableOptions = computed(() => [
  { value: '', label: 'Not tied to a website' },
  ...[...attachable.value]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((site) => ({ value: site.slug, label: site.name })),
]);

function sitePickerOptions(row: Row) {
  return [
    { value: '', label: 'Not tied to a website' },
    ...siteOptions(row).map((site) => ({ value: site.slug, label: site.name })),
  ];
}

const usable = computed(() => engines.value?.engines.filter((engine) => engine.ready) ?? []);
const chosenEngine = computed(() => usable.value.find((engine) => engine.id === newEngine.value));

const rows = computed(() => overview.value?.databases ?? []);
const paged = computed(() => rows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

const atLimit = computed(() => overview.value !== null && overview.value.problem !== null);

function storageBytes(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const bytes = Math.round(parsed * GB);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

const creationStorage = computed(() => {
  if (newSite.value) {
    const site = attachable.value.find((entry) => entry.slug === newSite.value);
    if (site) {
      return {
        quotaBytes: site.storageQuotaBytes,
        allocatedBytes: site.storageAllocatedBytes,
      };
    }
  }
  return {
    quotaBytes: overview.value?.storageQuotaBytes ?? 0,
    allocatedBytes: overview.value?.storageAllocatedBytes ?? 0,
  };
});

const sizeProblem = computed(() => {
  const bytes = storageBytes(newSizeGb.value);
  if (bytes === null) return 'Enter zero or a positive number.';

  const storage = creationStorage.value;
  if (storage.quotaBytes === 0) return null;
  if (bytes === 0) return 'This owner has a finite storage quota, so this database needs a size.';

  const remaining = Math.max(0, storage.quotaBytes - storage.allocatedBytes);
  return bytes > remaining
    ? `Only ${formatBytes(remaining)} remains of this owner's database storage quota.`
    : null;
});

function describeStorage(row: Row): string {
  const used = row.sizeBytes == null ? 'Usage unavailable' : `${formatBytes(row.sizeBytes)} used`;
  return !row.sizeLimitBytes
    ? `${used}, no limit`
    : `${used} of ${formatBytes(row.sizeLimitBytes)}`;
}

/** The same password rules as everywhere else, checked here as well as on the server. */
function passwordProblemFor(value: string): string | null {
  if (value.length === 0) return null;
  if (value.length < 10) return 'Use at least 10 characters.';
  if (value.trim() !== value) {
    return 'A space at the start or end is too easy to lose when it is typed again.';
  }
  return null;
}

const passwordProblem = computed(() =>
  ownPassword.value ? passwordProblemFor(newPassword.value) : null,
);

const nameProblem = computed(() => {
  const value = newName.value.trim();
  if (value.length === 0) return null;
  if (!/^[a-z0-9_]+$/.test(value)) return 'Lowercase letters, numbers and underscores only.';
  if (value.length > 24) return 'Keep it to 24 characters or fewer.';
  return null;
});

async function load(): Promise<void> {
  error.value = null;

  try {
    const [me, engineList, list, siteList] = await Promise.all([
      api.auth.me.query().catch(() => null),
      api.databases.engines.query(),
      api.databases.listAll.query(),
      api.databases.attachableSites.query().catch(() => []),
    ]);

    role.value = me?.role ?? null;
    engines.value = engineList;
    overview.value = list;
    attachable.value = siteList;

    if (newEngine.value === '' && engineList.engines[0]) {
      newEngine.value = engineList.engines[0].id;
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!newName.value.trim() || nameProblem.value || passwordProblem.value || sizeProblem.value) return;
  if (newEngine.value === '') return;
  const sizeLimitBytes = storageBytes(newSizeGb.value);
  if (sizeLimitBytes === null) return;

  busy.value = 'create';
  error.value = null;
  notice.value = null;

  try {
    const result = await api.databases.create.mutate({
      engine: newEngine.value,
      name: newName.value.trim(),
      ...(newSite.value ? { slug: newSite.value } : {}),
      ...(ownPassword.value && newPassword.value ? { password: newPassword.value } : {}),
      sizeLimitBytes,
    });

    revealed.value = {
      name: result.name,
      username: result.username,
      password: result.password,
      generated: result.generated,
      connection: result.connection,
    };

    adding.value = false;
    newName.value = '';
    newPassword.value = '';
    newSizeGb.value = '0';
    ownPassword.value = false;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function saveSize(row: Row): Promise<void> {
  const sizeLimitBytes = storageBytes(sizeLimitGb.value);
  if (sizeLimitBytes === null) return;

  busy.value = `size:${row.id}`;
  error.value = null;
  notice.value = null;

  try {
    await api.databases.setSizeLimit.mutate({ id: row.id, sizeLimitBytes });
    notice.value = `${row.name} now has ${sizeLimitBytes === 0 ? 'unlimited storage' : `${formatBytes(sizeLimitBytes)} of storage`}.`;
    sizeOpen.value = null;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

function requestDrop(row: Row): void {
  databaseToDelete.value = row;
  deletePasswordError.value = null;
}

function closeDrop(): void {
  if (busy.value === databaseToDelete.value?.id) return;
  databaseToDelete.value = null;
  deletePasswordError.value = null;
}

async function confirmDrop(password: string): Promise<void> {
  const row = databaseToDelete.value;
  if (!row) return;

  busy.value = row.id;
  error.value = null;
  notice.value = null;
  deletePasswordError.value = null;

  try {
    await api.databases.drop.mutate({ id: row.id, password });
    databaseToDelete.value = null;
    notice.value = `${row.name} has been removed.`;
    await load();
  } catch (err) {
    deletePasswordError.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

const resetProblem = computed(() =>
  passwordReset.value?.own ? passwordProblemFor(passwordReset.value.password) : null,
);

const passwordResetDescription = computed(() => {
  const form = passwordReset.value;
  if (!form) return '';
  const replacement = form.own ? 'The password you entered' : 'A new strong password';
  return `${replacement} will replace the current password for ${form.row.name}. Anything using the old password will need to be updated.`;
});

function openPasswordReset(row: Row): void {
  passwordReset.value =
    passwordReset.value?.row.id === row.id ? null : { row, own: false, password: '' };
  passwordChangeConfirmationOpen.value = false;
  passwordResetError.value = null;
}

function closePasswordResetForm(): void {
  if (busy.value !== null) return;
  passwordReset.value = null;
  passwordChangeConfirmationOpen.value = false;
  passwordResetError.value = null;
}

function requestPasswordChange(): void {
  const form = passwordReset.value;
  if (
    !form ||
    resetProblem.value ||
    (form.own && form.password.length === 0) ||
    busy.value !== null
  ) {
    return;
  }
  passwordResetError.value = null;
  passwordChangeConfirmationOpen.value = true;
}

function closePasswordChangeConfirmation(): void {
  if (busy.value === `password:${passwordReset.value?.row.id}`) return;
  passwordChangeConfirmationOpen.value = false;
  passwordResetError.value = null;
}

async function changePassword(): Promise<void> {
  const form = passwordReset.value;
  if (!form || resetProblem.value || (form.own && form.password.length === 0)) return;

  busy.value = `password:${form.row.id}`;
  error.value = null;
  notice.value = null;
  passwordResetError.value = null;

  try {
    const result = await api.databases.setPassword.mutate({
      id: form.row.id,
      ...(form.own ? { password: form.password } : {}),
    });
    revealed.value = {
      name: result.name,
      username: form.row.username,
      password: result.password,
      generated: result.generated,
      connection: form.row.connection,
    };
    if (expanded.value === form.row.id) expandedPassword.value = result.password;
    passwordReset.value = null;
    passwordChangeConfirmationOpen.value = false;
  } catch (err) {
    passwordResetError.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function showPassword(row: Row): Promise<void> {
  busy.value = `reveal:${row.id}`;
  error.value = null;

  try {
    const result = await api.databases.revealPassword.query({ id: row.id });
    // Opening the connection block is the useful half of "show me the
    // password": on its own it is a string with nowhere to go.
    expanded.value = row.id;
    expandedPassword.value = result.password;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function togglePassword(row: Row): Promise<void> {
  if (passwordIsVisible(row)) {
    expandedPassword.value = null;
    return;
  }
  await showPassword(row);
}

/**
 * Ties a database to a website, or unties it.
 *
 * Which website a database serves is not decided once and for ever: projects
 * get renamed, rebuilt and moved between sites, and before this the only way
 * to correct the choice made at creation was to delete the database.
 */
async function attachSite(row: Row, slug: string): Promise<void> {
  busy.value = `site:${row.id}`;
  error.value = null;
  notice.value = null;

  try {
    await api.databases.attachSite.mutate({ id: row.id, slug: slug === '' ? null : slug });
    notice.value =
      slug === ''
        ? `${row.name} is no longer tied to a website.`
        : `${row.name} is now used by ${siteOptions(row).find((site) => site.slug === slug)?.name ?? slug}.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Databases"
      description="Where your applications keep their data. Each database gets its own login that
                   can reach only that database, so one project's credentials can never read
                   another's."
    >
      <template #actions>
        <button
          v-if="usable.length > 0 && !adding"
          type="button"
          class="btn btn-primary"
          :disabled="atLimit"
          @click="adding = true"
        >
          <Plus :size="15" aria-hidden="true" /> Add a database
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" tone="danger" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <AlertMessage
      v-if="revealed"
      tone="success"
      title="Database ready"
      class="mb-4"
      dismissible
      @dismiss="revealed = null"
    >
      <div class="space-y-3">
        <p>
          {{ revealed.name }} is ready.
          {{
            revealed.generated
              ? 'A strong password was generated for it.'
              : 'It uses the password you chose.'
          }}
          The password is visible below now. Save these connection details somewhere secure; you
          can reveal the password again later with <strong>Show password</strong>.
        </p>
        <DatabaseConnectionCard
          :connection="revealed.connection"
          :password="revealed.password"
          :remote-access-enabled="false"
          flush
        />
      </div>
    </AlertMessage>

    <LoadingBlock v-if="loading" class="h-64 rounded-card bg-surface" />

    <template v-else>
      <!--
        Installed but half-finished. Worth saying on its own: "install it" is
        the wrong advice for a server that is already there.
      -->
      <AlertMessage v-if="engines && engines.unfinished.length > 0" tone="warning" class="mb-4">
        {{ engines.unfinished.join(' and ') }}
        {{ engines.unfinished.length === 1 ? 'is' : 'are' }} installed but did not finish setting
        up, so {{ engines.unfinished.length === 1 ? 'it cannot' : 'they cannot' }} be used yet.
        <template v-if="isAdmin">
          Reinstall from the Programs section of Settings.
        </template>
      </AlertMessage>

      <AlertMessage v-if="overview?.problem" tone="warning" class="mb-4">
        {{ overview.problem }}
      </AlertMessage>

      <!-- The add form. -->
      <section v-if="adding" class="card mb-5 space-y-4 p-5">
        <h3 class="text-sm font-semibold text-ink">New database</h3>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label class="label" for="db-engine">Kind</label>
            <select id="db-engine" v-model="newEngine" class="field">
              <option v-for="engine in usable" :key="engine.id" :value="engine.id">
                {{ engine.label }}
              </option>
            </select>
            <p class="hint">{{ chosenEngine?.description ?? '' }}</p>
          </div>

          <div class="space-y-1">
            <label class="label" for="db-name">Name</label>
            <input id="db-name" v-model="newName" class="field font-mono" placeholder="shop" />
            <p v-if="nameProblem" class="mt-1 text-xs text-danger">{{ nameProblem }}</p>
            <p v-else class="hint">
              The full name gets a prefix, so it can never collide with somebody else's.
            </p>
          </div>

          <div class="space-y-1">
            <label class="label" for="db-size">Storage allowance (GB)</label>
            <input
              id="db-size"
              v-model="newSizeGb"
              class="field"
              inputmode="decimal"
              placeholder="0"
            />
            <p v-if="sizeProblem" class="mt-1 text-xs text-danger">{{ sizeProblem }}</p>
            <p v-else class="hint">0 allows unlimited storage.</p>
          </div>

          <div v-if="isAdmin && attachable.length > 0" class="space-y-1">
            <label class="label" for="db-site">For a website</label>
            <SearchableSelect
              v-model="newSite"
              :options="attachableOptions"
              label="Website for new database"
              placeholder="Not tied to a website"
            />
            <p class="hint">
              A database made for a website shows up on that website's Databases tab too.
            </p>
          </div>

          <div class="space-y-1">
            <label class="label" for="db-password-mode">Password</label>
            <select id="db-password-mode" v-model="ownPassword" class="field">
              <option :value="false">Generate a strong one</option>
              <option :value="true">Set my own</option>
            </select>
            <input
              v-if="ownPassword"
              v-model="newPassword"
              type="password"
              class="field mt-2 font-mono"
              autocomplete="new-password"
              placeholder="At least 10 characters"
            />
            <p v-if="passwordProblem" class="mt-1 text-xs text-danger">{{ passwordProblem }}</p>
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="adding = false">Cancel</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="
              !newName.trim() ||
              newEngine === '' ||
              nameProblem !== null ||
              passwordProblem !== null ||
              sizeProblem !== null ||
              busy === 'create'
            "
            @click="create"
          >
            {{ busy === 'create' ? 'Creating\u2026' : 'Create database' }}
          </button>
        </div>
      </section>

      <!--
        No engine at all. Only reachable by typing the address, since the
        sidebar hides this page until one is installed — but somebody who
        bookmarked it deserves an explanation rather than an empty table.
      -->
      <EmptyState
        v-if="!engines || engines.engines.length === 0"
        :icon="Database"
        title="No database server yet"
        :description="
          isAdmin
            ? 'Install MariaDB, PostgreSQL or MongoDB from the Programs section of Settings, and ' +
              'this page fills itself in.'
            : 'This server does not run a database yet. Ask your administrator to add one.'
        "
      >
        <RouterLink v-if="isAdmin" to="/settings" class="btn btn-primary mt-5">
          Open Settings
        </RouterLink>
      </EmptyState>

      <EmptyState
        v-else-if="rows.length === 0"
        :icon="Database"
        title="No databases yet"
        description="Create one and you will be shown its name, username and password. Point your
                     application at those and it has somewhere to keep its data."
        :action-label="atLimit ? undefined : 'Add a database'"
        @action="adding = true"
      />

      <section v-else class="space-y-3">
        <article v-for="row in paged" :key="row.id" class="card overflow-visible">
          <div
            class="grid gap-4 p-4 sm:grid-cols-2 lg:items-center"
            :class="
              isAdmin
                ? 'lg:grid-cols-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(7rem,0.6fr)_minmax(10rem,0.9fr)_minmax(11rem,1fr)_minmax(8rem,0.7fr)]'
                : 'lg:grid-cols-[minmax(0,1.5fr)_minmax(7rem,0.6fr)_minmax(10rem,0.9fr)]'
            "
          >
            <div class="min-w-0">
              <span class="block truncate font-mono font-medium text-ink">{{ row.name }}</span>
              <span class="mt-1 block truncate font-mono text-xs text-ink-faint">
                {{ row.connection.host }}:{{ row.connection.port }}
              </span>
            </div>

            <div>
              <span class="label mb-1 block">Kind</span>
              <span class="text-sm text-ink-muted">{{ row.engineLabel }}</span>
            </div>

            <div>
              <span class="label mb-1 block">Storage</span>
              <span class="text-sm text-ink-muted">{{ describeStorage(row) }}</span>
            </div>

            <div v-if="isAdmin" class="min-w-0">
              <span class="label mb-1 block">Used by</span>
              <SearchableSelect
                v-if="siteOptions(row).length > 0"
                :model-value="row.siteSlug ?? ''"
                :options="sitePickerOptions(row)"
                :disabled="busy !== null"
                :label="`Website using ${row.name}`"
                @update:model-value="attachSite(row, $event)"
              />
              <RouterLink
                v-else-if="row.siteSlug"
                :to="`/sites/${row.siteSlug}`"
                class="text-sm text-brand-bright hover:underline"
              >
                {{ row.siteName ?? row.siteSlug }}
              </RouterLink>
              <span v-else class="text-sm text-ink-faint">Not tied to a website</span>
            </div>

            <div v-if="isAdmin" class="min-w-0">
              <span class="label mb-1 block">Owner</span>
              <span class="block truncate text-sm text-ink-muted">
                {{ row.ownerUsername ?? 'The server' }}
              </span>
            </div>
          </div>

          <div class="flex flex-wrap gap-2 border-t border-line bg-black/10 p-3">
            <!--
              Two browsers, one button. Adminer covers the SQL engines and
              opens in its own tab; MongoDB is browsed inside the panel.
            -->
            <a
              v-if="row.browser === 'adminer'"
              :href="`/db/${encodeURIComponent(row.id)}`"
              target="_blank"
              rel="noopener"
              class="btn btn-ghost btn-sm"
            >
              <ExternalLink :size="13" aria-hidden="true" /> Open
            </a>
            <RouterLink v-else :to="`/databases/${row.id}/browse`" class="btn btn-ghost btn-sm">
              <Table2 :size="13" aria-hidden="true" /> Open
            </RouterLink>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-expanded="expanded === row.id"
              @click="toggleConnection(row)"
            >
              <Plug :size="13" aria-hidden="true" /> Connect
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-expanded="accessOpen === row.id"
              @click="toggleAccess(row)"
            >
              <ShieldCheck :size="13" aria-hidden="true" />
              {{ row.network.mode === 'loopback' ? 'Remote access' : 'Remote access on' }}
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-expanded="sizeOpen === row.id"
              @click="openSize(row)"
            >
              <HardDrive :size="13" aria-hidden="true" /> Storage
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null"
              :aria-pressed="passwordIsVisible(row)"
              @click="togglePassword(row)"
            >
              <component
                :is="passwordIsVisible(row) ? EyeOff : Eye"
                :size="13"
                aria-hidden="true"
              />
              {{
                busy === `reveal:${row.id}`
                  ? 'Showing\u2026'
                  : passwordIsVisible(row)
                    ? 'Hide password'
                    : 'Show password'
              }}
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null"
              :aria-expanded="passwordReset?.row.id === row.id"
              @click="openPasswordReset(row)"
            >
              <KeyRound :size="13" aria-hidden="true" />
              {{ busy === `password:${row.id}` ? 'Changing\u2026' : 'New password' }}
            </button>

            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="busy !== null"
              @click="requestDrop(row)"
            >
              <Trash2 :size="13" aria-hidden="true" />
              {{ busy === row.id ? 'Removing\u2026' : 'Delete' }}
            </button>
          </div>

          <div v-if="sizeOpen === row.id" class="border-t border-line px-4 pb-4 pt-3">
            <div class="max-w-md space-y-3">
              <div>
                <label class="label" :for="`db-size-${row.id}`">Storage allowance (GB)</label>
                <input
                  :id="`db-size-${row.id}`"
                  v-model="sizeLimitGb"
                  class="field mt-1"
                  inputmode="decimal"
                />
                <p class="hint">
                  {{ row.sizeBytes == null ? 'Current usage is unavailable.' : `${formatBytes(row.sizeBytes)} currently used.` }}
                  0 allows unlimited storage.
                </p>
              </div>
              <div class="flex gap-2">
                <button type="button" class="btn btn-ghost btn-sm" @click="sizeOpen = null">
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="storageBytes(sizeLimitGb) === null || busy !== null"
                  @click="saveSize(row)"
                >
                  {{ busy === `size:${row.id}` ? 'Saving\u2026' : 'Save allowance' }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="expanded === row.id" class="border-t border-line px-4 pb-4 pt-3">
            <DatabaseConnectionCard
              :connection="row.connection"
              :password="expandedPassword"
              :remote-access-enabled="row.network.mode !== 'loopback'"
            />
          </div>

          <div v-if="accessOpen === row.id" class="border-t border-line px-4 pb-4 pt-3">
            <DatabaseAccessCard :database-id="row.id" :name="row.name" @saved="load" />
          </div>

          <div v-if="passwordReset?.row.id === row.id" class="border-t border-line px-4 pb-4 pt-3">
            <form class="max-w-2xl space-y-3" @submit.prevent="requestPasswordChange">
              <div class="flex flex-wrap items-end gap-3">
                <div>
                  <label class="label" :for="`db-reset-mode-${row.id}`">
                    New password for {{ row.name }}
                  </label>
                  <select
                    :id="`db-reset-mode-${row.id}`"
                    v-model="passwordReset.own"
                    class="field w-48"
                  >
                    <option :value="false">Generate one</option>
                    <option :value="true">Set my own</option>
                  </select>
                </div>

                <div v-if="passwordReset.own">
                  <label class="label" :for="`db-reset-password-${row.id}`">Chosen password</label>
                  <input
                    :id="`db-reset-password-${row.id}`"
                    v-model="passwordReset.password"
                    type="password"
                    class="field w-56 font-mono"
                    autocomplete="new-password"
                    placeholder="At least 10 characters"
                  />
                </div>

                <div class="flex gap-2">
                  <button
                    type="submit"
                    class="btn btn-primary btn-sm"
                    :disabled="
                      busy !== null ||
                      resetProblem !== null ||
                      (passwordReset.own && passwordReset.password.length === 0)
                    "
                  >
                    {{ busy === `password:${row.id}` ? 'Saving...' : 'Review change' }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="busy !== null"
                    @click="closePasswordResetForm"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              <p v-if="resetProblem" class="text-sm text-danger">{{ resetProblem }}</p>
              <p v-else class="hint">
                The old password stops working as soon as this is saved. Anything connecting with
                it will need the new password.
              </p>
            </form>
          </div>
        </article>

        <div class="px-1 pt-1">
          <PaginationBar
            v-model:page="page"
            :total="rows.length"
            :page-size="PAGE_SIZE"
            noun="databases"
          />
        </div>
      </section>

      <p v-if="overview && overview.limit !== null" class="mt-4 text-xs text-ink-faint">
        {{ overview.used }} of {{ overview.limit }} databases used on this account.
      </p>
      <p
        v-if="overview && overview.storageQuotaBytes > 0"
        class="mt-1 text-xs text-ink-faint"
      >
        {{ formatBytes(overview.storageAllocatedBytes) }} of
        {{ formatBytes(overview.storageQuotaBytes) }} database storage allocated.
      </p>
    </template>

    <PasswordConfirmDialog
      :open="databaseToDelete !== null"
      title="Delete database?"
      :description="
        `Everything in ${databaseToDelete?.name ?? 'this database'} will be permanently removed, and anything connecting to it will stop working.`
      "
      confirm-label="Delete database"
      :busy="busy === databaseToDelete?.id"
      :error="deletePasswordError"
      @close="closeDrop"
      @confirm="confirmDrop"
    />

    <ConfirmDialog
      :open="passwordChangeConfirmationOpen"
      title="Set a new database password?"
      :description="passwordResetDescription"
      confirm-label="Set new password"
      busy-label="Setting password..."
      :busy="busy === `password:${passwordReset?.row.id}`"
      :error="passwordResetError"
      @close="closePasswordChangeConfirmation"
      @confirm="changePassword"
    />
  </div>
</template>
