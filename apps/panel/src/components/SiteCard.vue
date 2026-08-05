<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AtSign,
  Boxes,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Globe,
  Globe2,
  HardDrive,
  KeyRound,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { formatBytes } from '../lib/format';
import { RUNTIME_LABEL, siteStatus } from '../lib/site-status';

/**
 * One website, as a full-width card.
 *
 * Modelled on the shape control panels have settled on for good reason: the
 * website is a heading, and everything you might do to it is a labelled tile
 * underneath, grouped by the job rather than by which page happens to hold it.
 * Making someone open the site and then hunt for a tab is two clicks to reach
 * every task, and it hides the tools that exist from anyone who has not
 * already learned they do.
 *
 * Tiles are only rendered when they mean something: a static site has no
 * runtime to manage, and a site created from an upload has no repository.
 * A tile that leads to "this does not apply here" is worse than no tile.
 */

type Site = Awaited<ReturnType<typeof api.sites.list.query>>[number];
type Certificate = Awaited<ReturnType<typeof api.ssl.overview.query>>[number];

const props = defineProps<{ site: Site; certificate?: Certificate }>();

const status = computed(() => siteStatus(props.site));
const primary = computed(() => props.site.domains[0] ?? null);
const extras = computed(() => Math.max(0, props.site.domains.length - 2));

/*
 * Certificate state, in the words a tile has room for.
 *
 * Passed down rather than fetched here: the answer for every website comes
 * from one request on the list page, and forty cards each asking for their
 * own is forty round trips for the same file read.
 */
const CERTIFICATE_DETAIL = {
  valid: 'Secured with HTTPS',
  expiring: 'Renewing soon',
  expired: 'Certificate expired',
  absent: 'No certificate yet',
  'no-domain': 'Needs a domain first',
} as const;

const sslDetail = computed(() =>
  props.certificate ? CERTIFICATE_DETAIL[props.certificate.state] : 'Certificates and Cloudflare',
);

const sslTint = computed(() => {
  switch (props.certificate?.state) {
    case 'valid':
      return 'text-ok';
    case 'expiring':
      return 'text-warn';
    case 'expired':
      return 'text-danger';
    default:
      return 'text-ink-muted';
  }
});

const isGit = computed(() => props.site.sourceKind === 'git');
const runsAProcess = computed(
  () => props.site.runtime === 'node' || props.site.runtime === 'dotnet',
);

const usedBytes = ref<number | null>(null);
const usageError = ref<string | null>(null);

/*
 * Measured on mount rather than sent with the list.
 *
 * Working out a site's size means walking every file it owns, which is fine
 * for the few cards on screen and unacceptable for a list of fifty. Failing
 * is not worth an error banner - the figure simply stays a dash.
 */
onMounted(async () => {
  try {
    const usage = await api.sites.usage.query({ slug: props.site.slug });
    usedBytes.value = usage.usedBytes;
  } catch (error) {
    usageError.value = describeError(error);
  }
});

interface Tile {
  label: string;
  detail: string;
  icon: unknown;
  /** Internal route, or an external address opened in a new tab. */
  to?: string;
  href?: string;
  tint: string;
}

const fileTiles = computed<Tile[]>(() => [
  {
    label: 'Files',
    detail: isGit.value ? 'Deployed release' : 'Your public folder',
    icon: FolderOpen,
    to: `/sites/${props.site.slug}/files`,
    tint: 'text-info',
  },
  {
    label: 'Secrets & settings',
    detail: 'Environment values',
    icon: KeyRound,
    to: `/sites/${props.site.slug}/settings`,
    tint: 'text-warn',
  },
  {
    label: 'Deployments',
    detail: 'History and logs',
    icon: Rocket,
    to: `/sites/${props.site.slug}`,
    tint: 'text-brand-bright',
  },
]);

const devTiles = computed<Tile[]>(() => {
  const tiles: Tile[] = [];

  if (isGit.value) {
    tiles.push({
      label: 'Git',
      detail: 'Pull and deploy',
      icon: GitBranch,
      to: `/sites/${props.site.slug}/git`,
      tint: 'text-danger',
    });
  }

  if (runsAProcess.value) {
    tiles.push({
      label: props.site.runtime === 'dotnet' ? '.NET' : 'Node.js',
      detail: 'Restart, scripts, env',
      icon: Boxes,
      to: `/sites/${props.site.slug}/app`,
      tint: 'text-ok',
    });
    tiles.push({
      label: 'Run commands',
      detail: 'npm, node, one-offs',
      icon: Terminal,
      to: `/sites/${props.site.slug}/app?tab=commands`,
      tint: 'text-ink-muted',
    });
  }

  return tiles;
});

const domainTiles = computed<Tile[]>(() => {
  const tiles: Tile[] = [
    {
      label: 'DNS',
      detail: 'Records and where the domain points',
      icon: Globe2,
      to: `/sites/${props.site.slug}/dns`,
      tint: 'text-info',
    },
    {
      label: 'SSL',
      detail: sslDetail.value,
      icon: ShieldCheck,
      to: `/sites/${props.site.slug}/ssl`,
      tint: sslTint.value,
    },
    {
      label: 'Email',
      detail: 'Mailboxes for this domain',
      icon: AtSign,
      to: `/sites/${props.site.slug}/email`,
      tint: 'text-brand-bright',
    },
  ];

  if (props.site.previewUrl) {
    tiles.push({
      label: 'Preview',
      detail: 'Works before DNS does',
      icon: ExternalLink,
      href: props.site.previewUrl,
      tint: 'text-ink-muted',
    });
  }

  return tiles;
});

