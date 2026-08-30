<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  Package,
  Plus,
  RefreshCw,
  Search,
  ThumbsUp,
  Trash2,
  Users,
  X,
} from 'lucide-vue-next';
import { RouterLink } from 'vue-router';
import { parseWorkshopReference } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { formatBytes } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import Tooltip from '../components/Tooltip.vue';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';

/**
 * Steam Workshop mods, without a Steam account.
 *
 * The obvious way to do this would be to ask the customer to sign in to Steam,
 * and it is the wrong way: the operator's account is what SteamCMD uses, and
 * nobody should be typing credentials into a hosting panel to install a mod.
 * The download happens on the server, and the customer gets the mod.
 *
 * Browsing is here rather than only on Steam, because "go to another website,
 * copy an address, come back" is a workflow, not a feature. It needs a Steam
 * Web API key, which Valve gives to anyone and an administrator adds once — so
 * the paste-a-link path stays fully working for panels that have not, rather
 * than the whole tab depending on it.
 */

const props = defineProps<{ slug: string; isAdmin: boolean }>();

type Status = Awaited<ReturnType<typeof api.gameServers.workshop.status.query>>;
type Item = Awaited<ReturnType<typeof api.gameServers.workshop.list.query>>[number];
type Browse = Awaited<ReturnType<typeof api.gameServers.workshop.browse.query>>;
type BrowseItem = Browse['items'][number];
type Preview = Awaited<ReturnType<typeof api.gameServers.workshop.lookup.mutate>>;
type Sort = Parameters<typeof api.gameServers.workshop.browse.query>[0]['sort'];

const SORTS: Array<{ value: NonNullable<Sort>; label: string }> = [
  { value: 'trend', label: 'Popular this week' },
  { value: 'popular', label: 'Most subscribed' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'newest', label: 'Newest' },
];

const PAGE_SIZE = 24;

const status = ref<Status | null>(null);
const items = ref<ReadonlyArray<Item>>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const search = ref('');
const sort = ref<NonNullable<Sort>>('trend');
const tag = ref('');
const page = ref(1);
const browse = ref<Browse | null>(null);
const browsing = ref(false);
const browseError = ref<string | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const linkOpen = ref(false);
const reference = ref('');
const preview = ref<Preview | null>(null);
const previewError = ref<string | null>(null);
const looking = ref(false);
let lookupTimer: ReturnType<typeof setTimeout> | null = null;

const job = useJobLog({
  onFinished: async (result) => {
    busy.value = false;
    await load();
    if (status.value?.searchable) await loadBrowse();
    notice.value = result === 'succeeded'
      ? 'Workshop items are ready. Restart the server to load them.'
      : null;
  },
});

/** Several links at once is normal when someone is moving a mod list across. */
const references = computed(() =>
  reference.value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean),
);
const parsed = computed(() => references.value.map((entry) => parseWorkshopReference(entry)));
const canAdd = computed(() => parsed.value.length > 0 && parsed.value.every((id) => id !== null));

const installedCount = computed(() => items.value.filter((item) => item.state === 'installed').length);
const totalBytes = computed(() => items.value.reduce((sum, item) => sum + item.sizeBytes, 0));
const ready = computed(() => status.value?.steamcmdInstalled === true && !busy.value && !job.running.value);

const pageCount = computed(() =>
  browse.value ? Math.min(50, Math.max(1, Math.ceil(browse.value.total / PAGE_SIZE))) : 1,
);

function previewUrl(publishedFileId: string): string {
  return `/api/game-servers/${encodeURIComponent(props.slug)}/workshop/${encodeURIComponent(publishedFileId)}/preview`;
}

