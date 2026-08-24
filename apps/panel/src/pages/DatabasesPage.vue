<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Database,
  ExternalLink,
  Eye,
  KeyRound,
  Plug,
  Plus,
  Table2,
  Trash2,
} from 'lucide-vue-next';
import { roleAtLeast, type DatabaseConnection, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';
import DatabaseConnectionCard from '../components/DatabaseConnectionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationBar from '../components/PaginationBar.vue';

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

const PAGE_SIZE = 12;

const overview = ref<Overview | null>(null);
const engines = ref<Engines | null>(null);
const attachable = ref<Array<{ slug: string; name: string }>>([]);
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

function toggleConnection(row: Row): void {
  if (expanded.value === row.id) {
    expanded.value = null;
    expandedPassword.value = null;
    return;
  }
  expanded.value = row.id;
  expandedPassword.value = null;
}

const usable = computed(() => engines.value?.engines.filter((engine) => engine.ready) ?? []);
const chosenEngine = computed(() => usable.value.find((engine) => engine.id === newEngine.value));

const rows = computed(() => overview.value?.databases ?? []);
const paged = computed(() => rows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

const atLimit = computed(() => overview.value !== null && overview.value.problem !== null);

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
  if (!newName.value.trim() || nameProblem.value || passwordProblem.value) return;
  if (newEngine.value === '') return;

  busy.value = 'create';
  error.value = null;
  notice.value = null;

  try {
    const result = await api.databases.create.mutate({
      engine: newEngine.value,
      name: newName.value.trim(),
      ...(newSite.value ? { slug: newSite.value } : {}),
      ...(ownPassword.value && newPassword.value ? { password: newPassword.value } : {}),
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
    'Everything in it goes with it, and there is no undo. Anything still connecting ' +
    'to it will stop working.';

  if (!window.confirm(warning)) return;

  busy.value = row.id;
  error.value = null;
  notice.value = null;

  try {
    await api.databases.drop.mutate({ id: row.id });
    notice.value = `${row.name} has been removed.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function resetPassword(row: Row): Promise<void> {
  busy.value = `password:${row.id}`;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.databases.setPassword.mutate({ id: row.id });
    revealed.value = {
      name: result.name,
      username: row.username,
      password: result.password,
      generated: result.generated,
      connection: row.connection,
    };
    if (expanded.value === row.id) expandedPassword.value = result.password;
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
  <div class="max-w-6xl">
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

    <!-- A password is shown once, the moment it is made, and then gone. -->
    <AlertMessage v-if="revealed" tone="success" class="mb-4">
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

          <div v-if="attachable.length > 0" class="space-y-1">
            <label class="label" for="db-site">For a website</label>
            <select id="db-site" v-model="newSite" class="field">
              <option value="">Not tied to a website</option>
              <option v-for="site in attachable" :key="site.slug" :value="site.slug">
                {{ site.name }}
              </option>
            </select>
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

      <section v-else class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead
            class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint"
          >
            <tr>
              <th class="px-4 py-3 font-medium">Database</th>
              <th class="px-4 py-3 font-medium">Kind</th>
              <th class="px-4 py-3 font-medium">Used by</th>
              <th v-if="isAdmin" class="px-4 py-3 font-medium">Owner</th>
              <!-- w-px, or the actions column eats the spare width. -->
              <th class="w-px px-4 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>

          <tbody class="divide-y divide-line">
            <template v-for="row in paged" :key="row.id">
              <tr class="align-middle">
              <td class="max-w-xs px-4 py-3">
                <span class="block truncate font-mono text-ink">{{ row.name }}</span>
                <span class="block truncate text-xs text-ink-faint">
                  {{ row.connection.host }}:{{ row.connection.port }}
                </span>
              </td>
              <td class="px-4 py-3 text-ink-muted">{{ row.engineLabel }}</td>
              <td class="px-4 py-3">
                <RouterLink
                  v-if="row.siteSlug"
                  :to="`/sites/${row.siteSlug}`"
                  class="text-brand-bright hover:underline"
                >
                  {{ row.siteName ?? row.siteSlug }}
                </RouterLink>
                <span v-else class="text-ink-faint">Not tied to a website</span>
              </td>
              <td v-if="isAdmin" class="px-4 py-3 text-ink-muted">
                {{ row.ownerUsername ?? 'The server' }}
              </td>
              <td class="w-px whitespace-nowrap px-4 py-3">
                <div class="flex items-center justify-end gap-1">
                  <!--
                    Two browsers, one button. Adminer covers the SQL engines
                    and opens in its own tab; MongoDB is browsed inside the
                    panel, because Adminer's driver for it needs a PHP
                    extension Windows does not ship.
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
                    :disabled="busy !== null"
                    @click="showPassword(row)"
                  >
                    <Eye :size="13" aria-hidden="true" />
                    {{ busy === `reveal:${row.id}` ? 'Showing\u2026' : 'Show password' }}
                  </button>

                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="busy !== null"
                    @click="resetPassword(row)"
                  >
                    <KeyRound :size="13" aria-hidden="true" />
                    {{ busy === `password:${row.id}` ? 'Changing\u2026' : 'New password' }}
                  </button>

                  <button
                    type="button"
                    class="btn btn-danger btn-sm"
                    :disabled="busy !== null"
                    @click="drop(row)"
                  >
                    <Trash2 :size="13" aria-hidden="true" />
                    {{ busy === row.id ? 'Removing\u2026' : 'Delete' }}
                  </button>
                </div>
              </td>
            </tr>

            <!-- The connection details, under the database they belong to. -->
            <tr v-if="expanded === row.id">
              <td :colspan="isAdmin ? 5 : 4" class="px-4 pb-4">
                <DatabaseConnectionCard
                  :connection="row.connection"
                  :password="expandedPassword"
                />
              </td>
            </tr>
            </template>
          </tbody>
        </table>

        <div class="px-4 pb-4">
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
    </template>
  </div>
</template>
