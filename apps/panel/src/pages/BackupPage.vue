<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  ArchiveRestore,
  CalendarClock,
  CircleCheck,
  CircleX,
  Download,
  HardDrive,
  Hand,
  RefreshCw,
  RotateCcw,
  Timer,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import {
  backupDownloadUrl,
  uploadBackupFile,
  type BackupUploadResult,
} from '../lib/file-transfer';
import { formatBytes, timeAgo } from '../lib/format';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';

type PanelStatus = Awaited<ReturnType<typeof api.backups.panel.status.query>>;
type ScheduleSlot = PanelStatus['slots'][number];
type PanelBackup = PanelStatus['backups'][number];
type Frequency = ScheduleSlot['frequency'];
type RestoreSource = {
  id: string;
  label: string;
  includesDependencies: boolean;
};

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const FREQUENCY_BLURB: Record<Frequency, string> = {
  daily: 'Runs after midnight and replaces yesterday’s snapshot.',
  weekly: 'Runs on Monday and replaces last week’s snapshot.',
  monthly: 'Runs on the 1st and replaces last month’s snapshot.',
};

const status = ref<PanelStatus | null>(null);
const loading = ref(true);
const saving = ref(false);
const creating = ref(false);
const restoring = ref(false);
const removing = ref<string | null>(null);
const activeOperation = ref<'create' | 'restore' | null>(null);
const uploading = ref(false);
const uploadProgress = ref(0);
const uploadName = ref('');
const uploaded = ref<BackupUploadResult | null>(null);
const restoreSource = ref<RestoreSource | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadHandle = ref<{ cancel: () => void } | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
/** Re-read on a timer so "in 6 hours" does not go stale on an open page. */
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

const schedule = computed(() => status.value?.schedule ?? null);
const slots = computed<ScheduleSlot[]>(() => status.value?.slots ?? []);
const backups = computed<PanelBackup[]>(() => status.value?.backups ?? []);
const enabledCount = computed(() => slots.value.filter((slot) => slot.enabled).length);
const checkMinutes = computed(() => Math.round((status.value?.checkIntervalMs ?? 0) / 60000));
const offerDependencyChoice = computed(
  () => restoreSource.value !== null && !restoreSource.value.includesDependencies,
);

/**
 * The soonest automatic snapshot across every enabled schedule.
 *
 * The question the page has to answer at a glance is "when does the server
 * next back itself up", not "when does each of three schedules next run".
 */
const nextRun = computed(() => {
  const upcoming = slots.value
    .filter((slot): slot is ScheduleSlot & { nextRunAt: Date } => slot.nextRunAt !== null)
    .sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
  return upcoming[0] ?? null;
});

const failing = computed(() => slots.value.filter((slot) => slot.givenUpThisPeriod));

function whenLabel(at: Date | string | null | undefined): string {
  if (!at) return 'never';
  return timeAgo(at, clock.value);
}

function exactly(at: Date | string | null | undefined): string {
  return at ? new Date(at).toLocaleString() : '';
}

function nextRunLabel(slot: ScheduleSlot): string {
  if (!slot.enabled) return 'Switched off';
  if (slot.dueNow) {
    return slot.attemptsThisPeriod > 0
      ? `Retrying within ${checkMinutes.value} minutes`
      : `Starting within ${checkMinutes.value} minutes`;
  }
  return whenLabel(slot.nextRunAt);
}

