<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Copy, Database, ExternalLink, Eye, KeyRound, Plus, Trash2 } from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { useRuntimeStatus } from '../../lib/runtime-status';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';

/**
 * The databases a website can use.
 *
 * WordPress and other apps store their content here. Each database gets its
 * own login that can reach only that database, so one site's credentials can
 * never read another's. Passwords are shown once — when they are made — and
 * then live only on the server.
 */

const route = useRoute();
inject(siteContextKey);

const slug = computed(() => route.params['slug'] as string);

// The "Open" browser button only makes sense when the browser is installed.
const { has } = useRuntimeStatus();
const browserAvailable = computed(() => has('adminer'));

type Overview = Awaited<ReturnType<typeof api.databases.overview.query>>;

const overview = ref<Overview | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);

// The "add a database" form.
const adding = ref(false);
const newName = ref('');
const ownPassword = ref(false);
const newPassword = ref('');

// Shown once, then gone — the same reveal pattern as mailbox passwords.
const revealed = ref<{ name: string; password: string; generated: boolean } | null>(null);
const copied = ref(false);

// The open "change this database's password" form, if any.
const passwordReset = ref<{ name: string; own: boolean; password: string } | null>(null);
const resetProblem = computed(() =>
  passwordReset.value?.own ? passwordProblemFor(passwordReset.value.password) : null,
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

const atLimit = computed(
  () => overview.value?.limit !== null && overview.value !== null && overview.value.used >= (overview.value.limit ?? Infinity),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    overview.value = await api.databases.overview.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!newName.value.trim() || passwordProblem.value) return;

  busy.value = 'create';
  error.value = null;
  notice.value = null;

  try {
    const result = await api.databases.create.mutate({
      slug: slug.value,
      name: newName.value.trim(),
      ...(ownPassword.value && newPassword.value ? { password: newPassword.value } : {}),
    });

    revealed.value = { name: result.name, password: result.password, generated: result.generated };
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

async function drop(name: string): Promise<void> {
  busy.value = name;
  error.value = null;

  try {
    await api.databases.drop.mutate({ slug: slug.value, name });
    notice.value = `The database ${name} was removed.`;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

function openPasswordReset(name: string): void {
  passwordReset.value =
    passwordReset.value?.name === name ? null : { name, own: false, password: '' };
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
      slug: slug.value,
      name: form.name,
      password: form.own ? form.password : undefined,
    });
    revealed.value = { name: result.name, password: result.password, generated: result.generated };
    passwordReset.value = null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function showPassword(name: string): Promise<void> {
  busy.value = `reveal:${name}`;
  error.value = null;

  try {
    const result = await api.databases.revealPassword.query({ slug: slug.value, name });
    revealed.value = { name, password: result.password, generated: false };
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function copyPassword(): Promise<void> {
  if (!revealed.value) return;

  try {
    await navigator.clipboard.writeText(revealed.value.password);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be refused; the password is on screen to be read.
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-5">
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
            Databases this website can use. WordPress and other apps store their content here.
            A database's username is the same as its name.
          </p>
        </div>
      </div>

      <AlertMessage v-if="error" tone="danger" class="mt-4">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success" class="mt-4">{{ notice }}</AlertMessage>

      <!-- A password is shown once, the moment it is made, and then gone. -->
      <AlertMessage v-if="revealed" tone="success" class="mt-4">
        <div class="space-y-2">
          <p>
            {{ revealed.generated ? 'A password was generated' : 'The password was set' }}
            for this database. Wherever you sign in with it — the database browser,
            WordPress, another app — the username is the same as the database name.
          </p>
          <dl class="space-y-1.5 text-sm">
            <div class="flex items-baseline gap-2">
              <dt class="w-20 shrink-0 text-ink-muted">Database</dt>
              <dd class="font-mono text-ink">{{ revealed.name }}</dd>
            </div>
            <div class="flex items-baseline gap-2">
              <dt class="w-20 shrink-0 text-ink-muted">Username</dt>
              <dd class="font-mono text-ink">{{ revealed.name }}</dd>
            </div>
            <div class="flex items-center gap-2">
              <dt class="w-20 shrink-0 text-ink-muted">Password</dt>
              <dd class="min-w-0 flex-1">
                <code class="block truncate rounded-md bg-black/30 px-2 py-1 font-mono text-xs">
                  {{ revealed.password }}
                </code>
              </dd>
              <button type="button" class="btn btn-ghost btn-sm" @click="copyPassword">
                <Copy :size="13" aria-hidden="true" /> {{ copied ? 'Copied' : 'Copy' }}
              </button>
            </div>
          </dl>
          <p class="text-xs">Keep the password somewhere safe — it is not shown again.</p>
        </div>
      </AlertMessage>

      <LoadingBlock v-if="loading" class="mt-5 h-40" />

      <!-- The database server is a program like any other; offer to install it. -->
      <template v-else-if="overview && !overview.installed">
        <AlertMessage tone="warning" class="mt-4">
          The database server isn't installed yet. Install the "Database server (MariaDB)"
          program from the Programs section of Settings, then come back here.
        </AlertMessage>
      </template>

      <template v-else-if="overview">
        <div class="mt-4 flex items-center justify-between">
          <p class="text-sm text-ink-muted">
            <template v-if="overview.limit !== null">
              {{ overview.used }} of {{ overview.limit }} databases
            </template>
            <template v-else>{{ overview.used }} {{ overview.used === 1 ? 'database' : 'databases' }}</template>
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

        <AlertMessage v-if="atLimit" tone="warning" class="mt-3">
          This website has reached its database limit. Remove one, or ask your administrator
          to raise the limit.
        </AlertMessage>

        <!-- The add form. -->
        <div v-if="adding" class="mt-4 space-y-3 rounded-lg border border-line bg-black/20 p-4">
          <div>
            <label for="db-name" class="label">Name</label>
            <input
              id="db-name"
              v-model="newName"
              class="field font-mono"
              placeholder="shop"
            />
            <p class="hint">Lowercase letters, numbers and underscores.</p>
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
              :disabled="!newName.trim() || Boolean(passwordProblem) || busy === 'create'"
              @click="create"
            >
              {{ busy === 'create' ? 'Creating…' : 'Create database' }}
            </button>
          </div>
        </div>

        <!-- The list. -->
        <ul v-if="overview.databases.length > 0" class="mt-4 divide-y divide-line">
          <li
            v-for="db in overview.databases"
            :key="db.name"
            class="flex flex-wrap items-center gap-3 py-3"
          >
            <span class="min-w-0 flex-1 font-mono text-sm text-ink">{{ db.name }}</span>
            <!-- Opens the database browser in a new tab, signed in — offered
                 only when the browser is actually installed. -->
            <a
              v-if="browserAvailable"
              :href="`/db/${encodeURIComponent(slug)}/${encodeURIComponent(db.name)}`"
              target="_blank"
              rel="noopener"
              class="btn btn-ghost btn-sm"
            >
              <ExternalLink :size="13" aria-hidden="true" /> Open
            </a>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null"
              :aria-expanded="passwordReset?.name === db.name"
              @click="openPasswordReset(db.name)"
            >
              <KeyRound :size="13" aria-hidden="true" /> Password
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy !== null"
              @click="showPassword(db.name)"
            >
              <Eye :size="13" aria-hidden="true" />
              {{ busy === `reveal:${db.name}` ? 'Showing\u2026' : 'Show' }}
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="busy !== null"
              @click="drop(db.name)"
            >
              <Trash2 :size="13" aria-hidden="true" />
              {{ busy === db.name ? 'Removing…' : 'Remove' }}
            </button>
          </li>
        </ul>

        <!-- The change-password form, under the database it belongs to. -->
        <form
          v-if="passwordReset"
          class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-black/20 p-4"
          @submit.prevent="changePassword"
        >
          <div>
            <label for="db-reset-mode" class="label">New password for {{ passwordReset.name }}</label>
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

        <p v-else-if="!adding" class="mt-4 text-sm text-ink-faint">
          No databases yet. WordPress creates its own when you add a WordPress site; add one
          here for anything else.
        </p>
      </template>
    </section>
  </div>
</template>
