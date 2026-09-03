<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { Archive, ArchiveRestore, Database, Download, RefreshCw, Trash2, Upload, X } from 'lucide-vue-next';
import { siteContextKey } from '../../lib/site-context';
import { api, describeError } from '../../lib/api';
import {
  backupDownloadUrl,
  uploadBackupFile,
  type BackupUploadResult,
} from '../../lib/file-transfer';
import { formatBytes } from '../../lib/format';
import { LOG_LEVEL_CLASS, useJobLog } from '../../lib/job-log';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import PageHeader from '../../components/PageHeader.vue';

const { site } = inject(siteContextKey)!;
type SiteBackup = Awaited<ReturnType<typeof api.backups.site.list.query>>[number];
type SiteQuota = Awaited<ReturnType<typeof api.backups.site.quota.query>>;

type RestoreSource = {
  id: string;
  label: string;
  includesDependencies: boolean;
};

const backups = ref<SiteBackup[]>([]);
const quota = ref<SiteQuota | null>(null);
const loading = ref(true);
const creating = ref(false);
const restoring = ref(false);
const removing = ref<string | null>(null);
const uploading = ref(false);
const uploadProgress = ref(0);
const uploadName = ref('');
const uploaded = ref<BackupUploadResult | null>(null);
const restoreSource = ref<RestoreSource | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadHandle = ref<{ cancel: () => void } | null>(null);
const activeOperation = ref<'create' | 'restore' | null>(null);
const includeDependencies = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const slug = computed(() => site.value?.slug ?? '');
const isNodeSite = computed(() => site.value?.runtime === 'node');
const offerDependencyChoice = computed(
  () => restoreSource.value !== null && isNodeSite.value && !restoreSource.value.includesDependencies,
);

function quotaText(value: SiteQuota | null): string {
  if (!value) return 'Checking your backup allowance...';
  if (value.unlimited) return 'Unlimited website backups';
  const used = value.completed + value.reserved;
  return `${used} of ${value.limit} website backup${value.limit === 1 ? '' : 's'} used`;
}

async function load(): Promise<void> {
  if (!slug.value) return;
  loading.value = true;
  error.value = null;

  try {
    const [archives, active, allowance] = await Promise.all([
      api.backups.site.list.query({ slug: slug.value }),
      api.backups.site.active.query({ slug: slug.value }),
      api.backups.site.quota.query({ slug: slug.value }),
    ]);
    backups.value = archives;
    quota.value = allowance;
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
  onFinished: async (status) => {
    creating.value = false;
    restoring.value = false;
    const operation = activeOperation.value;
    activeOperation.value = null;
    await load();
    if (status === 'succeeded' && operation === 'create') {
      notice.value = 'Your website backup is ready to download.';
    } else if (status === 'succeeded' && operation === 'restore') {
      notice.value = 'Your website files and matching databases were restored.';
    } else if (status === 'cancelled') {
      notice.value = `The website ${operation === 'restore' ? 'restore' : 'backup'} was cancelled.`;
    }
  },
});

async function createBackup(): Promise<void> {
  if (!slug.value || creating.value || restoring.value || uploading.value) return;
  creating.value = true;
  activeOperation.value = 'create';
  error.value = null;
  notice.value = null;

  try {
    const result = await api.backups.site.create.mutate({
      slug: slug.value,
      includeDependencies: includeDependencies.value,
    });
    job.watchJob(result.jobId);
  } catch (err) {
    creating.value = false;
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

function chooseFile(): void {
  if (!uploading.value && !creating.value && !restoring.value) uploadInput.value?.click();
}

async function onBackupFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !slug.value) return;

  if (!file.name.toLowerCase().endsWith('.zip')) {
    error.value = 'Choose a website backup ZIP file.';
    return;
  }

  uploading.value = true;
  uploadProgress.value = 0;
  uploadName.value = file.name;
  uploaded.value = null;
  error.value = null;
  notice.value = null;

  const handle = uploadBackupFile('site', file, slug.value, (fraction) => {
    uploadProgress.value = Math.round(fraction * 100);
  });
  uploadHandle.value = handle;

  try {
    uploaded.value = await handle.promise;
    uploadProgress.value = 100;
    notice.value = 'The ZIP was checked and is ready to restore.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    if (uploadHandle.value === handle) uploadHandle.value = null;
    uploading.value = false;
  }
}

function cancelUpload(): void {
  uploadHandle.value?.cancel();
}

function clearUploaded(): void {
  if (uploading.value) return;
  uploaded.value = null;
  uploadName.value = '';
  uploadProgress.value = 0;
}

function openRestore(source: RestoreSource): void {
  if (creating.value || restoring.value || uploading.value) return;
  restoreSource.value = source;
  error.value = null;
  notice.value = null;
}

