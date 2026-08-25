<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  Database,
  ExternalLink,
  Eye,
  KeyRound,
  Plug,
  Plus,
  ShieldCheck,
  Table2,
  Trash2,
} from 'lucide-vue-next';
import { roleAtLeast, type DatabaseConnection, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import DatabaseAccessCard from '../../components/DatabaseAccessCard.vue';
import DatabaseConnectionCard from '../../components/DatabaseConnectionCard.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';
import SearchableSelect from '../../components/SearchableSelect.vue';

/**
 * The databases this website uses.
 *
 * The same databases as the server-wide Databases page, filtered to this site
 * — a shortcut for the common case, not a separate feature. WordPress and
 * other applications keep their content here. Each database gets its own login
 * that can reach only that database, so one site's credentials can never read
 * another's, and passwords are shown once and then live only on the server.
 */

const route = useRoute();
inject(siteContextKey);

const slug = computed(() => route.params['slug'] as string);

type Overview = Awaited<ReturnType<typeof api.databases.overview.query>>;
type Row = Overview['databases'][number];

const GB = 1024 ** 3;

const overview = ref<Overview | null>(null);
const role = ref<UserRole | null>(null);
const isAdmin = computed(() => role.value !== null && roleAtLeast(role.value, 'admin'));

const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);

// The "add a database" form.
const adding = ref(false);
const newEngine = ref<Row['engine'] | ''>('');
const newName = ref('');
const ownPassword = ref(false);
const newPassword = ref('');
const newSizeGb = ref('0');

// Shown once, then gone — the same reveal pattern as mailbox passwords.
const revealed = ref<{
  name: string;
  username: string;
  password: string;
  generated: boolean;
  connection: DatabaseConnection;
} | null>(null);

/** The database whose connection details are open, and its password if shown. */
const expanded = ref<string | null>(null);
const expandedPassword = ref<string | null>(null);
/** The database whose remote-access panel is open. */
const accessOpen = ref<string | null>(null);
const databaseToAttach = ref('');

function toggleConnection(row: Row): void {
  if (expanded.value === row.id) {
    expanded.value = null;
    expandedPassword.value = null;
    return;
  }
  expanded.value = row.id;
  expandedPassword.value = null;
}

function toggleAccess(row: Row): void {
  accessOpen.value = accessOpen.value === row.id ? null : row.id;
}

const usable = computed(() => overview.value?.engines.filter((engine) => engine.ready) ?? []);
const atLimit = computed(() => overview.value !== null && overview.value.problem !== null);
const attachableDatabases = computed(
  () =>
    overview.value?.availableDatabases.filter((database) => database.siteSlug !== slug.value) ??
    [],
);
const attachmentOptions = computed(() =>
  attachableDatabases.value.map((database) => ({
    value: database.id,
    label: database.name,
    hint: database.siteName ? `Currently used by ${database.siteName}` : 'Not tied to a website',
  })),
);

/** The same password rules as mailboxes, checked here as well as on the server. */
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