function frequencyLabel(frequency: Frequency | null): string {
  return frequency ? FREQUENCY_LABEL[frequency] : 'Manual';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    status.value = await api.backups.panel.status.query();
    const active = await api.backups.panel.active.query();
    if (active) {
      activeOperation.value = active.operation;
      creating.value = active.operation === 'create';
      restoring.value = active.operation === 'restore';
      job.watchJob(active.jobId);
    } else {
      activeOperation.value = null;
      creating.value = false;
      restoring.value = false;
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

const job = useJobLog({
  onFinished: async (finished) => {
    creating.value = false;
    restoring.value = false;
    const operation = activeOperation.value;
    activeOperation.value = null;
    await load();
    if (finished === 'succeeded' && operation === 'create') {
      notice.value = 'The panel recovery snapshot is ready to download.';
    } else if (finished === 'succeeded' && operation === 'restore') {
      notice.value = 'The panel recovery snapshot was restored.';
    } else if (finished === 'cancelled') {
      notice.value = `The panel ${operation === 'restore' ? 'restore' : 'backup'} was cancelled.`;
    }
  },
});

/**
 * Persists as soon as a switch is flipped.
 *
 * A separate Save button on this page is a trap: the schedule looks enabled
 * on screen while the server is still running the old one, and the only
 * symptom is snapshots that never appear.
 */
async function updateSchedule(change: Partial<PanelStatus['schedule']>): Promise<void> {
  const current = schedule.value;
  if (!current) return;

  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    status.value = await api.backups.panel.setSettings.mutate({ ...current, ...change });
    notice.value = 'Backup schedule saved.';
  } catch (err) {
    error.value = describeError(err);
    await load();
  } finally {
    saving.value = false;
  }
}

async function createBackup(): Promise<void> {
  if (creating.value || restoring.value || uploading.value) return;
  creating.value = true;
  activeOperation.value = 'create';
  error.value = null;
  notice.value = null;
  try {
    const result = await api.backups.panel.create.mutate({
      includeGameServers: schedule.value?.includeGameServers ?? false,
      includeDependencies: schedule.value?.includeDependencies ?? false,
    });
    job.watchJob(result.jobId);
  } catch (err) {
    creating.value = false;
    activeOperation.value = null;
    error.value = describeError(err);
  }
}

async function cancelActiveJob(): Promise<void> {
  try {
    await job.cancel();
    notice.value = 'Cancellation requested. The activity will finish safely.';
  } catch (err) {
    error.value = describeError(err);
  }
}

function openRestore(source: RestoreSource): void {
  if (creating.value || restoring.value || uploading.value || job.running.value) return;
  restoreSource.value = source;
  error.value = null;
  notice.value = null;
}

function closeRestore(): void {
  if (!restoring.value) restoreSource.value = null;
}

async function restoreSelected(installDependencies: boolean): Promise<void> {
  const source = restoreSource.value;
  if (!source) return;

  error.value = null;
  notice.value = null;
  activeOperation.value = 'restore';
  restoring.value = true;
  try {
    const result = await api.backups.panel.restore.mutate({
      ...(uploaded.value?.uploadId === source.id
        ? { uploadedBackupId: source.id }
        : { backupId: source.id }),
      installDependencies,
    });
    restoreSource.value = null;
    uploaded.value = uploaded.value?.uploadId === source.id ? null : uploaded.value;
    job.watchJob(result.jobId);
  } catch (err) {
    restoring.value = false;
    activeOperation.value = null;
    error.value = describeError(err);
  }
}

function choosePanelFile(): void {
  if (!uploading.value && !creating.value && !restoring.value && !job.running.value) {
    uploadInput.value?.click();
  }
}

async function onPanelFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.tar.gz') && !lowerName.endsWith('.tgz')) {
    error.value = 'Choose a panel recovery TAR.GZ file.';
    return;
  }

  uploading.value = true;
  uploadProgress.value = 0;
  uploadName.value = file.name;
  uploaded.value = null;
  error.value = null;
  notice.value = null;

  const handle = uploadBackupFile('panel', file, undefined, (fraction) => {
    uploadProgress.value = Math.round(fraction * 100);
  });
  uploadHandle.value = handle;

  try {
    uploaded.value = await handle.promise;
    uploadProgress.value = 100;
    notice.value = 'The TAR.GZ was checked and is ready to restore.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    if (uploadHandle.value === handle) uploadHandle.value = null;
    uploading.value = false;
  }
}

function cancelPanelUpload(): void {
  uploadHandle.value?.cancel();
}

function clearPanelUpload(): void {
  if (uploading.value) return;
  uploaded.value = null;
  uploadName.value = '';
  uploadProgress.value = 0;
}

function restoreUploadedPanel(): void {
  if (!uploaded.value) return;
  openRestore({
    id: uploaded.value.uploadId,
    label: uploadName.value,
    includesDependencies: uploaded.value.includeDependencies,
  });
}

