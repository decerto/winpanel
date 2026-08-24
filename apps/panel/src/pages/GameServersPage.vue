<script setup lang="ts">
import { ref } from 'vue';
import { Gamepad2, Plus, RefreshCw } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
import { roleAtLeast } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';

type GameServer = Awaited<ReturnType<typeof api.gameServers.list.query>>[number];

const servers = ref<GameServer[]>([]);
const enabled = ref(false);
const isAdmin = ref(false);
const loading = ref(true);
const busy = ref(false);
const activeSlug = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const job = useJobLog({
  onFinished: async () => {
    busy.value = false;
    activeSlug.value = null;
    await refresh();
  },
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const [list, feature, me] = await Promise.all([
      api.gameServers.list.query(),
      api.gameServers.feature.query(),
      api.auth.me.query().catch(() => null),
    ]);
    servers.value = list;
    enabled.value = feature.enabled;
    isAdmin.value = me !== null && roleAtLeast(me.role, 'admin');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function install(server: GameServer, reinstall = false): Promise<void> {
  busy.value = true;
  activeSlug.value = server.slug;
  error.value = null;
  notice.value = null;

  try {
    const result = reinstall
      ? await api.gameServers.reinstall.mutate({ slug: server.slug })
      : await api.gameServers.install.mutate({ slug: server.slug });
    job.watchJob(result.jobId);
  } catch (err) {
    busy.value = false;
    activeSlug.value = null;
    error.value = describeError(err);
  }
}

function stateLabel(state: GameServer['state']): string {
  switch (state) {
    case 'uninstalled':
      return 'Ready to install';
    case 'failed':
      return 'Needs attention';
    case 'running':
      return 'Running';
    case 'installing':
      return 'Installing';
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

void refresh();
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Game Servers"
      description="Install and manage supported game servers on this Windows machine."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <RouterLink
          to="/game-servers/new"
          class="btn btn-primary"
          :class="busy || !enabled ? 'pointer-events-none opacity-50' : ''"
        >
          <Plus :size="15" aria-hidden="true" />
          Add game server
        </RouterLink>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>
    <AlertMessage v-if="!loading && !enabled" class="mb-4">
      <template v-if="isAdmin">
        Game servers are currently disabled.
        <RouterLink to="/settings" class="underline">Enable them in Settings</RouterLink>.
      </template>
      <template v-else>
        Game servers are currently disabled. Ask an administrator to enable them.
      </template>
    </AlertMessage>

    <section v-if="job.lines.value.length > 0" class="card mb-4 overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 class="text-sm font-medium text-ink">{{ job.running.value ? 'Installation' : 'Last installation' }}</h2>
        <span class="text-xs capitalize text-ink-faint">{{ job.status.value }}</span>
      </div>
      <pre class="max-h-64 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"><span
        v-for="line in job.lines.value"
        :key="line.seq"
        class="block"
        :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
      >{{ line.message }}</span></pre>
    </section>

    <div v-if="loading" class="card px-5 py-10 text-center text-sm text-ink-muted">
      Loading game servers&hellip;
    </div>

    <EmptyState
      v-else-if="servers.length === 0"
      :icon="Gamepad2"
      title="No game servers yet"
      description="Choose a supported game to create the first server on this machine."
    />

    <div v-else class="grid gap-4 md:grid-cols-2">
      <article v-for="server in servers" :key="server.id" class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <RouterLink :to="`/game-servers/${server.slug}`" class="truncate text-base font-semibold text-ink hover:text-brand-bright">
              {{ server.displayName }}
            </RouterLink>
            <p class="mt-1 text-sm text-ink-muted">
              {{ server.catalog?.name ?? server.catalogId }}
            </p>
          </div>
          <StatusBadge
            :state="server.state === 'running' ? 'ok' : server.state === 'failed' ? 'blocked' : 'unknown'"
            :label="stateLabel(server.state)"
            size="sm"
          />
        </div>

        <dl class="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Address</dt>
            <dd class="mt-1 font-mono text-ink-muted">
              {{ server.slug }}
            </dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Version</dt>
            <dd class="mt-1 text-ink-muted">{{ server.version || 'Latest' }}</dd>
          </div>
        </dl>

        <p class="mt-5 border-t border-line pt-3 text-xs text-ink-faint">
          Provider files are installed into the server folder. World and configuration data stays
          in the data folder.
        </p>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-if="server.state === 'uninstalled' || server.state === 'failed'"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busy || !enabled || !server.installAllowed"
            @click="install(server, false)"
          >
            {{ server.installAllowed
              ? (activeSlug === server.slug && job.running.value ? 'Installing...' : 'Install server')
              : 'Admin install required' }}
          </button>
          <button
            v-else
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy || !enabled"
            @click="install(server, true)"
          >
            {{ activeSlug === server.slug && job.running.value ? 'Reinstalling...' : 'Reinstall files' }}
          </button>
        </div>
      </article>
    </div>

  </div>
</template>
