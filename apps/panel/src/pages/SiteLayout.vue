<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import {
  Activity,
  ArrowLeft,
  Archive,
  AtSign,
  Boxes,
  Code2,
  Database,
  ExternalLink,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe2,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  ScrollText,
  SlidersHorizontal,
} from 'lucide-vue-next';
import type { CheckState } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { siteContextKey, type SiteDetail } from '../lib/site-context';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';
import StatusBadge from '../components/StatusBadge.vue';
import AlertMessage from '../components/AlertMessage.vue';
import LoadingBlock from '../components/LoadingBlock.vue';

/**
 * One website, and everything you can do to it.
 *
 * This is the shape a hosting panel wants: the website is the object, and
 * files, DNS and settings are tools applied to it. Fetching happens here so
 * moving between tabs does not blank the header and re-ask the server.
 *
 * Deployment lives here too rather than on the overview tab. A build takes
 * minutes, and having it stop reporting because you wandered off to look at
 * the files would be a poor way to treat the one thing you are waiting for.
 */

const route = useRoute();
const slug = computed(() => route.params['slug'] as string);

const site = ref<SiteDetail | null>(null);
type ListedSite = Awaited<ReturnType<typeof api.sites.list.query>>[number];
const children = ref<ListedSite[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const job = useJobLog({ onFinished: () => load() });

const deploying = computed(() => job.running.value);

const deployState = computed<CheckState>(() => {
  if (deploying.value) return 'checking';
  if (job.status.value === 'failed') return 'blocked';
  if (job.status.value === 'succeeded') return 'ok';

  const last = site.value?.deployments?.[0];
  if (!last) return 'absent';
  if (last.status === 'succeeded') return 'ok';
  if (last.status === 'failed') return 'blocked';
  return 'unknown';
});

const deployLabel = computed(() => {
  // The files arrived: calling that "unknown" would hide the one thing to do.
  if (!deploying.value && site.value?.deployments?.[0]?.status === 'needs-setup') {
    return 'Needs setup';
  }

  switch (deployState.value) {
    case 'checking':
      return 'Deploying';
    case 'ok':
      return 'Live';
    case 'blocked':
      return 'Deploy failed';
    case 'absent':
      return 'Not deployed';
    default:
      return 'Unknown';
  }
});

const canAddSubdomain = computed(
  () => site.value !== null && !site.value.isSubdomain && site.value.domains.length > 0,
);

/*
 * Tabs are filtered by what the website actually is.
 *
 * A static site has no application to restart and an uploaded one has no
 * repository to pull, so offering those tabs would only lead to a page
 * explaining that they do not apply here.
 */
const TABS = computed(() => {
  const runsAProcess = site.value?.runtime === 'node' || site.value?.runtime === 'dotnet';
  const isPhp = site.value?.runtime === 'php';

  return [
    { name: 'site-detail', label: 'Overview', icon: Gauge, show: true },
    { name: 'site-files', label: 'Files', icon: FolderOpen, show: true },
    { name: 'site-git', label: 'Git', icon: GitBranch, show: site.value?.sourceKind === 'git' },
    {
      name: 'site-app',
      label: site.value?.runtime === 'dotnet' ? '.NET' : 'Node.js',
      icon: Boxes,
      show: runsAProcess,
    },
    { name: 'site-php', label: 'PHP', icon: Code2, show: isPhp },
    /*
     * Databases used to be a PHP and WordPress affair, because MariaDB was
     * the only engine and PHP was the only thing that asked for it. Now that
     * a Node or .NET site can be given PostgreSQL or MongoDB just as easily,
     * what decides the tab is whether this server has a database at all —
     * not what the site happens to be written in.
     */
    { name: 'site-databases', label: 'Databases', icon: Database, show: hasDatabases.value },
    { name: 'site-traffic', label: 'Traffic', icon: Activity, show: true },
    { name: 'site-logs', label: 'Logs', icon: ScrollText, show: true },
    { name: 'site-backup', label: 'Backup', icon: Archive, show: true },
    { name: 'site-dns', label: 'DNS', icon: Globe2, show: true },
    { name: 'site-ssl', label: 'SSL', icon: ShieldCheck, show: true },
    { name: 'site-email', label: 'Email', icon: AtSign, show: true },
    { name: 'site-settings', label: 'Settings', icon: SlidersHorizontal, show: true },
  ].filter((tab) => tab.show);
});

/**
 * Whether this server can offer databases at all.
 *
 * Asked of the server rather than assumed from the runtime, and false until
 * the answer arrives, so the tab never appears and then disappears again.
 */
const hasDatabases = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  children.value = [];

  try {
    const loaded = await api.sites.get.query({ slug: slug.value });
    site.value = loaded;

    if (!loaded.isSubdomain) {
      try {
        const listed = await api.sites.list.query();
        children.value = listed.filter((entry) => entry.parentSlug === loaded.slug);
      } catch {
        // The site itself is still useful when the list decoration is unavailable.
      }
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function deploy(): Promise<void> {
  error.value = null;

  try {
    const result = await api.sites.deploy.mutate({ slug: slug.value });
    job.watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    job.reset();
  }
}

watch(slug, load, { immediate: true });

// Asked once for the whole layout: the answer is about the machine and the
// account, not about this website, so it does not change between sites.
void api.databases.engines
  .query()
  .then((result) => (hasDatabases.value = result.visible))
  .catch(() => undefined);

provide(siteContextKey, { site, reload: load, deploy, deploying });
</script>

<template>
  <div class="mx-auto w-full max-w-7xl">
    <RouterLink
      to="/sites"
      class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft :size="15" aria-hidden="true" /> All websites
    </RouterLink>

    <LoadingBlock v-if="loading && !site" class="h-40 rounded-card bg-surface" />

    <AlertMessage v-else-if="error && !site">{{ error }}</AlertMessage>

    <template v-else-if="site">
      <header class="card mb-6 p-5 md:p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2.5">
              <h2 class="truncate text-xl font-semibold tracking-tight text-ink">
                {{ site.displayName }}
              </h2>
              <StatusBadge :state="deployState" :label="deployLabel" size="sm" />
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <RouterLink
                v-if="site.isSubdomain && site.parentSlug"
                :to="`/sites/${site.parentSlug}`"
                class="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-brand-bright"
              >
                Subdomain of {{ site.parentSlug }}
              </RouterLink>
              <a
                v-for="domain in site.domains"
                :key="domain"
                :href="`https://${domain}`"
                target="_blank"
                rel="noreferrer noopener"
                class="inline-flex items-center gap-1 text-sm text-brand-bright hover:underline"
              >
                {{ domain }}
                <ExternalLink :size="12" aria-hidden="true" />
              </a>
              <span v-if="site.domains.length === 0" class="text-sm text-ink-faint">
                No web address yet
              </span>

              <!-- The address that works without DNS, so it belongs next to the one that needs it. -->
              <a
                v-if="site.previewUrl"
                :href="site.previewUrl"
                target="_blank"
                rel="noreferrer noopener"
                class="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-0.5 font-mono text-xs text-ink-muted hover:text-ink"
                title="Reaches this website by IP address, whether or not its domain is set up"
              >
                {{ site.previewUrl.replace('http://', '') }}
                <ExternalLink :size="11" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <RouterLink
              v-if="canAddSubdomain"
              :to="{ path: '/sites/new', query: { parent: site.slug } }"
              class="btn btn-ghost"
            >
              <Plus :size="15" aria-hidden="true" /> Add subdomain
            </RouterLink>
            <button type="button" class="btn btn-primary" :disabled="deploying" @click="deploy">
              <component
                :is="deploying ? RefreshCw : Rocket"
                :size="15"
                :class="deploying ? 'animate-spin' : ''"
                aria-hidden="true"
              />
              {{ deploying ? 'Deploying\u2026' : 'Deploy now' }}
            </button>
          </div>
        </div>

        <nav
          class="-mb-1 mt-4 flex gap-6 overflow-x-auto border-t border-line pt-1"
          aria-label="Website tools"
        >
          <RouterLink
            v-for="tab in TABS"
            :key="tab.name"
            :to="{ name: tab.name, params: { slug } }"
            class="tab shrink-0 whitespace-nowrap"
            :class="route.name === tab.name ? 'tab-active' : ''"
          >
            <component :is="tab.icon" :size="15" aria-hidden="true" />
            {{ tab.label }}
          </RouterLink>
        </nav>
      </header>

      <section v-if="!site.isSubdomain && children.length > 0" class="card mb-6 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold text-ink">Subdomains</h3>
            <p class="mt-0.5 text-sm text-ink-muted">
              Independent websites hosted beneath {{ site.domains[0] }}.
            </p>
          </div>
          <span class="text-xs text-ink-faint">
            {{ children.length }} {{ children.length === 1 ? 'website' : 'websites' }}
          </span>
        </div>

        <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <RouterLink
            v-for="child in children"
            :key="child.id"
            :to="`/sites/${child.slug}`"
            class="group flex min-w-0 items-center gap-3 rounded-lg border border-line
                   bg-black/20 px-3 py-2.5 transition-colors hover:border-brand/40 hover:bg-brand-soft/20"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line
                     bg-elevated/70 text-brand-bright"
              aria-hidden="true"
            >
              <Globe2 :size="16" />
            </span>
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-ink group-hover:text-brand-bright">
                {{ child.displayName }}
              </span>
              <span class="block truncate font-mono text-xs text-ink-muted">
                {{ child.domains[0] ?? 'No web address yet' }}
              </span>
            </span>
          </RouterLink>
        </div>
      </section>

      <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

      <!-- Live deploy output, visible from whichever tab you are on. -->
      <section v-if="job.lines.value.length > 0" class="card mb-6 overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 class="text-sm font-medium text-ink">Deployment output</h3>
          <StatusBadge :state="deployState" :label="deployLabel" size="sm" />
        </div>
        <pre
          class="max-h-96 overflow-y-auto whitespace-pre-wrap break-words bg-black/25 p-4
                 font-mono text-xs leading-relaxed"
        ><span
          v-for="line in job.lines.value"
          :key="line.seq"
          class="block"
          :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
        >{{ line.message }}</span></pre>
      </section>

      <RouterView />
    </template>
  </div>
</template>
