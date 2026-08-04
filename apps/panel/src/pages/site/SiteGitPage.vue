<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  Check,
  CloudDownload,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  KeyRound,
  Pencil,
  RefreshCw,
  Rocket,
} from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';

/**
 * The repository behind this website.
 *
 * The question in front of this page is always the same: is what is running
 * the same as what is in the repository, and if not, make it so. Hence one
 * primary button — "Pull now" — that fetches the latest commit and takes it
 * live, with the recent history beside it so you can see what that will
 * change before you press it.
 */

const route = useRoute();
const { site, deploy, deploying } = inject(siteContextKey)!;

const slug = computed(() => route.params['slug'] as string);

type GitInfo = Awaited<ReturnType<typeof api.sites.git.info.query>>;
type Commit = Awaited<ReturnType<typeof api.sites.git.refreshCommits.mutate>>['commits'][number];

const info = ref<GitInfo | null>(null);
const commits = ref<Commit[]>([]);
const checkedAt = ref<Date | null>(null);

const loading = ref(true);
const refreshing = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const commitsError = ref<string | null>(null);
const notice = ref<string | null>(null);
const copied = ref(false);
const editing = ref(false);
const showAllCommits = ref(false);

const form = ref({ url: '', branch: '', subdirectory: '', token: '' });

const visibleCommits = computed(() =>
  showAllCommits.value ? commits.value : commits.value.slice(0, 2),
);

/** The commit that is actually serving traffic, if a deploy has succeeded. */
const deployedCommit = computed(() => info.value?.lastDeployment?.commit ?? null);

