<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeftRight, Cpu, FolderOpen, KeyRound, Plus, Trash2 } from 'lucide-vue-next';
import { roleAtLeast, ROLE_LABELS, SHARED_DIR, SHARED_URL_PREFIX, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';
import SearchableSelect, { type SearchableOption } from '../../components/SearchableSelect.vue';

/**
 * Settings for one website: what it runs on, its secrets, and the way out.
 *
 * Environment values are stored encrypted and only handed to the app itself,
 * so they are masked here by default rather than printed to anyone who walks
 * past the screen.
 */

const route = useRoute();
const router = useRouter();
const { site, reload } = inject(siteContextKey)!;

const slug = () => route.params['slug'] as string;

const rows = ref<Array<{ key: string; value: string; revealed: boolean }>>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

type NodeInstallation = Awaited<ReturnType<typeof api.system.nodeVersions.query>>[number];

const nodeVersions = ref<NodeInstallation[]>([]);
const chosenNode = ref('');
const nodeBusy = ref(false);

/** Only a Node site cares which Node it gets. */
const runsOnNode = computed(() => site.value?.runtime === 'node');

const pinnedNode = computed(
  () => ((site.value?.manifest as { nodeVersion?: string } | undefined)?.nodeVersion ?? ''),
);

const SOURCE_LABEL: Record<string, string> = {
  panel: 'in the panel folder',
  system: 'installed on the server',
  'version-manager': 'from a version manager',
};

const confirmName = ref('');
const deleteFiles = ref(false);
const removing = ref(false);

const sharedBusy = ref(false);
const sharedEnabled = computed(() => site.value?.sharedFolderEnabled !== false);

async function saveSharedFolder(enabled: boolean): Promise<void> {
  sharedBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.sites.setSharedFolder.mutate({ slug: slug(), enabled });
    notice.value = result.warning ?? result.note;
    await reload();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    sharedBusy.value = false;
  }
}

/* --------------------------------------------------------- who it belongs to */

type Person = Awaited<ReturnType<typeof api.users.list.query>>[number];

const me = ref<{ id: string; role: UserRole } | null>(null);
const people = ref<Person[]>([]);
const handoverTo = ref('');
const handoverBusy = ref(false);

/**
 * Only whoever runs the server may hand a website over. A customer asking
 * would only ever be refused, so the section is not shown to them at all.
 */
const mayHandOver = computed(() => me.value !== null && roleAtLeast(me.value.role, 'admin'));

/**
 * The picker options, with the server itself first. An empty value hands the
 * site back to no one, so it is offered as a real option rather than a blank.
 */
const handoverOptions = computed<SearchableOption[]>(() => [
  { value: '', label: 'The server (nobody in particular)' },
  ...people.value.map((person) => ({
    value: person.id,
    label: person.username,
    hint: ROLE_LABELS[person.role].label,
  })),
]);

async function loadPeople(): Promise<void> {
  try {
    const current = await api.auth.me.query();
    me.value = current ? { id: current.id, role: current.role } : null;
    if (!mayHandOver.value) return;

    people.value = await api.users.list.query();
    handoverTo.value = site.value?.ownerUserId ?? '';
  } catch {
    // The section simply stays hidden; handing a site over is not why most
    // people open this page.
  }
}