function steamPage(publishedFileId: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(publishedFileId)}`;
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

async function load(): Promise<void> {
  loading.value = status.value === null;
  try {
    const [next, list] = await Promise.all([
      api.gameServers.workshop.status.query({ slug: props.slug }),
      api.gameServers.workshop.list.query({ slug: props.slug }),
    ]);
    status.value = next;
    items.value = list;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function loadBrowse(): Promise<void> {
  if (!status.value?.searchable) return;
  browsing.value = true;
  browseError.value = null;

  try {
    browse.value = await api.gameServers.workshop.browse.query({
      slug: props.slug,
      search: search.value.trim(),
      sort: sort.value,
      tag: tag.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    });
  } catch (err) {
    browseError.value = describeError(err);
  } finally {
    browsing.value = false;
  }
}

/** Typing re-runs the search, but not once per keystroke. */
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void loadBrowse();
  }, 400);
});

watch([sort, tag], () => {
  page.value = 1;
  void loadBrowse();
});

watch(page, () => {
  void loadBrowse();
  document.querySelector('#workshop-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/*
 * A pasted link is looked up while it is typed rather than after adding, so a
 * link copied from the wrong tab is caught before it becomes a download and a
 * puzzle about why the server still has no mods.
 */
watch(reference, () => {
  preview.value = null;
  previewError.value = null;
  if (lookupTimer) clearTimeout(lookupTimer);
  if (references.value.length !== 1) return;

  const single = references.value[0];
  if (!single || parseWorkshopReference(single) === null) {
    if (single) previewError.value = 'That is not a Workshop link or id.';
    return;
  }

  lookupTimer = setTimeout(async () => {
    looking.value = true;
    try {
      preview.value = await api.gameServers.workshop.lookup.mutate({ slug: props.slug, reference: single });
    } catch (err) {
      previewError.value = describeError(err);
    } finally {
      looking.value = false;
    }
  }, 450);
});

async function addReferences(wanted: string[]): Promise<void> {
  if (wanted.length === 0) return;
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.gameServers.workshop.add.mutate({ slug: props.slug, references: wanted });
    reference.value = '';
    preview.value = null;
    job.watchJob(result.jobId);
    await load();
  } catch (err) {
    busy.value = false;
    error.value = describeError(err);
  }
}

async function update(publishedFileId?: string): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.gameServers.workshop.update.mutate({
      slug: props.slug,
      ...(publishedFileId ? { publishedFileId } : {}),
    });
    job.watchJob(result.jobId);
  } catch (err) {
    busy.value = false;
    error.value = describeError(err);
  }
}

async function remove(item: Item): Promise<void> {
  if (!window.confirm(`Remove ${item.title}? Its files are deleted and it is taken out of the mod list.`)) return;
  busy.value = true;
  error.value = null;

  try {
    await api.gameServers.workshop.remove.mutate({ slug: props.slug, publishedFileId: item.publishedFileId });
    notice.value = `${item.title} removed. Restart the server for the change to take effect.`;
    await load();
    if (status.value?.searchable) await loadBrowse();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/** An item added from the grid is already on the server the moment it is queued. */
function isQueued(item: BrowseItem): boolean {
  return item.installed || items.value.some((row) => row.publishedFileId === item.publishedFileId);
}

watch(() => props.slug, async () => {
  page.value = 1;
  await load();
  await loadBrowse();
}, { immediate: true });

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  if (lookupTimer) clearTimeout(lookupTimer);
});
</script>

<template>
  <div class="space-y-6">
    <LoadingBlock v-if="loading" class="h-64 rounded-card bg-surface" />

    <template v-else-if="status?.supported">
      <AlertMessage v-if="error">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <section class="card overflow-hidden">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-ink">Steam Workshop</h2>
            <p class="mt-0.5 max-w-2xl text-xs text-ink-faint">
              {{
                status.searchable
                  ? 'Search the Workshop and add a mod to this server. You do not need a Steam account — the server does the download itself.'
                  : 'Paste the address of a Workshop item and the panel downloads it onto this server for you. You do not need a Steam account — the server does the download itself.'
              }}
            </p>
          </div>
          <a
            v-if="status.browseUrl"
            :href="status.browseUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-ghost btn-sm"
          >
            <ExternalLink :size="14" aria-hidden="true" /> Open on Steam
          </a>
        </div>

        <div class="space-y-3 px-4 py-4">
          <AlertMessage v-if="!status.steamcmdInstalled" tone="warning">
            SteamCMD is not installed, so nothing can be downloaded yet.
            <RouterLink v-if="isAdmin" to="/settings" class="underline">Install it in Settings</RouterLink>
            <span v-else>Ask an administrator to install it.</span>
          </AlertMessage>

          <AlertMessage v-else-if="status.needsAccount" tone="warning">
            This game's Workshop is not served anonymously, so the panel needs the server's own
            Steam account before it can fetch items.
            <RouterLink v-if="isAdmin" to="/settings" class="underline">Add it in Settings</RouterLink>
            <span v-else>Ask an administrator to add one.</span>
          </AlertMessage>

          <!-- Searching needs a Steam Web API key; without one the link field carries the tab. -->
          <div v-if="status.searchable" class="flex flex-wrap items-center gap-2">
            <div class="relative min-w-64 flex-1">
              <Search :size="15" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
              <input
                v-model="search"
                class="field !pl-9"
                type="search"
                placeholder="Search this game's Workshop"
                autocomplete="off"
                aria-label="Search the Workshop"
              />
            </div>
            <select v-model="sort" class="field !w-auto" aria-label="Sort results">
              <option v-for="option in SORTS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="browsing" @click="loadBrowse">
              <RefreshCw :size="14" :class="browsing ? 'animate-spin' : ''" aria-hidden="true" /> Refresh
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :aria-pressed="linkOpen" @click="linkOpen = !linkOpen">
              <Link2 :size="14" aria-hidden="true" /> Add by link
            </button>
          </div>

          <div v-if="status.searchable && tag" class="flex items-center gap-2 text-xs text-ink-muted">
            <span>Filtered by</span>
            <button type="button" class="inline-flex items-center gap-1 rounded-full bg-brand-soft/60 px-2 py-1 text-brand-bright" @click="tag = ''">
              {{ tag }} <X :size="12" aria-hidden="true" />
            </button>
          </div>

          <p v-if="isAdmin && !status.searchable" class="text-xs text-ink-faint">
            Add a Steam Web API key in
            <RouterLink to="/settings" class="text-brand-bright underline">Settings</RouterLink>
            to search the Workshop from inside the panel. Valve issues one free to any Steam account.
          </p>

          <form v-if="!status.searchable || linkOpen" class="flex flex-wrap items-start gap-2" @submit.prevent="addReferences(references)">
            <div class="min-w-64 flex-1">
              <label class="label" for="workshop-reference">Workshop link or id</label>
              <input
                id="workshop-reference"
                v-model="reference"
                class="field font-mono text-xs"
                placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985"
                spellcheck="false"
                autocomplete="off"
                :disabled="busy || job.running.value"
              />
              <p class="hint">
                Paste several at once, separated by spaces or commas, to move a whole mod list over.
              </p>
            </div>
            <button
              type="submit"
              class="btn btn-primary mt-6"
              :disabled="!canAdd || !ready"
            >
              <Plus :size="14" aria-hidden="true" />
              {{ job.running.value ? 'Downloading…' : references.length > 1 ? `Add ${references.length}` : 'Add' }}
            </button>
          </form>

          <p v-if="previewError" class="text-xs text-danger">{{ previewError }}</p>
          <p v-else-if="looking" class="flex items-center gap-2 text-xs text-ink-faint">
            <Search :size="13" aria-hidden="true" /> Asking Steam what that is…
          </p>

          <div v-else-if="preview" class="flex items-start gap-3 rounded-card border border-line bg-elevated/40 p-3">
            <img
              v-if="preview.hasPreview"
              :src="previewUrl(preview.publishedFileId)"
              alt=""
              class="h-12 w-12 shrink-0 rounded-lg object-cover"
            />
            <span v-else class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-brand-soft/50 text-brand-bright">
              <Package :size="18" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-ink">{{ preview.title }}</p>
              <p class="mt-0.5 font-mono text-xs text-ink-faint">
                {{ preview.publishedFileId }} · {{ formatBytes(preview.sizeBytes) }}
              </p>
              <p v-if="preview.wrongGame" class="mt-1 flex items-center gap-1.5 text-xs text-warn">
                <AlertTriangle :size="13" aria-hidden="true" />
                This is a Workshop item for another game and will not load here.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section v-if="status.searchable" id="workshop-results" class="scroll-mt-4">
        <AlertMessage v-if="browseError" class="mb-4">{{ browseError }}</AlertMessage>

        <div v-if="browsing && !browse" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <LoadingBlock v-for="index in 6" :key="index" class="h-64 rounded-card bg-surface" />
        </div>

        <EmptyState
          v-else-if="browse && browse.items.length === 0"
          :icon="Search"
          title="Nothing matched"
          :description="search ? `The Workshop has no items matching “${search}”. Try fewer words, or a different sort.` : 'The Workshop returned no items for this game.'"
        />

        <template v-else-if="browse">
          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" :class="browsing ? 'opacity-60' : ''">
            <article
              v-for="item in browse.items"
              :key="item.publishedFileId"
              class="card card-interactive flex flex-col overflow-hidden"
            >
              <Tooltip :text="`Open ${item.title} on Steam`">
                <a
                  :href="steamPage(item.publishedFileId)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex aspect-video items-center justify-center overflow-hidden bg-sunken"
                  :aria-label="`Open ${item.title} on Steam`"
                >
                  <img
                    v-if="item.hasPreview"
                    :src="previewUrl(item.publishedFileId)"
                    alt=""
                    class="size-full object-cover"
                    loading="lazy"
                  />
                  <Package v-else :size="28" class="text-ink-faint" aria-hidden="true" />
                </a>
              </Tooltip>

              <div class="flex min-w-0 flex-1 flex-col gap-2 p-4">
                <h3 class="line-clamp-2 text-sm font-semibold text-ink">{{ item.title }}</h3>
                <p v-if="item.description" class="line-clamp-2 text-xs leading-relaxed text-ink-muted">
                  {{ item.description }}
                </p>

                <div v-if="item.tags.length > 0" class="flex flex-wrap gap-1">
                  <button
                    v-for="name in item.tags.slice(0, 3)"
                    :key="name"
                    type="button"
                    class="rounded-full border border-line px-2 py-0.5 text-[0.65rem] text-ink-faint hover:border-line-strong hover:text-ink"
                    :title="`Show only items tagged ${name}`"
                    @click="tag = name"
                  >
                    {{ name }}
                  </button>
                </div>

                <div class="mt-auto flex items-center gap-3 pt-1 text-[0.7rem] text-ink-faint">
                  <span class="inline-flex items-center gap-1" :title="`${item.subscriptions} subscribers`">
                    <Users :size="12" aria-hidden="true" /> {{ compact(item.subscriptions) }}
                  </span>
                  <span v-if="item.votesUp > 0" class="inline-flex items-center gap-1" :title="`${item.votesUp} upvotes`">
                    <ThumbsUp :size="12" aria-hidden="true" /> {{ compact(item.votesUp) }}
                  </span>
                  <span v-if="item.sizeBytes > 0">{{ formatBytes(item.sizeBytes) }}</span>
                </div>

                <button
                  v-if="isQueued(item)"
                  type="button"
                  class="btn btn-ghost btn-sm w-full text-ok"
                  disabled
                >
                  <Check :size="14" aria-hidden="true" /> Added
                </button>
                <button
                  v-else
                  type="button"
                  class="btn btn-primary btn-sm w-full"
                  :disabled="!ready"
                  @click="addReferences([item.publishedFileId])"
                >
                  <Plus :size="14" aria-hidden="true" /> Add to server
                </button>
              </div>
            </article>
          </div>

          <div v-if="pageCount > 1" class="mt-4 flex items-center justify-center gap-3">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="page <= 1 || browsing" @click="page -= 1">
              <ChevronLeft :size="14" aria-hidden="true" /> Previous
            </button>
            <span class="text-xs text-ink-muted">Page {{ page }} of {{ pageCount }}</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="page >= pageCount || browsing" @click="page += 1">
              Next <ChevronRight :size="14" aria-hidden="true" />
            </button>
          </div>
        </template>
      </section>

      <section v-if="job.lines.value.length > 0" class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <div class="flex items-center gap-2">
            <RefreshCw
              :size="14"
              :class="job.running.value ? 'animate-spin text-brand-bright' : 'text-ink-faint'"
              aria-hidden="true"
            />
            <h2 class="text-sm font-semibold text-ink">
              {{ job.running.value ? 'Downloading from Steam' : 'Download result' }}
            </h2>
          </div>
          <span class="text-xs capitalize text-ink-faint">{{ job.status.value }}</span>
        </div>
        <pre class="max-h-72 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"><span
          v-for="line in job.lines.value"
          :key="line.seq"
          class="block"
          :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
        >{{ line.message }}</span></pre>
      </section>

      <section class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 class="text-sm font-semibold text-ink">Installed items</h2>
            <p class="mt-0.5 text-xs text-ink-faint">
              {{ installedCount }} of {{ items.length }} ready · {{ formatBytes(totalBytes) }}
              <template v-if="status.configPath">
                · listed in <span class="font-mono">{{ status.configPath }}</span>
              </template>
            </p>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="items.length === 0 || busy || job.running.value"
            title="Re-download every item, which is how a mod gets its latest version"
            @click="update()"
          >
            <RefreshCw :size="14" aria-hidden="true" /> Update all
          </button>
        </div>

        <EmptyState
          v-if="items.length === 0"
          :icon="Package"
          flush
          title="No Workshop items yet"
          :description="status.searchable
            ? 'Search above and press Add to server on anything you want this server to run.'
            : 'Find a mod on the Steam Workshop, copy the address from your browser, and paste it above.'"
        />

        <ul v-else class="divide-y divide-line">
          <li v-for="item in items" :key="item.publishedFileId" class="flex flex-wrap items-center gap-3 px-4 py-3">
            <img
              v-if="item.hasPreview"
              :src="previewUrl(item.publishedFileId)"
              alt=""
              class="h-12 w-12 shrink-0 rounded-lg object-cover"
              loading="lazy"
            />
            <div v-else class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-elevated">
              <Package :size="18" class="text-ink-faint" aria-hidden="true" />
            </div>

            <div class="min-w-48 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <a
                  :href="steamPage(item.publishedFileId)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="truncate text-sm font-medium text-ink hover:text-brand-bright"
                >
                  {{ item.title }}
                </a>
                <span
                  class="rounded-full px-2 py-0.5 text-[0.65rem] uppercase tracking-wide"
                  :class="{
                    'bg-ok-soft text-ok': item.state === 'installed',
                    'bg-warn-soft text-warn': item.state === 'pending',
                    'bg-danger-soft text-danger': item.state === 'failed',
                  }"
                >
                  {{ item.state }}
                </span>
              </div>
              <p class="mt-0.5 font-mono text-xs text-ink-faint">
                {{ item.publishedFileId }}
                <template v-if="item.sizeBytes > 0"> · {{ formatBytes(item.sizeBytes) }}</template>
                <template v-if="item.modIds.length > 0"> · {{ item.modIds.join(', ') }}</template>
              </p>
              <p v-if="item.message" class="mt-1 text-xs text-danger">{{ item.message }}</p>
            </div>

            <div class="flex gap-2">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy || job.running.value"
                :title="item.state === 'failed' ? 'Try the download again' : 'Download the latest version'"
                @click="update(item.publishedFileId)"
              >
                <RefreshCw :size="14" aria-hidden="true" />
                {{ item.state === 'failed' ? 'Retry' : 'Update' }}
              </button>
              <Tooltip :text="`Remove ${item.title}`">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-danger"
                  :disabled="busy || job.running.value"
                  :aria-label="`Remove ${item.title}`"
                  @click="remove(item)"
                >
                  <Trash2 :size="14" aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <EmptyState
      v-else
      :icon="Package"
      title="This game has no Steam Workshop"
      description="Mods for this game are installed by putting their files in the Files tab."
    />
  </div>
</template>