function storageBytes(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const bytes = Math.round(parsed * GB);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

const sizeProblem = computed(() => {
  const bytes = storageBytes(newSizeGb.value);
  if (bytes === null) return 'Enter zero or a positive number.';

  const quotaBytes = overview.value?.accountStorageQuotaBytes ?? 0;
  if (quotaBytes === 0) return null;
  if (bytes === 0) return 'This account has a finite storage quota, so this database needs a size.';

  const remaining = Math.max(
    0,
    quotaBytes - (overview.value?.accountStorageAllocatedBytes ?? 0),
  );
  return bytes > remaining
    ? `Only ${formatBytes(remaining)} remains of this account's database storage quota.`
    : null;
});

async function load(): Promise<void> {
  error.value = null;

  try {
    const me = await api.auth.me.query().catch(() => null);
    role.value = me?.role ?? null;
    overview.value = await api.databases.overview.query({ slug: slug.value });

    if (newEngine.value === '' && usable.value[0]) newEngine.value = usable.value[0].id;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function attachExistingDatabase(id: string): Promise<void> {
  if (!isAdmin.value || !id) return;

  const database = attachableDatabases.value.find((candidate) => candidate.id === id);
  if (!database) return;

  busy.value = `site:${id}`;
  error.value = null;
  notice.value = null;

  try {
    await api.databases.attachSite.mutate({ id, slug: slug.value });
    databaseToAttach.value = '';
    notice.value = `${database.name} is now used by this website.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
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
      slug: slug.value,
      name: newName.value.trim(),
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

async function drop(row: Row): Promise<void> {
  const warning =
    `Delete ${row.name}?\n\n` +
    'Everything in it goes with it, and there is no undo. If this website is using it, ' +
    'the website will stop working.';

  if (!window.confirm(warning)) return;

  busy.value = row.id;
  error.value = null;
  notice.value = null;

  try {
    await api.databases.drop.mutate({ id: row.id });
    notice.value = `The database ${row.name} was removed.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

/** The open "change this database's password" form, if any. */
const passwordReset = ref<{ row: Row; own: boolean; password: string } | null>(null);
const resetProblem = computed(() =>
  passwordReset.value?.own ? passwordProblemFor(passwordReset.value.password) : null,
);

function openPasswordReset(row: Row): void {
  passwordReset.value =
    passwordReset.value?.row.id === row.id ? null : { row, own: false, password: '' };
}

async function changePassword(): Promise<void> {
  const form = passwordReset.value;
  if (!form || resetProblem.value) return;
  if (form.own && form.password.length === 0) return;

  busy.value = 'password';
  error.value = null;
  notice.value = null;

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
  } catch (err) {
    error.value = describeError(err);
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

onMounted(load);
</script>

<template>
  <div class="space-y-5">
    <section class="card p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
                 bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Database :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Databases</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Databases this website can use. WordPress and other applications store their content
            here. A database's username is the same as its name.
          </p>
        </div>

        <RouterLink to="/databases" class="btn btn-ghost btn-sm shrink-0">
          All databases
        </RouterLink>
      </div>

      <AlertMessage v-if="error" tone="danger" class="mt-4">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success" class="mt-4">{{ notice }}</AlertMessage>

      <!-- A password is shown once, the moment it is made, and then gone. -->
      <AlertMessage v-if="revealed" tone="success" class="mt-4">
        <div class="space-y-3">
          <p>
            {{ revealed.name }} is ready.
            {{
              revealed.generated
                ? 'A strong password was generated for it.'
                : 'It uses the password you chose.'
            }}
            Keep these somewhere safe — the password is not shown again.
          </p>
          <DatabaseConnectionCard
            :connection="revealed.connection"
            :password="revealed.password"
            :remote-access-enabled="false"
            flush
          />
        </div>
      </AlertMessage>

      <LoadingBlock v-if="loading" class="mt-5 h-40" />

      <!-- A database server is a program like any other; offer to install one. -->
      <template v-else-if="overview && !overview.installed">
        <AlertMessage tone="warning" class="mt-4">
          <template v-if="isAdmin">
            No database server is set up on this machine yet. Install MariaDB, PostgreSQL or
            MongoDB from the Programs section of Settings, then come back here.
          </template>
          <template v-else>
            No database server is available on this server yet. Ask an administrator to
            install one.
          </template>
        </AlertMessage>
      </template>

      <template v-else-if="overview">
        <div class="mt-4 flex items-center justify-between">
          <p class="text-sm text-ink-muted">
            <template v-if="overview.limit !== null">
              {{ overview.used }} of {{ overview.limit }} databases
            </template>
            <template v-else>
              {{ overview.used }} {{ overview.used === 1 ? 'database' : 'databases' }}
            </template>
            <template v-if="overview.accountStorageQuotaBytes > 0">
              &middot; {{ formatBytes(overview.accountStorageAllocatedBytes) }} of
              {{ formatBytes(overview.accountStorageQuotaBytes) }} storage allocated
            </template>
          </p>

          <button
            v-if="!adding"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="atLimit"
            @click="adding = true"
          >
            <Plus :size="13" aria-hidden="true" /> Add a database
          </button>
        </div>

        <AlertMessage v-if="overview.problem" tone="warning" class="mt-3">
          {{ overview.problem }}
        </AlertMessage>

        <!-- The add form. -->
        <div v-if="adding" class="mt-4 space-y-3 rounded-lg border border-line bg-black/20 p-4">
          <!-- One engine installed is not a choice worth making somebody make. -->
          <div v-if="usable.length > 1">
            <label for="site-db-engine" class="label">Kind</label>
            <select id="site-db-engine" v-model="newEngine" class="field">
              <option v-for="engine in usable" :key="engine.id" :value="engine.id">
                {{ engine.label }}
              </option>
            </select>
          </div>

          <div>
            <label for="site-db-name" class="label">Name</label>
            <input id="site-db-name" v-model="newName" class="field font-mono" placeholder="shop" />
            <p v-if="nameProblem" class="mt-1 text-xs text-danger">{{ nameProblem }}</p>
            <p v-else class="hint">Lowercase letters, numbers and underscores.</p>
          </div>

          <div>
            <label for="site-db-size" class="label">Storage allowance (GB)</label>
            <input
              id="site-db-size"
              v-model="newSizeGb"
              class="field"
              inputmode="decimal"
              placeholder="0"
            />
            <p v-if="sizeProblem" class="mt-1 text-xs text-danger">{{ sizeProblem }}</p>
            <p v-else class="hint">0 allows unlimited storage.</p>
          </div>

          <label class="flex items-center gap-2 text-sm text-ink-muted">
            <input v-model="ownPassword" type="checkbox" class="h-4 w-4" />
            Choose my own password
            <span v-if="!ownPassword" class="text-ink-faint">(we'll make a strong one)</span>
          </label>

          <div v-if="ownPassword">
            <input
              v-model="newPassword"
              type="password"
              class="field font-mono"
              autocomplete="new-password"
              placeholder="At least 10 characters"
            />
            <p v-if="passwordProblem" class="mt-1 text-xs text-danger">{{ passwordProblem }}</p>
          </div>

          <div class="flex gap-2">
            <button type="button" class="btn btn-ghost btn-sm" @click="adding = false">
              Cancel
            </button>
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
        </div>

        <section
          v-if="isAdmin && attachableDatabases.length > 0"
          class="mt-4 space-y-3 rounded-lg border border-line bg-black/20 p-4"
        >
          <div>
            <h3 class="text-sm font-semibold text-ink">Use an existing database</h3>
            <p class="mt-1 text-sm text-ink-muted">
              Move a database from another website, or attach one that is not tied to a website.
            </p>
          </div>

          <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div class="min-w-0 flex-1">
              <label class="label">Database</label>
              <SearchableSelect
                v-model="databaseToAttach"
                :options="attachmentOptions"
                label="Existing database"
                placeholder="Choose a database"
                :disabled="busy !== null"
              />
            </div>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!databaseToAttach || busy !== null"
              @click="attachExistingDatabase(databaseToAttach)"
            >
              {{ busy?.startsWith('site:') ? 'Moving\u2026' : 'Use this database' }}
            </button>
          </div>
        </section>

        <!-- The list. -->
        <ul v-if="overview.databases.length > 0" class="mt-4 divide-y divide-line">
          <li v-for="row in overview.databases" :key="row.id" class="py-3">
            <div class="flex flex-wrap items-center gap-3">
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-sm text-ink">{{ row.name }}</span>
                <span class="block text-xs text-ink-faint">
                  {{ row.engineLabel }} on {{ row.connection.host }}:{{ row.connection.port }}
                </span>
                <span class="mt-0.5 block text-xs text-ink-faint">
                  {{ row.sizeBytes == null ? 'Usage unavailable' : `${formatBytes(row.sizeBytes)} used` }}
                  &middot;
                  {{ !row.sizeLimitBytes ? 'No storage limit' : `${formatBytes(row.sizeLimitBytes)} allowance` }}
                </span>
              </span>

              <!-- Opens signed in: Adminer in its own tab for the SQL engines,
                   the panel's own browser for MongoDB. -->
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
                :disabled="busy !== null"
                :aria-expanded="passwordReset?.row.id === row.id"
                @click="openPasswordReset(row)"
              >
                <KeyRound :size="13" aria-hidden="true" /> Password
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy !== null"
                @click="showPassword(row)"
              >
                <Eye :size="13" aria-hidden="true" />
                {{ busy === `reveal:${row.id}` ? 'Showing\u2026' : 'Show' }}
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                :disabled="busy !== null"
                @click="drop(row)"
              >
                <Trash2 :size="13" aria-hidden="true" />
                {{ busy === row.id ? 'Removing\u2026' : 'Remove' }}
              </button>
            </div>

            <DatabaseConnectionCard
              v-if="expanded === row.id"
              class="mt-3"
              :connection="row.connection"
              :password="expandedPassword"
              :remote-access-enabled="row.network.mode !== 'loopback'"
            />

            <DatabaseAccessCard
              v-if="accessOpen === row.id"
              class="mt-3"
              :database-id="row.id"
              :name="row.name"
              @saved="load"
            />
          </li>
        </ul>

        <!-- The change-password form, under the database it belongs to. -->
        <form
          v-if="passwordReset"
          class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-black/20 p-4"
          @submit.prevent="changePassword"
        >
          <div>
            <label for="db-reset-mode" class="label">
              New password for {{ passwordReset.row.name }}
            </label>
            <select id="db-reset-mode" v-model="passwordReset.own" class="field w-40">
              <option :value="false">Generate one</option>
              <option :value="true">Set my own</option>
            </select>
          </div>

          <div v-if="passwordReset.own">
            <label for="db-reset-password" class="label">Chosen password</label>
            <input
              id="db-reset-password"
              v-model="passwordReset.password"
              type="password"
              class="field w-56 font-mono"
              autocomplete="new-password"
              placeholder="At least 10 characters"
            />
          </div>

          <button
            type="submit"
            class="btn btn-primary btn-sm"
            :disabled="
              busy !== null ||
              resetProblem !== null ||
              (passwordReset.own && passwordReset.password.length === 0)
            "
          >
            {{ busy === 'password' ? 'Saving\u2026' : 'Change password' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="passwordReset = null">
            Cancel
          </button>

          <p v-if="resetProblem" class="w-full text-sm text-danger">{{ resetProblem }}</p>
          <p v-else class="hint w-full">
            The old password stops working as soon as this is saved. A WordPress site's
            configuration is updated for you; anything else connecting with the old password
            will need the new one.
          </p>
        </form>

        <p v-else-if="!adding && overview.databases.length === 0" class="mt-4 text-sm text-ink-faint">
          No databases yet. WordPress creates its own when you add a WordPress site; add one
          here for anything else.
        </p>
      </template>
    </section>
  </div>
</template>