async function deleteBackup(backup: PanelBackup): Promise<void> {
  const confirmed = window.confirm(
    `Delete the ${frequencyLabel(backup.frequency).toLowerCase()} snapshot from ${exactly(backup.createdAt)}? ` +
      'It cannot be recovered once the file is gone.',
  );
  if (!confirmed) return;

  removing.value = backup.id;
  error.value = null;
  notice.value = null;
  try {
    status.value = await api.backups.panel.remove.mutate({ backupId: backup.id });
    notice.value = 'That snapshot was deleted.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    removing.value = null;
  }
}

onMounted(() => {
  void load();
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
  uploadHandle.value?.cancel();
});
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Panel backup"
      description="Local recovery snapshots for the entire WinPanel server. Snapshots run on the server, so you can leave this page while one is being created. Only the owner can access these."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="loading || creating || restoring || uploading || job.running.value" @click="load">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button type="button" class="btn btn-ghost" :disabled="creating || restoring || uploading || job.running.value" @click="choosePanelFile">
          <Upload :size="15" aria-hidden="true" />
          Upload TAR.GZ
        </button>
        <input
          ref="uploadInput"
          type="file"
          accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
          class="sr-only"
          aria-label="Upload a panel recovery TAR.GZ"
          @change="onPanelFilePicked"
        />
        <button type="button" class="btn btn-primary" :disabled="creating || restoring || uploading || job.running.value" @click="createBackup">
          <ArchiveRestore :size="15" aria-hidden="true" />
          {{ creating ? 'Creating...' : 'Back up now' }}
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>
    <AlertMessage v-for="slot in failing" :key="`failed-${slot.frequency}`" class="mb-4">
      The {{ FREQUENCY_LABEL[slot.frequency].toLowerCase() }} snapshot failed
      {{ slot.attemptsThisPeriod }} time{{ slot.attemptsThisPeriod === 1 ? '' : 's' }} and will not be
      retried until the next one is due.
      <span v-if="slot.lastRun?.error" class="block pt-1 font-mono text-xs">{{ slot.lastRun.error }}</span>
    </AlertMessage>
    <AlertMessage v-if="job.running.value" tone="info" class="mb-4">
      {{ restoring ? 'The panel is restarting during this restore. The activity will reconnect when the agent is available again.' : 'This snapshot is running in the background. You can leave this page and return later to see its progress.' }}
    </AlertMessage>

    <section v-if="uploading || uploaded" class="card mb-5 p-5">
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
          <Upload :size="16" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-semibold text-ink">Uploaded panel snapshot</h2>
          <p class="mt-1 truncate text-sm text-ink-muted" :title="uploadName">{{ uploadName }}</p>
        </div>
        <button
          v-if="!uploading"
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Remove uploaded panel snapshot"
          title="Remove uploaded panel snapshot"
          @click="clearPanelUpload"
        >
          <X :size="15" aria-hidden="true" />
        </button>
      </div>
      <template v-if="uploading">
        <div class="mt-4 flex items-center justify-between text-xs text-ink-faint">
          <span>Checking the archive...</span>
          <span>{{ uploadProgress }}%</span>
        </div>
        <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" :aria-valuenow="uploadProgress" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full bg-brand transition-[width]" :style="{ width: `${uploadProgress}%` }" />
        </div>
        <button type="button" class="btn btn-ghost btn-sm mt-3" @click="cancelPanelUpload">Cancel upload</button>
      </template>
      <template v-else-if="uploaded">
        <p class="mt-3 text-sm text-ink-muted">
          {{ formatBytes(uploaded.bytes) }} checked, {{ uploaded.websiteCount ?? 0 }} website{{ uploaded.websiteCount === 1 ? '' : 's' }} and
          {{ uploaded.databaseCount }} database export{{ uploaded.databaseCount === 1 ? '' : 's' }}.
        </p>
        <p class="mt-3 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5 text-sm leading-relaxed text-ink-muted">
          Restoring this archive replaces the panel state and restarts the agent. Game servers are replaced only when the archive contains them.
        </p>
        <button type="button" class="btn btn-primary btn-sm mt-4" :disabled="creating || restoring" :aria-busy="restoring" @click="restoreUploadedPanel">
          <RotateCcw :size="14" aria-hidden="true" />
          {{ restoring ? 'Starting...' : 'Restore uploaded snapshot' }}
        </button>
      </template>
    </section>

    <section v-if="job.lines.value.length > 0 || job.running.value" class="card mb-5 overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 class="text-sm font-medium text-ink">{{ restoring ? 'Restore activity' : 'Backup activity' }}</h2>
        <div class="flex items-center gap-3">
          <button
            v-if="job.running.value"
            type="button"
            class="btn btn-ghost btn-sm text-danger"
            aria-label="Cancel current panel activity"
            :disabled="job.cancelling.value"
            @click="cancelActiveJob"
          >
            <X :size="14" aria-hidden="true" />
            {{ job.cancelling.value ? 'Cancelling...' : 'Cancel' }}
          </button>
          <span class="text-xs capitalize text-ink-faint">{{ job.status.value }} · {{ job.progress.value }}%</span>
        </div>
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

    <section v-if="status" class="card mb-5 grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
      <div class="bg-surface px-5 py-4">
        <p class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <CalendarClock :size="13" aria-hidden="true" />
          Next automatic snapshot
        </p>
        <p class="mt-1 truncate text-lg font-semibold text-ink" :title="exactly(nextRun?.nextRunAt)">
          {{ nextRun ? nextRunLabel(nextRun) : 'Never' }}
        </p>
        <p class="mt-0.5 text-xs text-ink-faint">
          {{ nextRun ? `${FREQUENCY_LABEL[nextRun.frequency]} schedule` : 'No schedule is switched on' }}
        </p>
      </div>
      <div class="bg-surface px-5 py-4">
        <p class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <Timer :size="13" aria-hidden="true" />
          Schedules on
        </p>
        <p class="mt-1 text-lg font-semibold text-ink">{{ enabledCount }} of 3</p>
        <p class="mt-0.5 text-xs text-ink-faint">The server checks every {{ checkMinutes }} minutes</p>
      </div>
      <div class="bg-surface px-5 py-4">
        <p class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <HardDrive :size="13" aria-hidden="true" />
          Snapshots kept here
        </p>
        <p class="mt-1 text-lg font-semibold text-ink">{{ formatBytes(status.storage.totalBytes) }}</p>
        <p class="mt-0.5 text-xs text-ink-faint">
          {{ status.storage.count }} panel snapshot{{ status.storage.count === 1 ? '' : 's' }} on this disk
        </p>
      </div>
      <div class="bg-surface px-5 py-4">
        <p class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
          <ArchiveRestore :size="13" aria-hidden="true" />
          Newest snapshot
        </p>
        <p class="mt-1 truncate text-lg font-semibold text-ink" :title="exactly(status.storage.newestAt)">
          {{ status.storage.newestAt ? whenLabel(status.storage.newestAt) : 'None yet' }}
        </p>
        <p class="mt-0.5 text-xs text-ink-faint">
          Website backups use a further {{ formatBytes(status.websiteStorage.totalBytes) }}
        </p>
      </div>
    </section>

    <section class="mb-5 grid gap-4 md:grid-cols-3">
      <article
        v-for="slot in slots"
        :key="slot.frequency"
        class="card p-5"
        :data-schedule="slot.frequency"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-ink">{{ FREQUENCY_LABEL[slot.frequency] }}</h2>
            <p class="mt-1 text-xs leading-relaxed text-ink-faint">{{ FREQUENCY_BLURB[slot.frequency] }}</p>
          </div>
          <input
            type="checkbox"
            class="mt-0.5 shrink-0"
            :checked="slot.enabled"
            :disabled="saving || !schedule"
            :aria-label="`${FREQUENCY_LABEL[slot.frequency]} snapshots`"
            @change="updateSchedule({ [slot.frequency]: ($event.target as HTMLInputElement).checked })"
          />
        </div>

        <dl class="mt-4 space-y-2.5 border-t border-line pt-4 text-sm">
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Next backup</dt>
            <dd
              class="truncate text-right font-medium"
              :class="slot.enabled ? 'text-ink' : 'text-ink-faint'"
              :title="exactly(slot.nextRunAt)"
            >
              {{ nextRunLabel(slot) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Last run</dt>
            <dd class="flex min-w-0 items-center gap-1.5 text-right">
              <CircleCheck v-if="slot.lastRun?.status === 'succeeded'" :size="13" class="shrink-0 text-ok" aria-hidden="true" />
              <CircleX v-else-if="slot.lastRun?.status === 'failed'" :size="13" class="shrink-0 text-danger" aria-hidden="true" />
              <TriangleAlert v-else-if="slot.lastRun" :size="13" class="shrink-0 text-warn" aria-hidden="true" />
              <span class="truncate text-ink-muted" :title="exactly(slot.lastRun?.at)">
                {{ slot.lastRun ? `${slot.lastRun.status} ${whenLabel(slot.lastRun.at)}` : 'Never run' }}
              </span>
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Snapshot held</dt>
            <dd class="truncate text-right text-ink-muted" :title="exactly(slot.currentBackup?.createdAt)">
              <template v-if="slot.currentBackup">
                {{ formatBytes(slot.currentBackup.sizeBytes) }} · {{ whenLabel(slot.currentBackup.createdAt) }}
              </template>
              <template v-else-if="slot.lastSuccessAt">Deleted</template>
              <template v-else>None yet</template>
            </dd>
          </div>
        </dl>

        <p v-if="slot.lastRun?.status === 'failed' && slot.lastRun.error" class="mt-3 rounded-lg bg-danger-soft/40 px-3 py-2 text-xs leading-relaxed text-danger">
          {{ slot.lastRun.error }}
        </p>
      </article>
    </section>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section class="card overflow-hidden">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-base font-semibold text-ink">Recovery snapshots</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Each schedule keeps only its most recent snapshot. Snapshots you take by hand are kept until you delete them.
          </p>
        </div>

        <div v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">Loading backups...</div>
        <EmptyState
          v-else-if="backups.length === 0"
          :icon="ArchiveRestore"
          title="No panel snapshots yet"
          description="Create a local recovery snapshot before making a major server change."
        />
        <div v-else class="divide-y divide-line">
          <div v-for="backup in backups" :key="backup.id" class="flex flex-wrap items-center gap-3 px-5 py-4">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
              <Hand v-if="!backup.frequency" :size="16" aria-hidden="true" />
              <CalendarClock v-else :size="16" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                <span class="truncate">{{ exactly(backup.createdAt) }}</span>
                <span class="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal text-ink-faint">
                  {{ frequencyLabel(backup.frequency) }}
                </span>
              </p>
              <p class="mt-0.5 text-xs text-ink-faint">
                {{ formatBytes(backup.sizeBytes) }} compressed &middot; {{ whenLabel(backup.createdAt) }}
                <span v-if="backup.includesGameServers"> &middot; with game servers</span>
                <span v-if="backup.includesDependencies"> &middot; with dependencies</span>
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
                class="btn btn-ghost btn-sm"
                :disabled="job.running.value || activeOperation === 'restore'"
                title="Restore this recovery snapshot"
                @click="openRestore({ id: backup.id, label: exactly(backup.createdAt), includesDependencies: backup.includesDependencies })"
              >
                <RotateCcw :size="14" aria-hidden="true" />
                Restore
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm text-danger"
                :disabled="removing !== null || job.running.value"
                :title="`Delete this recovery snapshot`"
                :aria-label="`Delete the snapshot from ${exactly(backup.createdAt)}`"
                @click="deleteBackup(backup)"
              >
                <Trash2 :size="14" aria-hidden="true" />
                {{ removing === backup.id ? 'Deleting...' : 'Delete' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <aside class="space-y-5">
        <section v-if="schedule" class="card p-5">
          <h2 class="text-sm font-semibold text-ink">What goes in a snapshot</h2>
          <p class="mt-1 text-sm leading-relaxed text-ink-muted">
            The panel, its database, every website and every hosted database are always included.
          </p>

          <div class="mt-4 space-y-3">
            <label class="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5 text-sm text-ink">
              <span>
                <span class="block">Include game servers</span>
                <span class="mt-0.5 block text-xs leading-relaxed text-ink-faint">
                  Game-server files can be hundreds of GB.
                </span>
              </span>
              <input
                type="checkbox"
                class="mt-0.5 shrink-0"
                :checked="schedule.includeGameServers"
                :disabled="saving"
                @change="updateSchedule({ includeGameServers: ($event.target as HTMLInputElement).checked })"
              />
            </label>
            <label class="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5 text-sm text-ink">
              <span>
                <span class="block">Include dependencies (node_modules)</span>
                <span class="mt-0.5 block text-xs leading-relaxed text-ink-faint">
                  Adds considerable time: dependencies are usually most of the files on the server.
                  Left out, a restored website needs a redeploy to reinstall them.
                </span>
              </span>
              <input
                type="checkbox"
                class="mt-0.5 shrink-0"
                :checked="schedule.includeDependencies"
                :disabled="saving"
                @change="updateSchedule({ includeDependencies: ($event.target as HTMLInputElement).checked })"
              />
            </label>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-ink-faint">
            Changes save straight away and apply to <strong>Back up now</strong> and every automatic snapshot.
          </p>
        </section>

        <section class="card p-5">
          <h2 class="text-sm font-semibold text-ink">Recovery scope</h2>
          <p class="mt-1.5 text-sm leading-relaxed text-ink-muted">
            A panel snapshot always includes the panel, websites, databases and configuration.
            Game servers are {{ schedule?.includeGameServers ? 'included' : 'left out' }} according to the option above.
            Dependencies are {{ schedule?.includeDependencies ? 'included' : 'left out' }}. Snapshots stay on this
            server until they are replaced by the next scheduled one, or you download or delete them.
          </p>
        </section>
      </aside>
    </div>

    <div
      v-if="restoreSource"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      @click.self="closeRestore"
    >
      <form
        class="card w-full max-w-lg p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="panel-restore-title"
        @submit.prevent="restoreSelected(false)"
      >
        <div class="flex items-start gap-3">
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft/60 text-brand-bright"
            aria-hidden="true"
          >
            <ArchiveRestore :size="16" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 id="panel-restore-title" class="text-base font-semibold text-ink">Restore panel backup</h2>
            <p class="mt-1 text-sm leading-relaxed text-ink-muted">
              Restore <span class="font-medium text-ink">{{ restoreSource.label }}</span>. Panel files,
              website files, matching database storage and any included game-server files will be replaced.
              The agent will restart after the restore.
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" aria-label="Close restore dialog" :disabled="restoring" @click="closeRestore">
            <X :size="15" aria-hidden="true" />
          </button>
        </div>

        <p v-if="offerDependencyChoice" class="mt-4 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5 text-sm leading-relaxed text-ink-muted">
          This archive omitted Node dependencies. Install them from each restored website's lockfile, or skip installation and deploy later.
          PHP, static, .NET, proxy and other non-Node websites will always skip Node dependency installation.
        </p>
        <p v-else-if="restoreSource.includesDependencies" class="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-muted">
          This archive includes website dependencies, so the restore will not run a package manager.
        </p>
        <p v-else class="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-muted">
          Website dependencies are omitted. The panel, website files and matching database storage will be restored without installing packages.
        </p>

        <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>
        <div class="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <button type="button" class="btn btn-ghost" :disabled="restoring" @click="closeRestore">Cancel</button>
          <button v-if="offerDependencyChoice" type="button" class="btn btn-ghost" :disabled="restoring" @click="restoreSelected(false)">
            Skip installation
          </button>
          <button v-if="offerDependencyChoice" type="button" class="btn btn-primary" :disabled="restoring" :aria-busy="restoring" @click="restoreSelected(true)">
            {{ restoring ? 'Starting...' : 'Install and restore' }}
          </button>
          <button v-else type="submit" class="btn btn-primary" :disabled="restoring" :aria-busy="restoring">
            {{ restoring ? 'Starting...' : 'Restore backup' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