async function handOver(): Promise<void> {
  handoverBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const userId = handoverTo.value === '' ? null : handoverTo.value;
    await api.users.assignSite.mutate({ slug: slug(), userId });
    const name = people.value.find((person) => person.id === userId)?.username ?? null;
    await reload();
    notice.value = name
      ? `${site.value?.displayName ?? 'The website'} now belongs to ${name}. Nothing moves ` +
        'and nothing restarts — they simply see it when they sign in, and you still do too.'
      : `${site.value?.displayName ?? 'The website'} belongs to the server again.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    handoverBusy.value = false;
  }
}

async function loadEnv(): Promise<void> {
  loading.value = true;
  try {
    const env = await api.sites.getEnv.query({ slug: slug() });
    rows.value = Object.entries(env).map(([key, value]) => ({
      key,
      value: String(value),
      revealed: false,
    }));
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function loadNodeVersions(): Promise<void> {
  try {
    nodeVersions.value = await api.system.nodeVersions.query();
  } catch {
    // The picker simply says none were found; it is not worth an error banner.
  }
}

async function saveNodeVersion(): Promise<void> {
  nodeBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.sites.setNodeVersion.mutate({
      slug: slug(),
      nodeVersion: chosenNode.value,
    });
    notice.value = result.note;
    await reload();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    nodeBusy.value = false;
  }
}

async function saveEnv(): Promise<void> {
  saving.value = true;
  error.value = null;
  notice.value = null;

  try {
    const envVars = Object.fromEntries(
      rows.value.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    );
    const result = await api.sites.setEnv.mutate({ slug: slug(), envVars });
    notice.value = result.note;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    saving.value = false;
  }
}

async function removeSite(): Promise<void> {
  removing.value = true;
  error.value = null;

  try {
    await api.sites.remove.mutate({
      slug: slug(),
      confirmSlug: confirmName.value.trim(),
      deleteFiles: deleteFiles.value,
    });
    await router.push('/sites');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    removing.value = false;
  }
}

watch(pinnedNode, (value) => (chosenNode.value = value), { immediate: true });

watch(
  () => route.params['slug'],
  () => {
    void loadEnv();
    void loadNodeVersions();
    void loadPeople();
  },
  { immediate: true },
);
</script>

<template>
  <div class="space-y-6">
    <AlertMessage v-if="error">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

    <section v-if="runsOnNode" class="card p-5">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <Cpu :size="15" class="text-ink-faint" aria-hidden="true" /> Node version
      </h3>
      <p class="mt-1 text-sm text-ink-muted">
        Which Node this website is built and run with. The panel does not install runtimes —
        these are the versions already on the server, and only your hosting provider can add
        another.
      </p>

      <div v-if="nodeVersions.length === 0" class="mt-4">
        <AlertMessage tone="warning">
          No Node installation was found on this server. Ask your hosting provider to install one,
          or this website will not be able to build.
        </AlertMessage>
      </div>

      <div v-else class="mt-4 flex flex-wrap items-end gap-3">
        <div class="min-w-56">
          <label for="node-version" class="label">Version</label>
          <select id="node-version" v-model="chosenNode" class="field">
            <option value="">Whatever the server defaults to</option>
            <option
              v-for="installation in nodeVersions"
              :key="installation.version"
              :value="installation.version"
            >
              Node {{ installation.version }}
              ({{ SOURCE_LABEL[installation.source] ?? installation.source }})
            </option>
          </select>
        </div>

        <button
          type="button"
          class="btn btn-primary mb-1"
          :disabled="nodeBusy || chosenNode === pinnedNode"
          @click="saveNodeVersion"
        >
          {{ nodeBusy ? 'Saving\u2026' : 'Use this version' }}
        </button>
      </div>
    </section>

    <section class="card p-5">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <KeyRound :size="15" class="text-ink-faint" aria-hidden="true" /> Secrets and settings
      </h3>
      <p class="mt-1 text-sm text-ink-muted">
        Database addresses, API keys and anything else your app reads from its environment.
        Stored encrypted on this server and never written into your project files.
      </p>

      <LoadingBlock v-if="loading" class="mt-4 h-36" />

      <div v-else class="mt-4 space-y-2">
        <div v-for="(row, index) in rows" :key="index" class="flex gap-2">
          <input v-model="row.key" class="field max-w-56 font-mono" aria-label="Name"
                 placeholder="NAME" />
          <input
            v-model="row.value"
            :type="row.revealed ? 'text' : 'password'"
            class="field font-mono"
            aria-label="Value"
            placeholder="value"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm shrink-0"
            @click="row.revealed = !row.revealed"
          >
            {{ row.revealed ? 'Hide' : 'Show' }}
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md p-2 text-ink-faint hover:bg-danger-soft hover:text-danger"
            :aria-label="`Remove ${row.key || 'this setting'}`"
            @click="rows.splice(index, 1)"
          >
            <Trash2 :size="15" />
          </button>
        </div>

        <div class="flex items-center gap-2 pt-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="rows.push({ key: '', value: '', revealed: true })"
          >
            <Plus :size="14" aria-hidden="true" /> Add
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="saveEnv">
            {{ saving ? 'Saving\u2026' : 'Save changes' }}
          </button>
        </div>
      </div>
    </section>

    <section class="card p-5">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <FolderOpen :size="15" class="text-ink-faint" aria-hidden="true" /> Shared folder
      </h3>
      <p class="mt-1 text-sm text-ink-muted">
        Publishes the <strong>{{ SHARED_DIR }}</strong> folder at
        <code class="text-ink-faint">{{ SHARED_URL_PREFIX }}</code
        >, so files you put there by hand have an address and survive every deployment. Turn it off
        if this site has nothing to put there, or wants that address for itself — the folder and
        everything in it stays exactly where it is either way.
      </p>

      <label class="mt-4 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          :checked="sharedEnabled"
          :disabled="sharedBusy"
          @change="saveSharedFolder(($event.target as HTMLInputElement).checked)"
        />
        {{ sharedEnabled ? 'On' : 'Off' }}
      </label>
    </section>

    <section v-if="mayHandOver" class="card p-5">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <ArrowLeftRight :size="15" class="text-ink-faint" aria-hidden="true" /> Who it belongs to
      </h3>
      <p class="mt-1 text-sm text-ink-muted">
        Set a website up under your own account, then hand it over here when it is ready.
        Nothing moves and nothing restarts &mdash; it simply appears in their account, and you
        keep seeing it too, because owners and administrators can reach every website on the
        server. It can move again whenever it needs to: to a different person, or back to the
        server.
      </p>

      <div class="mt-4 flex flex-wrap items-end gap-3">
        <div class="min-w-56">
          <label id="handover-to-label" class="label">Belongs to</label>
          <SearchableSelect
            v-model="handoverTo"
            :options="handoverOptions"
            placeholder="The server (nobody in particular)"
            aria-labelledby="handover-to-label"
          />
        </div>

        <button
          type="button"
          class="btn btn-primary mb-1"
          :disabled="handoverBusy || handoverTo === (site?.ownerUserId ?? '')"
          @click="handOver"
        >
          {{ handoverBusy ? 'Handing over…' : 'Hand it over' }}
        </button>
      </div>

      <p class="mt-2 text-xs text-ink-faint">
        Handing a website to a customer counts towards their website limit &mdash; raise it on
        the People page first if they are already full.
      </p>
    </section>

    <section class="card border-danger/30 p-5">
      <h3 class="text-sm font-semibold text-danger">Delete this website</h3>
      <p class="mt-1 text-sm text-ink-muted">
        Stops serving it, releases its ports and removes it from the panel. Type
        <span class="font-mono text-ink">{{ site?.slug }}</span> to confirm.
      </p>

      <div class="mt-4 flex flex-wrap items-end gap-3">
        <div class="min-w-56">
          <label for="confirm-slug" class="label">Website name</label>
          <input id="confirm-slug" v-model="confirmName" class="field font-mono" />
        </div>

        <label class="mb-2.5 flex items-center gap-2 text-sm text-ink-muted">
          <input v-model="deleteFiles" type="checkbox" />
          Also delete its files from disk
        </label>

        <button
          type="button"
          class="btn btn-danger mb-1"
          :disabled="removing || confirmName.trim() !== site?.slug"
          @click="removeSite"
        >
          {{ removing ? 'Deleting\u2026' : 'Delete website' }}
        </button>
      </div>
    </section>
  </div>
</template>