const groups = computed(() =>
  [
    { title: 'Files & Settings', tiles: fileTiles.value },
    { title: 'Dev Tools', tiles: devTiles.value },
    { title: 'Domains & Mail', tiles: domainTiles.value },
  ].filter((group) => group.tiles.length > 0),
);

const contentPath = computed(() => (isGit.value ? 'release' : 'public'));
</script>

<template>
  <article class="card card-interactive overflow-hidden">
    <!-- Header: the website itself, its state, and the numbers worth a glance. -->
    <header class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-3.5">
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line
               bg-brand-soft/50 text-brand-bright"
        aria-hidden="true"
      >
        <Globe :size="17" />
      </span>

      <div class="min-w-0 flex-1">
        <RouterLink
          :to="`/sites/${site.slug}`"
          class="block truncate text-base font-semibold text-ink hover:text-brand-bright"
        >
          {{ site.displayName }}
        </RouterLink>

        <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-sm">
          <a
            v-for="domain in site.domains.slice(0, 2)"
            :key="domain"
            :href="`https://${domain}`"
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex min-w-0 items-center gap-1 text-ink-muted hover:text-brand-bright"
          >
            <span class="truncate">{{ domain }}</span>
            <ExternalLink :size="11" class="shrink-0" aria-hidden="true" />
          </a>
          <span v-if="extras > 0" class="text-xs text-ink-faint">+{{ extras }} more</span>
          <span v-if="!primary" class="text-ink-faint">No web address yet</span>
        </div>
      </div>

      <span class="flex shrink-0 items-center gap-2 text-xs">
        <span class="h-1.5 w-1.5 rounded-full" :class="status.dot" aria-hidden="true" />
        <span :class="status.text">{{ status.label }}</span>
      </span>

      <span
        class="hidden shrink-0 items-center gap-1.5 text-xs text-ink-muted sm:flex"
        :title="usageError ?? 'Disk used by this website'"
      >
        <HardDrive :size="13" class="text-ink-faint" aria-hidden="true" />
        {{ usedBytes === null ? '\u2014' : formatBytes(usedBytes) }}
      </span>

      <RouterLink
        :to="`/sites/${site.slug}/settings`"
        class="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-brand-soft/50
               hover:text-brand-bright"
        :aria-label="`Settings for ${site.displayName}`"
      >
        <SlidersHorizontal :size="15" />
      </RouterLink>
    </header>

    <div class="grid gap-5 p-5 lg:grid-cols-[minmax(0,15rem)_1fr]">
      <!-- Statistics, as a panel of facts rather than a sentence to read. -->
      <dl
        class="grid grid-cols-2 gap-x-4 gap-y-3 self-start rounded-xl border border-line
               bg-sunken/60 p-4 text-sm lg:grid-cols-1"
      >
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Type</dt>
          <dd class="mt-0.5 truncate text-ink">{{ RUNTIME_LABEL[site.runtime] ?? site.runtime }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Disk space</dt>
          <dd class="mt-0.5 text-ink">
            {{ usedBytes === null ? 'Measuring\u2026' : formatBytes(usedBytes) }}
          </dd>
        </div>
        <div v-if="runsAProcess" class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Port</dt>
          <dd class="mt-0.5 font-mono text-ink">{{ site.activePort ?? '\u2014' }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Changed</dt>
          <dd class="mt-0.5 truncate text-ink-muted">
            {{ new Date(site.updatedAt).toLocaleDateString() }}
          </dd>
        </div>
      </dl>

      <div class="space-y-4">
        <section v-for="group in groups" :key="group.title">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {{ group.title }}
          </h3>

          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <component
              :is="tile.to ? RouterLink : 'a'"
              v-for="tile in group.tiles"
              :key="tile.label"
              v-bind="
                tile.to
                  ? { to: tile.to }
                  : { href: tile.href, target: '_blank', rel: 'noreferrer noopener' }
              "
              class="group flex items-center gap-3 rounded-lg border border-line bg-white/[0.02]
                     px-3 py-2.5 transition-colors hover:border-brand/40 hover:bg-brand-soft/30"
            >
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border
                       border-line bg-elevated/70"
                :class="tile.tint"
                aria-hidden="true"
              >
                <component :is="tile.icon" :size="16" />
              </span>
              <span class="min-w-0">
                <span
                  class="block truncate text-sm font-medium text-ink group-hover:text-brand-bright"
                >
                  {{ tile.label }}
                </span>
                <span class="block truncate text-xs text-ink-faint">{{ tile.detail }}</span>
              </span>
            </component>
          </div>
        </section>
      </div>
    </div>

    <footer
      class="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-5 py-2.5 text-xs
             text-ink-faint"
    >
      <span>
        Website at
        <RouterLink
          :to="`/sites/${site.slug}/files`"
          class="font-mono text-ink-muted hover:text-brand-bright"
        >
          {{ contentPath }}
        </RouterLink>
      </span>
      <span v-if="runsAProcess && site.activePort">
        Port <span class="font-mono text-ink-muted">{{ site.activePort }}</span>
      </span>
      <a
        v-if="site.previewUrl"
        :href="site.previewUrl"
        target="_blank"
        rel="noreferrer noopener"
        class="ml-auto inline-flex items-center gap-1 font-mono hover:text-brand-bright"
      >
        {{ site.previewUrl }}
        <ExternalLink :size="10" aria-hidden="true" />
      </a>
    </footer>
  </article>
</template>
