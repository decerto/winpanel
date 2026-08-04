<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  AtSign,
  ExternalLink,
  FolderOpen,
  Globe,
  Globe2,
  LayoutGrid,
  Plus,
  Rows3,
  Search,
  SlidersHorizontal,
} from 'lucide-vue-next';
import EmptyState from '../components/EmptyState.vue';
import AlertMessage from '../components/AlertMessage.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationBar from '../components/PaginationBar.vue';
import ViewToggle from '../components/ViewToggle.vue';
import SiteCard from '../components/SiteCard.vue';
import { api, describeError } from '../lib/api';
import { usePreference } from '../lib/preferences';
import { RUNTIME_LABEL, siteStatus } from '../lib/site-status';

/**
 * The websites list, and the front door of the panel.
 *
 * Two layouts, because two different jobs bring people here. Cards are for
 * working on a handful of sites: everything about one is visible, and its
 * tools are one click away. The table is for a server with fifty of them,
 * where the question is "which one" rather than "what about this one".
 *
 * Both are paged. A list that grows without limit eventually stops being a
 * list and becomes a scroll.
 */

const router = useRouter();

type Site = Awaited<ReturnType<typeof api.sites.list.query>>[number];

const sites = ref<Site[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const query = ref('');
const page = ref(1);

const view = usePreference('sites.view', 'cards', ['cards', 'table'] as const);

const VIEWS = [
  { value: 'cards', label: 'Cards', icon: LayoutGrid },
  { value: 'table', label: 'Table', icon: Rows3 },
] as const;

const TOOLS = [
  { path: 'files', label: 'Files', icon: FolderOpen },
  { path: 'dns', label: 'DNS', icon: Globe2 },
  { path: 'email', label: 'Email', icon: AtSign },
  { path: 'settings', label: 'Settings', icon: SlidersHorizontal },
] as const;

// Cards are much taller than rows, so each view gets a page size that fills a
// screen rather than one number that suits neither.
const pageSize = computed(() => (view.value === 'cards' ? 5 : 15));

const matching = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return sites.value;

  return sites.value.filter(
    (site) =>
      site.displayName.toLowerCase().includes(needle) ||
      site.domains.some((domain) => domain.toLowerCase().includes(needle)),
  );
});

const visible = computed(() =>
  matching.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);

// Filtering or resizing the page can strand you past the end of the results.
watch([matching, pageSize], () => {
  const lastPage = Math.max(1, Math.ceil(matching.value.length / pageSize.value));
  if (page.value > lastPage) page.value = lastPage;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    sites.value = await api.sites.list.query();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="max-w-7xl">
    <PageHeader
      title="Websites"
      description="Everything this server hosts. Open one, or jump straight to its files, DNS or
                   mailboxes."
    >
      <template #actions>
        <label v-if="sites.length > 3" class="relative">
          <Search
            :size="15"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <input
            v-model="query"
            class="field w-52 pl-9"
            placeholder="Search"
            aria-label="Search websites"
          />
        </label>

        <ViewToggle v-if="sites.length > 1" v-model="view" :options="VIEWS" />

        <button
          v-if="sites.length > 0"
          type="button"
          class="btn btn-primary"
          @click="router.push('/sites/new')"
        >
          <Plus :size="15" aria-hidden="true" /> Add a website
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

    <div v-if="loading" class="space-y-4">
      <div v-for="n in 3" :key="n" class="h-64 animate-pulse rounded-card bg-surface" />
    </div>

    <EmptyState
      v-else-if="sites.length === 0"
      :icon="Globe"
      title="No websites yet"
      description="Add your first website and the panel will work out how to build it, point your
                   domain here, and secure it with HTTPS."
      action-label="Add a website"
      @action="router.push('/sites/new')"
    />

    <p v-else-if="matching.length === 0" class="py-12 text-center text-sm text-ink-muted">
      Nothing matches "{{ query }}".
    </p>

    <template v-else>
      <div v-if="view === 'cards'" class="space-y-4">
        <SiteCard v-for="site in visible" :key="site.id" :site="site" />
      </div>

      <div v-else class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th scope="col" class="px-5 py-3 font-medium">Website</th>
              <th scope="col" class="hidden px-5 py-3 font-medium md:table-cell">Type</th>
              <th scope="col" class="hidden px-5 py-3 font-medium lg:table-cell">Port</th>
              <th scope="col" class="px-5 py-3 font-medium">Status</th>
              <th scope="col" class="w-px whitespace-nowrap px-5 py-3 text-right font-medium">
                Open
              </th>
            </tr>
          </thead>

          <tbody class="divide-y divide-line">
            <tr
              v-for="site in visible"
              :key="site.id"
              class="transition-colors hover:bg-white/[0.03]"
            >
              <td class="max-w-0 px-5 py-3">
                <RouterLink
                  :to="`/sites/${site.slug}`"
                  class="block truncate font-medium text-ink hover:text-brand-bright"
                >
                  {{ site.displayName }}
                </RouterLink>
                <span class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-muted">
                  <a
                    v-if="site.domains[0]"
                    :href="`https://${site.domains[0]}`"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex min-w-0 items-center gap-1 hover:text-brand-bright"
                  >
                    <span class="truncate">{{ site.domains[0] }}</span>
                    <ExternalLink :size="10" class="shrink-0" aria-hidden="true" />
                  </a>
                  <span v-else class="text-ink-faint">No web address yet</span>
                  <span v-if="site.domains.length > 1" class="shrink-0 text-ink-faint">
                    +{{ site.domains.length - 1 }}
                  </span>
                </span>
              </td>

              <td class="hidden whitespace-nowrap px-5 py-3 text-ink-muted md:table-cell">
                {{ RUNTIME_LABEL[site.runtime] ?? site.runtime }}
              </td>

              <td class="hidden whitespace-nowrap px-5 py-3 font-mono text-ink-muted lg:table-cell">
                {{ site.activePort ?? '\u2014' }}
              </td>

              <td class="whitespace-nowrap px-5 py-3">
                <span class="flex items-center gap-2 text-xs">
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    :class="siteStatus(site).dot"
                    aria-hidden="true"
                  />
                  <span :class="siteStatus(site).text">{{ siteStatus(site).label }}</span>
                </span>
              </td>

              <td class="w-px px-5 py-3">
                <div class="flex items-center justify-end gap-1">
                  <RouterLink
                    v-for="tool in TOOLS"
                    :key="tool.path"
                    :to="`/sites/${site.slug}/${tool.path}`"
                    class="rounded-md p-1.5 text-ink-faint transition-colors
                           hover:bg-brand-soft/50 hover:text-brand-bright"
                    :title="tool.label"
                    :aria-label="`${tool.label} for ${site.displayName}`"
                  >
                    <component :is="tool.icon" :size="15" />
                  </RouterLink>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PaginationBar
        v-model:page="page"
        :total="matching.length"
        :page-size="pageSize"
        noun="websites"
      />
    </template>
  </div>
</template>
