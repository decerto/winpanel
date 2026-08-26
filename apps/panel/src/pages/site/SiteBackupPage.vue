<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { Archive, Database, Download, RefreshCw } from 'lucide-vue-next';
import { siteContextKey } from '../../lib/site-context';
import { api, describeError } from '../../lib/api';
import { backupDownloadUrl } from '../../lib/file-transfer';
import { formatBytes } from '../../lib/format';
import { LOG_LEVEL_CLASS, useJobLog } from '../../lib/job-log';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import PageHeader from '../../components/PageHeader.vue';

const { site } = inject(siteContextKey)!;
type SiteBackup = Awaited<ReturnType<typeof api.backups.site.list.query>>[number];

const backups = ref<SiteBackup[]>([]);
const loading = ref(true);
const creating = ref(false);
const includeDependencies = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const slug = computed(() => site.value?.slug ?? '');

async function load(): Promise<void> {
  if (!slug.value) return;
  loading.value = true;
  error.value = null;

  try {
    const [archives, active] = await Promise.all([
      api.backups.site.list.query({ slug: slug.value }),
      api.backups.site.active.query({ slug: slug.value }),
    ]);
    backups.value = archives;
    if (active) {
      creating.value = true;
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
    await load();
    if (status === 'succeeded') notice.value = 'Your website backup is ready to download.';
  },
});

async function createBackup(): Promise<void> {
  if (!slug.value) return;
  creating.value = true;
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

watch(slug, () => void load(), { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-6xl">
    <PageHeader
      title="Website backup"
      description="Create a portable ZIP containing this website's files and database exports. The backup runs on the server, so you can leave this page while it works."
    >
      <template #actions>
        <button type="button" class="btn btn-ghost" :disabled="loading || creating" @click="load">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button type="button" class="btn btn-primary" :disabled="creating" @click="createBackup">
          <Archive :size="15" aria-hidden="true" />
          {{ creating ? 'Creating...' : 'Create backup' }}
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <label class="card mb-4 flex items-start justify-between gap-4 px-5 py-4 text-sm text-ink">
      <span>
        <span class="block font-medium">Include dependencies (node_modules)</span>
        <span class="mt-1 block text-xs leading-relaxed text-ink-faint">
          Adds considerable time, because dependencies are usually most of the files in a website.
          Left out, the ZIP still contains your files and database exports, and the dependencies are
          reinstalled by a deployment.
        </span>
      </span>
      <input v-model="includeDependencies" type="checkbox" class="mt-0.5 shrink-0" :disabled="creating" />
    </label>
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
            </div>
            <a
              :href="backupDownloadUrl('site', backup.id)"
              class="btn btn-ghost btn-sm"
              :download="`${slug}-backup.zip`"
            >
              <Download :size="14" aria-hidden="true" />
              Download ZIP
            </a>
          </div>
        </div>
      </section>

      <aside class="card h-fit p-5">
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
  </div>
</template>
