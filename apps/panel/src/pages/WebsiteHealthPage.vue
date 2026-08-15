<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PaginationBar from '../components/PaginationBar.vue';

/**
 * Website health: every website, and whether it is actually answering.
 *
 * This is the operator's counterpart to the banner a customer sees on their
 * own site. Server health (the other page) asks "is the machine all right";
 * this asks "is each website all right", which is a different question with a
 * different answer — the machine can be green while one site is down.
 *
 * Restarting from here and from Settings are the same act on the same
 * service; offering it in both places means the person who spots the problem
 * here does not have to go looking for the fix somewhere else.
 */

type Row = Awaited<ReturnType<typeof api.sites.websiteHealth.query>>[number];

const rows = ref<Row[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const page = ref(1);
const PAGE_SIZE = 20;

/** One restart at a time, so the list cannot fight itself. */
const restartingSlug = ref<string | null>(null);
const restartedSlug = ref<string | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  error.value = null;
  try {
    rows.value = await api.sites.websiteHealth.query();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function restart(row: Row): Promise<void> {
  restartingSlug.value = row.slug;
  restartedSlug.value = null;
  error.value = null;

  try {
    await api.sites.app.restart.mutate({ slug: row.slug });
    restartedSlug.value = row.slug;
    // Give the process a moment to come up before the table re-probes it.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    restartingSlug.value = null;
  }
}

const paged = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return rows.value.slice(start, start + PAGE_SIZE);
});

const tally = computed(() => ({
  down: rows.value.filter((r) => r.status === 'down').length,
  previewDown: rows.value.filter((r) => r.status === 'preview-down').length,
  ok: rows.value.filter((r) => r.status === 'ok').length,
}));

const STATUS_LABEL: Record<Row['status'], string> = {
  ok: 'Serving',
  down: 'Down',
  'preview-down': 'Preview down',
  off: 'Off',
};

const STATUS_DOT: Record<Row['status'], string> = {
  ok: 'bg-ok',
  down: 'bg-danger',
  'preview-down': 'bg-warn',
  off: 'bg-idle',
};

/** The one-line detail under a row that is not simply fine. */
function detail(row: Row): string | null {
  if (row.status === 'down') {
    return 'Its app says it should be running, but nothing answers on its port — the site and its preview are both down.';
  }
  if (row.status === 'preview-down') {
    return 'The site works on its domain, but its preview address is not answering.';
  }
  if (row.status === 'off') return 'Switched off; it is not meant to be answering.';
  return null;
}

onMounted(async () => {
  await load();
  // A site that falls over while this page is open should show it without a
  // manual refresh; thirty seconds is often enough and cheap to ask.
  timer = setInterval(() => void load(), 30_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="mx-auto w-full max-w-5xl">
    <section class="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-4 p-5 md:p-6">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold tracking-tight text-ink">Website health</h2>
        <p class="mt-1.5 text-sm text-ink-muted">
          Whether each website is answering, on its domain and on its preview address. A
          website can be down while the server itself is perfectly healthy — this page is
          where you see that.
        </p>
      </div>

      <dl v-if="!loading" class="flex gap-6">
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Down</dt>
          <dd class="text-2xl font-semibold" :class="tally.down > 0 ? 'text-danger' : 'text-ink-faint'">
            {{ tally.down }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Preview down</dt>
          <dd
            class="text-2xl font-semibold"
            :class="tally.previewDown > 0 ? 'text-warn' : 'text-ink-faint'"
          >
            {{ tally.previewDown }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Serving</dt>
          <dd class="text-2xl font-semibold text-ok">{{ tally.ok }}</dd>
        </div>
      </dl>

      <div class="flex w-full gap-2 sm:w-auto">
        <button type="button" class="btn btn-ghost" @click="load">
          <RefreshCw :size="15" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </section>

    <AlertMessage v-if="error" class="mb-5">{{ error }}</AlertMessage>

    <LoadingBlock v-if="loading" class="h-64 rounded-card bg-surface" />

    <template v-else>
      <div class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th class="px-5 py-3 font-medium">Website</th>
              <th class="px-5 py-3 font-medium">Status</th>
              <th class="hidden px-5 py-3 font-medium md:table-cell">Preview</th>
              <th class="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line">
            <tr v-for="row in paged" :key="row.slug" class="align-top">
              <td class="px-5 py-3.5">
                <RouterLink
                  :to="`/sites/${row.slug}`"
                  class="font-medium text-ink hover:text-brand-bright hover:underline"
                >
                  {{ row.displayName }}
                </RouterLink>
                <p v-if="detail(row)" class="mt-1 text-xs text-ink-faint">{{ detail(row) }}</p>
              </td>

              <td class="px-5 py-3.5">
                <span class="inline-flex items-center gap-1.5">
                  <span class="h-1.5 w-1.5 rounded-full" :class="STATUS_DOT[row.status]" aria-hidden="true" />
                  <span
                    :class="
                      row.status === 'ok'
                        ? 'text-ok'
                        : row.status === 'down'
                          ? 'text-danger'
                          : row.status === 'preview-down'
                            ? 'text-warn'
                            : 'text-ink-faint'
                    "
                  >
                    {{ STATUS_LABEL[row.status] }}
                  </span>
                </span>
              </td>

              <td class="hidden px-5 py-3.5 md:table-cell">
                <a
                  v-if="row.previewUrl"
                  :href="row.previewUrl"
                  target="_blank"
                  rel="noreferrer noopener"
                  class="font-mono text-xs text-brand-bright underline underline-offset-2"
                >
                  {{ row.previewUrl }}
                </a>
                <span v-else class="text-xs text-ink-faint">&mdash;</span>
              </td>

              <td class="px-5 py-3.5 text-right">
                <template v-if="row.canRestart && row.status !== 'off'">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="restartingSlug !== null"
                    @click="restart(row)"
                  >
                    {{ restartingSlug === row.slug ? 'Restarting…' : 'Restart' }}
                  </button>
                  <span v-if="restartedSlug === row.slug" class="ml-2 text-xs text-ok">
                    Restarted
                  </span>
                </template>
                <span v-else class="text-xs text-ink-faint">&mdash;</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PaginationBar v-model:page="page" :total="rows.length" :page-size="PAGE_SIZE" noun="websites" />
    </template>
  </div>
</template>
