<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { AtSign, ExternalLink, FolderOpen, Globe, Globe2, SlidersHorizontal } from 'lucide-vue-next';
import type { api } from '../lib/api';
import { RUNTIME_LABEL, siteStatus } from '../lib/site-status';

/**
 * One website, as a card.
 *
 * The quick links exist because the thing you want is almost never the site
 * overview — it is the files, or the DNS, or the mailboxes. Making you open
 * the website first and then find the tab is two clicks to reach every job.
 */

type Site = Awaited<ReturnType<typeof api.sites.list.query>>[number];

const props = defineProps<{ site: Site }>();

const status = computed(() => siteStatus(props.site));
const primary = computed(() => props.site.domains[0] ?? null);
const extras = computed(() => Math.max(0, props.site.domains.length - 2));

const TOOLS = [
  { path: 'files', label: 'Files', icon: FolderOpen },
  { path: 'dns', label: 'DNS', icon: Globe2 },
  { path: 'email', label: 'Email', icon: AtSign },
  { path: 'settings', label: 'Settings', icon: SlidersHorizontal },
] as const;
</script>

<template>
  <article class="card card-interactive flex flex-col p-5">
    <div class="flex items-start gap-3.5">
      <span
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line
               bg-brand-soft/50 text-brand-bright"
        aria-hidden="true"
      >
        <Globe :size="20" />
      </span>

      <div class="min-w-0 flex-1">
        <RouterLink
          :to="`/sites/${site.slug}`"
          class="block truncate text-base font-semibold text-ink hover:text-brand-bright"
        >
          {{ site.displayName }}
        </RouterLink>

        <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <a
            v-for="domain in site.domains.slice(0, 2)"
            :key="domain"
            :href="`https://${domain}`"
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex min-w-0 items-center gap-1 text-sm text-ink-muted
                   hover:text-brand-bright"
          >
            <span class="truncate">{{ domain }}</span>
            <ExternalLink :size="11" class="shrink-0" aria-hidden="true" />
          </a>
          <span v-if="extras > 0" class="text-xs text-ink-faint">+{{ extras }} more</span>
          <span v-if="!primary" class="text-sm text-ink-faint">No web address yet</span>
        </div>
      </div>

      <span class="flex shrink-0 items-center gap-2 text-xs">
        <span class="h-1.5 w-1.5 rounded-full" :class="status.dot" aria-hidden="true" />
        <span :class="status.text">{{ status.label }}</span>
      </span>
    </div>

    <dl class="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
      <div class="min-w-0">
        <dt class="text-xs uppercase tracking-wide text-ink-faint">Type</dt>
        <dd class="mt-0.5 truncate text-ink">{{ RUNTIME_LABEL[site.runtime] ?? site.runtime }}</dd>
      </div>
      <div class="min-w-0">
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

    <div class="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-4">
      <RouterLink
        v-for="tool in TOOLS"
        :key="tool.path"
        :to="`/sites/${site.slug}/${tool.path}`"
        class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[0.02]
               px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors
               hover:border-brand/40 hover:bg-brand-soft/40 hover:text-brand-bright"
      >
        <component :is="tool.icon" :size="13" aria-hidden="true" />
        {{ tool.label }}
      </RouterLink>
    </div>
  </article>
</template>
