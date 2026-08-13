<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Code2, FolderOpen, RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';

/**
 * The PHP a website runs on: which version, whether it is up, and the one
 * button that fixes most things.
 *
 * Deliberately small. A PHP site has no build scripts or startup file to
 * manage the way a Node app does — its code is just files — so this page is
 * the state of the thing that runs them and a restart, not a dashboard.
 */

const route = useRoute();
const { reload } = inject(siteContextKey)!;

const slug = computed(() => route.params['slug'] as string);

type PhpInfo = Awaited<ReturnType<typeof api.sites.php.info.query>>;

const info = ref<PhpInfo | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const SERVICE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  'not-installed': 'Not started yet',
};

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    info.value = await api.sites.php.info.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function restart(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.sites.app.restart.mutate({ slug: slug.value });
    notice.value = 'PHP was restarted.';
    await load();
    await reload();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
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
          <Code2 :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">PHP</h2>
          <p class="mt-1 text-sm text-ink-muted">
            The version of PHP your website runs on, and whether it is serving right now.
          </p>
        </div>
      </div>

      <AlertMessage v-if="error" tone="danger" class="mt-4">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success" class="mt-4">{{ notice }}</AlertMessage>

      <LoadingBlock v-if="loading" class="mt-5 h-40" />

      <template v-else-if="info">
        <dl class="mt-5 space-y-3">
          <div class="flex items-center justify-between gap-4">
            <dt class="text-sm text-ink-muted">PHP version</dt>
            <dd>
              <span
                v-if="info.phpVersion"
                class="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs text-ink-faint"
              >
                {{ info.phpVersion }}
              </span>
              <span v-else class="text-sm text-ink-faint">Not installed</span>
            </dd>
          </div>

          <div class="flex items-center justify-between gap-4">
            <dt class="text-sm text-ink-muted">Status</dt>
            <dd class="flex items-center gap-1.5 text-sm">
              <span
                class="h-1.5 w-1.5 rounded-full"
                :class="info.serviceState === 'running' ? 'bg-ok' : 'bg-idle'"
                aria-hidden="true"
              />
              <span :class="info.serviceState === 'running' ? 'text-ok' : 'text-ink-muted'">
                {{ SERVICE_LABEL[info.serviceState ?? ''] ?? 'Stopped' }}
              </span>
            </dd>
          </div>

          <div class="flex items-center justify-between gap-4">
            <dt class="text-sm text-ink-muted">Web root</dt>
            <dd class="flex items-center gap-1.5 font-mono text-xs text-ink-faint">
              <FolderOpen :size="13" aria-hidden="true" />
              {{ info.documentRoot }}
            </dd>
          </div>

          <div class="flex items-center justify-between gap-4">
            <dt class="text-sm text-ink-muted">Composer</dt>
            <dd class="text-sm" :class="info.composerInstalled ? 'text-ink' : 'text-ink-faint'">
              {{
                info.composerInstalled
                  ? info.usesComposer
                    ? 'Installed — packages install on each deploy'
                    : 'Installed'
                  : 'Not installed'
              }}
            </dd>
          </div>
        </dl>

        <div class="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
          <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="restart">
            <RefreshCw :size="13" :class="busy ? 'animate-spin' : ''" aria-hidden="true" />
            {{ busy ? 'Restarting…' : 'Restart PHP' }}
          </button>
        </div>

        <p class="mt-3 text-xs text-ink-faint">
          Restarting picks up changes to your files and environment. Your visitors may see a
          brief pause.
        </p>
      </template>
    </section>
  </div>
</template>