const behind = computed(() => {
  const latest = commits.value[0]?.sha;
  if (!latest || !deployedCommit.value) return null;
  return latest !== deployedCommit.value;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    info.value = await api.sites.git.info.query({ slug: slug.value });
    form.value = {
      url: info.value.url,
      branch: info.value.branch,
      subdirectory: info.value.subdirectory,
      token: '',
    };
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

/** Talks to the remote, so it is only ever done on purpose. */
async function refresh(): Promise<void> {
  refreshing.value = true;
  commitsError.value = null;

  try {
    const result = await api.sites.git.refreshCommits.mutate({ slug: slug.value, limit: 10 });
    commits.value = result.commits;
    checkedAt.value = result.checkedAt;
  } catch (err) {
    commitsError.value = describeError(err);
  } finally {
    refreshing.value = false;
  }
}

async function saveSource(): Promise<void> {
  saving.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.sites.git.setSource.mutate({
      slug: slug.value,
      url: form.value.url.trim(),
      branch: form.value.branch.trim(),
      subdirectory: form.value.subdirectory.trim(),
      // An untouched token box must not wipe a stored one.
      ...(form.value.token.trim().length > 0 ? { token: form.value.token.trim() } : {}),
    });

    notice.value = result.message;
    editing.value = false;
    commits.value = [];
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    saving.value = false;
  }
}

async function copyUrl(): Promise<void> {
  if (!info.value) return;

  try {
    await navigator.clipboard.writeText(info.value.url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be refused; the address is selectable anyway.
  }
}

function when(value: Date | string | null | undefined): string {
  if (!value) return '\u2014';
  return new Date(value).toLocaleString();
}

watch(slug, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <AlertMessage v-if="error">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

    <div v-if="loading" class="h-72 animate-pulse rounded-card bg-surface" />

    <section v-else-if="info" class="card overflow-hidden">
      <header class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <span
          class="flex h-9 w-9 items-center justify-center rounded-lg border border-line
                 bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <GitBranch :size="17" />
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="truncate text-sm font-semibold text-ink">Repository</h3>
          <p class="truncate text-xs text-ink-faint">
            Branch <span class="font-mono text-ink-muted">{{ info.branch }}</span>
            deploys automatically to
            <span class="font-mono text-ink-muted">/{{ info.deployPath }}</span>
          </p>
        </div>

        <button type="button" class="btn btn-ghost btn-sm" @click="editing = !editing">
          <Pencil :size="14" aria-hidden="true" /> {{ editing ? 'Cancel' : 'Change' }}
        </button>
      </header>

      <div class="space-y-5 p-5">
        <div class="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label for="repo-url" class="label">Address</label>
            <div class="flex gap-2">
              <input
                id="repo-url"
                :value="info.url"
                class="field font-mono"
                readonly
                aria-label="Repository address"
              />
              <button
                type="button"
                class="btn btn-ghost shrink-0"
                :aria-label="copied ? 'Copied' : 'Copy address'"
                @click="copyUrl"
              >
                <component :is="copied ? Check : Copy" :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>

          <p class="flex items-center gap-1.5 pb-2 text-xs text-ink-muted">
            <KeyRound :size="13" class="text-ink-faint" aria-hidden="true" />
            {{ info.hasToken ? 'Private, using a stored token' : 'Public repository' }}
          </p>
        </div>

        <!-- Editing is deliberately behind a button: this is the one setting that
             can point a live website at somebody else's code. -->
        <form v-if="editing" class="grid gap-3 rounded-xl border border-line bg-sunken/60 p-4
                                    sm:grid-cols-2" @submit.prevent="saveSource">
          <div class="sm:col-span-2">
            <label for="edit-url" class="label">Repository address</label>
            <input id="edit-url" v-model="form.url" class="field font-mono" />
            <p class="hint">An https:// address. SSH addresses are not supported.</p>
          </div>
          <div>
            <label for="edit-branch" class="label">Branch</label>
            <input id="edit-branch" v-model="form.branch" class="field font-mono" />
          </div>
          <div>
            <label for="edit-subdir" class="label">Folder in the repository</label>
            <input id="edit-subdir" v-model="form.subdirectory" class="field font-mono"
                   placeholder="(the whole repository)" />
          </div>
          <div class="sm:col-span-2">
            <label for="edit-token" class="label">Access token</label>
            <input
              id="edit-token"
              v-model="form.token"
              type="password"
              class="field font-mono"
              :placeholder="info.hasToken ? 'Stored \u2014 leave blank to keep it' : 'Only needed for a private repository'"
            />
          </div>
          <div class="sm:col-span-2">
            <button type="submit" class="btn btn-primary" :disabled="saving">
              {{ saving ? 'Checking\u2026' : 'Check and save' }}
            </button>
          </div>
        </form>

        <!-- History. Shown before the deploy button, because it is the thing
             that tells you whether pressing it will change anything. -->
        <div>
          <div class="mb-2 flex flex-wrap items-center gap-3">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-ink">
              <GitCommitHorizontal :size="15" class="text-ink-faint" aria-hidden="true" />
              Latest commits
            </h4>
            <span v-if="checkedAt" class="text-xs text-ink-faint">
              Checked {{ when(checkedAt) }}
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-sm ml-auto"
              :disabled="refreshing"
              @click="refresh"
            >
              <RefreshCw :size="14" :class="refreshing ? 'animate-spin' : ''" aria-hidden="true" />
              Check for changes
            </button>
          </div>

          <AlertMessage v-if="commitsError" tone="warning">{{ commitsError }}</AlertMessage>

          <p v-else-if="refreshing && commits.length === 0" class="text-sm text-ink-muted">
            Reading the repository&#8230;
          </p>

          <p v-else-if="commits.length === 0" class="text-sm text-ink-muted">
            No commits have been read yet.
          </p>

          <ul v-else class="divide-y divide-line rounded-xl border border-line">
            <li
              v-for="commit in visibleCommits"
              :key="commit.sha"
              class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
            >
              <span class="font-mono text-xs text-ink-faint">
                {{ new Date(commit.at).toLocaleString() }}
              </span>
              <span class="min-w-0 flex-1 truncate text-ink">{{ commit.subject }}</span>
              <span
                v-if="commit.sha === deployedCommit"
                class="rounded-md bg-ok-soft px-1.5 py-0.5 text-xs text-ok"
              >
                Deployed
              </span>
              <span class="font-mono text-xs text-ink-faint">{{ commit.shortSha }}</span>
            </li>

            <li v-if="commits.length > 2" class="px-4 py-2">
              <button
                type="button"
                class="text-xs text-ink-muted hover:text-brand-bright"
                @click="showAllCommits = !showAllCommits"
              >
                {{ showAllCommits ? 'show less' : `show more (${commits.length - 2})` }}
              </button>
            </li>
          </ul>

          <p v-if="behind === true" class="mt-2 text-sm text-warn">
            The repository has moved on since the last deployment.
          </p>
          <p v-else-if="behind === false" class="mt-2 text-sm text-ok">
            The deployed version is the latest commit on this branch.
          </p>
        </div>
      </div>

      <footer class="flex flex-wrap items-center gap-3 border-t border-line bg-sunken/40 px-5 py-4">
        <div class="min-w-0 flex-1 text-xs text-ink-faint">
          <p>
            Last deployment
            <span class="font-mono text-ink-muted">
              {{ info.lastDeployment?.releaseId ?? '\u2014' }}
            </span>
            &#183; {{ info.lastDeployment?.status ?? 'never' }}
            &#183; {{ when(info.lastDeployment?.at) }}
          </p>
          <p v-if="info.lastDeployment?.errorMessage" class="mt-0.5 text-danger">
            {{ info.lastDeployment.errorMessage }}
          </p>
        </div>

        <button type="button" class="btn btn-primary" :disabled="deploying" @click="deploy">
          <component
            :is="deploying ? RefreshCw : CloudDownload"
            :size="15"
            :class="deploying ? 'animate-spin' : ''"
            aria-hidden="true"
          />
          {{ deploying ? 'Pulling\u2026' : 'Pull now' }}
        </button>
      </footer>
    </section>

    <p v-if="site && !loading" class="flex items-start gap-2 text-xs text-ink-faint">
      <Rocket :size="13" class="mt-0.5 shrink-0" aria-hidden="true" />
      Pulling downloads the latest commit on
      <span class="font-mono">{{ info?.branch }}</span>, builds it into a new release, and
      switches traffic over only once it answers. The version now serving is left untouched
      until then.
    </p>
  </div>
</template>