function closeRestore(): void {
  if (!restoring.value) restoreSource.value = null;
}

async function restoreSelected(installDependencies: boolean): Promise<void> {
  const source = restoreSource.value;
  if (!source || !slug.value) return;

  restoring.value = true;
  activeOperation.value = 'restore';
  error.value = null;
  notice.value = null;
  try {
    const result = await api.backups.site.restore.mutate({
      slug: slug.value,
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

async function deleteBackup(backup: SiteBackup): Promise<void> {
  const confirmed = window.confirm(
    `Delete the backup from ${new Date(backup.createdAt).toLocaleString()}? It cannot be recovered once the file is gone.`,
  );
  if (!confirmed) return;

  removing.value = backup.id;
  error.value = null;
  notice.value = null;
  try {
    await api.backups.site.remove.mutate({ slug: slug.value, backupId: backup.id });
    backups.value = backups.value.filter((entry) => entry.id !== backup.id);
    notice.value = 'That backup was deleted.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    removing.value = null;
  }
}

watch(
  slug,
  () => {
    uploadHandle.value?.cancel();
    uploadHandle.value = null;
    uploading.value = false;
    uploaded.value = null;
    restoreSource.value = null;
    uploadName.value = '';
    uploadProgress.value = 0;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Website backup"
      description="Create a portable ZIP containing this website's files and database exports. The backup runs on the server, so you can leave this page while it works."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="loading || creating || restoring || uploading" @click="load">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button type="button" class="btn btn-ghost" :disabled="creating || restoring || uploading" @click="chooseFile">
          <Upload :size="15" aria-hidden="true" />
          Upload ZIP
        </button>
        <input
          ref="uploadInput"
          type="file"
          accept=".zip,application/zip"
          class="sr-only"
          aria-label="Upload a website backup ZIP"
          @change="onBackupFilePicked"
        />
        <button
          type="button"
          class="btn btn-primary"
          :disabled="creating || restoring || uploading || quota?.remaining === 0"
          @click="createBackup"
        >
          <Archive :size="15" aria-hidden="true" />
          {{ creating ? 'Creating...' : 'Create backup' }}
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>
    <AlertMessage v-if="quota && !quota.unlimited && quota.remaining === 0" class="mb-4">
      Your website backup allowance is full. Delete an existing backup before creating another one.
    </AlertMessage>

    <section v-if="uploading || uploaded" class="card mb-4 p-5">
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
          <Upload :size="16" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-semibold text-ink">Uploaded backup</h2>
          <p class="mt-1 truncate text-sm text-ink-muted" :title="uploadName">{{ uploadName }}</p>
        </div>
        <button
          v-if="!uploading"
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Remove uploaded backup"
          title="Remove uploaded backup"
          @click="clearUploaded"
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
        <button type="button" class="btn btn-ghost btn-sm mt-3" @click="cancelUpload">Cancel upload</button>
      </template>
      <template v-else-if="uploaded">
        <p class="mt-3 text-sm text-ink-muted">
          {{ formatBytes(uploaded.bytes) }} checked, {{ uploaded.databaseCount }} database export{{ uploaded.databaseCount === 1 ? '' : 's' }}
          <span v-if="uploaded.includeDependencies">, dependencies included</span>
          <span v-else>, dependencies omitted</span>.
        </p>
        <button
          type="button"
          class="btn btn-primary btn-sm mt-4"
          :disabled="creating || restoring"
          @click="openRestore({ id: uploaded.uploadId, label: uploadName, includesDependencies: uploaded.includeDependencies })"
        >
          <ArchiveRestore :size="14" aria-hidden="true" />
          Restore uploaded ZIP
        </button>
      </template>
    </section>

    <label class="card mb-4 flex items-start justify-between gap-4 px-5 py-4 text-sm text-ink">
      <span>
        <span class="block font-medium">Include dependencies (node_modules)</span>
        <span class="mt-1 block text-xs leading-relaxed text-ink-faint">
          Adds considerable time, because dependencies are usually most of the files in a website.
          Left out, the ZIP still contains your files and database exports, and the dependencies are
          reinstalled by a deployment.
        </span>
      </span>
      <input v-model="includeDependencies" type="checkbox" class="mt-0.5 shrink-0" :disabled="creating || restoring || uploading" />
    </label>
    <AlertMessage v-if="job.running.value" tone="info" class="mb-4">
      {{ restoring ? 'This restore is running in the background. Keep the panel open until it finishes.' : 'This backup is running in the background. You can leave this page and return later to see its progress.' }}
    </AlertMessage>

    <section v-if="job.lines.value.length > 0 || job.running.value" class="card mb-5 overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 class="text-sm font-medium text-ink">{{ restoring ? 'Restore activity' : 'Backup activity' }}</h2>
        <div class="flex items-center gap-3">
          <button
            v-if="job.running.value"
            type="button"
            class="btn btn-ghost btn-sm text-danger"
            aria-label="Cancel current website activity"
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

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section class="card overflow-hidden">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-base font-semibold text-ink">Available downloads</h2>
          <p class="mt-1 text-sm text-ink-muted">Keep a copy somewhere outside this server.</p>
        </div>

        <div v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">
          Loading backups&hellip;
        </div>
        <EmptyState
          v-else-if="backups.length === 0"
          :icon="Archive"
          title="No website backups yet"
          description="Create a backup to get a ZIP you can store on another computer, drive or cloud service."
        />
        <div v-else class="divide-y divide-line">
          <div v-for="backup in backups" :key="backup.id" class="flex flex-wrap items-center gap-3 px-5 py-4">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-brand-soft/40 text-brand-bright">
              <Archive :size="16" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-ink">
                {{ new Date(backup.createdAt).toLocaleString() }}
              </p>
              <p class="mt-0.5 text-xs text-ink-faint">{{ formatBytes(backup.sizeBytes) }} compressed</p>
              <p class="mt-0.5 text-xs text-ink-faint">
                Dependencies {{ backup.includesDependencies ? 'included' : 'omitted' }}
              </p>
            </div>
            <a
              :href="backupDownloadUrl('site', backup.id)"
              class="btn btn-ghost btn-sm"
              :download="`${slug}-backup.zip`"
            >
              <Download :size="14" aria-hidden="true" />
              Download ZIP
            </a>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="creating || restoring || uploading"
              :title="`Restore the backup from ${new Date(backup.createdAt).toLocaleString()}`"
              @click="openRestore({ id: backup.id, label: new Date(backup.createdAt).toLocaleString(), includesDependencies: backup.includesDependencies })"
            >
              <ArchiveRestore :size="14" aria-hidden="true" />
              Restore
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm text-danger"
              :disabled="removing !== null"
              :aria-label="`Delete the backup from ${new Date(backup.createdAt).toLocaleString()}`"
              @click="deleteBackup(backup)"
            >
              <Trash2 :size="14" aria-hidden="true" />
              {{ removing === backup.id ? 'Deleting...' : 'Delete' }}
            </button>
          </div>
        </div>
      </section>

      <aside class="card h-fit p-5">
        <div class="border-b border-line pb-4">
          <h2 class="text-sm font-semibold text-ink">Backup allowance</h2>
          <p class="mt-1 text-sm text-ink-muted">{{ quotaText(quota) }}</p>
          <p v-if="quota && !quota.unlimited" class="mt-1 text-xs leading-relaxed text-ink-faint">
            {{ quota.remaining }} slot{{ quota.remaining === 1 ? '' : 's' }} remaining across all websites on this account.
            In-progress backups reserve a slot until they finish.
          </p>
        </div>
        <div class="flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-info-soft text-info">
            <Database :size="16" aria-hidden="true" />
          </span>
          <div>
            <h2 class="text-sm font-semibold text-ink">What is included</h2>
            <p class="mt-1 text-sm leading-relaxed text-ink-muted">
              The website folders are included exactly as they are on the server. Databases are exported as portable SQL or JSON files inside the ZIP.
            </p>
          </div>
        </div>
        <p class="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-ink-faint">
          Website backups are separate from the owner's local panel recovery backups. This archive is yours to move to B2, S3, a NAS or removable media.
        </p>
      </aside>
    </div>

    <div
      v-if="restoreSource"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      @click.self="closeRestore"
    >
      <form
        class="card w-full max-w-lg p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="website-restore-title"
        @submit.prevent="restoreSelected(false)"
      >
        <div class="flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand-soft/60 text-brand-bright" aria-hidden="true">
            <ArchiveRestore :size="16" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 id="website-restore-title" class="text-base font-semibold text-ink">Restore website backup</h2>
            <p class="mt-1 text-sm leading-relaxed text-ink-muted">
              Restore <span class="font-medium text-ink">{{ restoreSource.label }}</span> into this website. Its matching database exports will replace the current contents.
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" aria-label="Close restore dialog" :disabled="restoring" @click="closeRestore">
            <X :size="15" aria-hidden="true" />
          </button>
        </div>

        <p v-if="offerDependencyChoice" class="mt-4 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5 text-sm leading-relaxed text-ink-muted">
          This archive omitted Node dependencies. Install them from the lockfile after restoring, or skip installation and deploy later.
        </p>
        <p v-else-if="restoreSource.includesDependencies" class="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-muted">
          This archive includes the website's dependencies.
        </p>
        <p v-else class="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-muted">
          This website does not need Node dependency installation. Its files and matching database exports will be restored.
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
