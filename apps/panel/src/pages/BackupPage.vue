<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ArchiveRestore, CalendarDays, Download, RefreshCw, RotateCcw, Save } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { backupDownloadUrl } from '../lib/file-transfer';
import { formatBytes } from '../lib/format';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';

type Schedule = Awaited<ReturnType<typeof api.backups.panel.settings.query>>;
type PanelBackup = Awaited<ReturnType<typeof api.backups.panel.list.query>>[number];

const schedule = ref<Schedule>({
  daily: true,
  weekly: false,
  monthly: false,
  includeGameServers: false,
});
const backups = ref<PanelBackup[]>([]);
const loading = ref(true);
const saving = ref(false);
const creating = ref(false);
const activeOperation = ref<'create' | 'restore' | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const [settings, archives] = await Promise.all([
      api.backups.panel.settings.query(),
      api.backups.panel.list.query(),
    ]);
    schedule.value = settings;
    backups.value = archives;
    const active = await api.backups.panel.active.query();
    if (active) {
      creating.value = true;
      activeOperation.value = 'create';
      job.watchJob(active.jobId);
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

const job = useJobLog({
  onFinished: async (status) => {
    creating.value = false;
    const operation = activeOperation.value;
    activeOperation.value = null;
    await load();
    if (status === 'succeeded' && operation === 'create') {
      notice.value = 'The panel recovery backup is ready to download.';
    }
  },
});

async function saveSchedule(): Promise<void> {
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.backups.panel.setSettings.mutate(schedule.value);
    notice.value = 'Automatic backup schedule saved.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    saving.value = false;
  }
}

async function createBackup(): Promise<void> {
  creating.value = true;
  activeOperation.value = 'create';
  error.value = null;
  notice.value = null;
  try {
    const result = await api.backups.panel.create.mutate({
      includeGameServers: schedule.value.includeGameServers,
    });
    job.watchJob(result.jobId);
  } catch (err) {
    creating.value = false;
    activeOperation.value = null;
    error.value = describeError(err);
  }
}

async function restoreBackup(backup: PanelBackup): Promise<void> {
  const confirmed = window.confirm(
    'Restore this panel backup? The panel, websites, game servers and configuration will be replaced, then the agent will restart.',
  );
  if (!confirmed) return;

  error.value = null;
  notice.value = null;
  activeOperation.value = 'restore';
  try {
    const result = await api.backups.panel.restore.mutate({ backupId: backup.id });
    job.watchJob(result.jobId);
  } catch (err) {
    activeOperation.value = null;
    error.value = describeError(err);
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Panel backup"
      description="Local recovery snapshots for the entire WinPanel server. Backups run on the server, so you can leave this page while one is being created. Only the owner can access these."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="loading || creating || job.running.value" @click="load">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button type="button" class="btn btn-primary" :disabled="creating || job.running.value" @click="createBackup">
          <ArchiveRestore :size="15" aria-hidden="true" />
          {{ creating ? 'Creating...' : 'Back up now' }}
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>
    <AlertMessage v-if="job.running.value" tone="info" class="mb-4">
      This backup is running in the background. You can leave this page and return later to see its progress.
    </AlertMessage>

    <section v-if="job.lines.value.length > 0" class="card mb-5 overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 class="text-sm font-medium text-ink">Backup activity</h2>
        <span class="text-xs capitalize text-ink-faint">{{ job.status.value }} · {{ job.progress.value }}%</span>
      </div>
      <div class="h-1 bg-black/20" role="progressbar" :aria-valuenow="job.progress.value" aria-valuemin="0" aria-valuemax="100">
        <div class="h-full bg-brand transition-[width]" :style="{ width: `${job.progress.value}%` }" />
      </div>
      <pre class="max-h-56 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"><span
        v-for="line in job.lines.value"
        :key="line.seq"
        class="block"
        :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
      >{{ line.message }}</span></pre>
    </section>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section class="card overflow-hidden">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-base font-semibold text-ink">Recovery snapshots</h2>
          <p class="mt-1 text-sm text-ink-muted">Compressed local copies of the server state.</p>
        </div>

        <div v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">Loading backups...</div>
        <EmptyState
          v-else-if="backups.length === 0"
          :icon="ArchiveRestore"
          title="No panel backups yet"
          description="Create a local recovery snapshot before making a major server change."
        />
        <div v-else class="divide-y divide-line">
          <div v-for="backup in backups" :key="backup.id" class="flex flex-wrap items-center gap-3 px-5 py-4">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
              <ArchiveRestore :size="16" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-ink">
                {{ new Date(backup.createdAt).toLocaleString() }}
              </p>
              <p class="mt-0.5 text-xs text-ink-faint">
                {{ formatBytes(backup.sizeBytes) }} compressed<span v-if="backup.frequency"> &middot; {{ backup.frequency }}</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <a
                :href="backupDownloadUrl('panel', backup.id)"
                class="btn btn-ghost btn-sm"
                download
                title="Download recovery snapshot"
              >
                <Download :size="14" aria-hidden="true" />
                Download
              </a>
              <button
                type="button"
                class="btn btn-ghost btn-sm text-danger"
                :disabled="job.running.value || activeOperation === 'restore'"
                title="Restore this recovery snapshot"
                @click="restoreBackup(backup)"
              >
                <RotateCcw :size="14" aria-hidden="true" />
                Restore
              </button>
            </div>
          </div>
        </div>
      </section>

      <aside class="space-y-5">
        <section class="card p-5">
          <div class="flex items-start gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
              <CalendarDays :size="16" aria-hidden="true" />
            </span>
            <div>
              <h2 class="text-sm font-semibold text-ink">Automatic snapshots</h2>
              <p class="mt-1 text-sm leading-relaxed text-ink-muted">Choose which local recovery snapshots the owner wants the server to create.</p>
            </div>
          </div>

          <div class="mt-5 space-y-3">
            <label v-for="period in ['daily', 'weekly', 'monthly'] as const" :key="period" class="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-sm text-ink">
              <span class="capitalize">{{ period }}</span>
              <input v-model="schedule[period]" type="checkbox" />
            </label>
            <label class="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5 text-sm text-ink">
              <span>
                <span class="block">Include game servers</span>
                <span class="mt-0.5 block text-xs leading-relaxed text-ink-faint">
                  Game-server files can be hundreds of GB. Websites and databases are always included.
                </span>
              </span>
              <input v-model="schedule.includeGameServers" type="checkbox" class="mt-0.5 shrink-0" />
            </label>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-ink-faint">
            This choice applies to <strong>Back up now</strong> and automatic snapshots. Save the schedule after changing it.
          </p>
          <button type="button" class="btn btn-primary mt-4 w-full" :disabled="saving" @click="saveSchedule">
            <Save :size="15" aria-hidden="true" />
            {{ saving ? 'Saving...' : 'Save schedule' }}
          </button>
        </section>

        <section class="card p-5">
          <h2 class="text-sm font-semibold text-ink">Recovery scope</h2>
          <p class="mt-1.5 text-sm leading-relaxed text-ink-muted">
            A panel snapshot always includes the panel, websites, databases and configuration.
            Game servers are {{ schedule.includeGameServers ? 'included' : 'left out' }} according to the option above. It stays on this server until you download or remove it.
          </p>
        </section>
      </aside>
    </div>
  </div>
</template>
