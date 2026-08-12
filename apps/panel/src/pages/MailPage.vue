<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { AtSign, ChevronRight, Globe, Inbox, Search, Server } from 'lucide-vue-next';
import { mailHostnameFor } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { formatBytes } from '../lib/format';
import PageHeader from '../components/PageHeader.vue';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PaginationBar from '../components/PaginationBar.vue';

/**
 * Email across the whole server.
 *
 * Deliberately not a place to manage mailboxes. A mailbox belongs to a domain
 * and a domain belongs to a website, so this page answers "which website?" and
 * then gets out of the way. What it is good for is the two facts that belong
 * to no single site: whether the mail server is running at all, and how much
 * mail is sitting on this machine.
 *
 * Counts are fetched for the visible page only. Asking the mail server about
 * every domain on a server with a hundred of them would be a hundred requests
 * to render one screen.
 */

type ServerStatus = Awaited<ReturnType<typeof api.mail.serverStatus.query>>;

interface DomainRow {
  slug: string;
  siteName: string;
  domain: string;
  mailHostname: string;
  mailboxes: number;
  usedBytes: number;
  /** False until the mail server has been asked about this domain. */
  known: boolean;
}

const PAGE_SIZE = 12;

const status = ref<ServerStatus | null>(null);
const rows = ref<DomainRow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const query = ref('');
const page = ref(1);

const matching = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return rows.value;

  return rows.value.filter(
    (row) =>
      row.domain.toLowerCase().includes(needle) || row.siteName.toLowerCase().includes(needle),
  );
});

const visible = computed(() =>
  matching.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

const totals = computed(() => {
  const counted = rows.value.filter((row) => row.known);
  return {
    mailboxes: counted.reduce((sum, row) => sum + row.mailboxes, 0),
    usedBytes: counted.reduce((sum, row) => sum + row.usedBytes, 0),
    complete: counted.length === rows.value.length,
  };
});

async function loadCountsForPage(): Promise<void> {
  if (!status.value?.connected) return;

  await Promise.all(
    visible.value
      .filter((row) => !row.known)
      .map(async (row) => {
        try {
          const mailboxes = await api.mail.mailboxes.query({ domain: row.domain });
          row.mailboxes = mailboxes.length;
          row.usedBytes = mailboxes.reduce((sum, mailbox) => sum + mailbox.usedBytes, 0);
          row.known = true;
        } catch {
          // One unreadable domain should not blank the whole page.
        }
      }),
  );
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const [serverStatus, sites] = await Promise.all([
      api.mail.serverStatus.query(),
      api.sites.list.query(),
    ]);
    status.value = serverStatus;

    // One row per site, on its primary domain. `www.` is skipped: nobody
    // wants a mailbox at www.example.com.
    rows.value = sites
      .map((site) => ({
        slug: site.slug,
        siteName: site.displayName,
        domain: site.domains.find((name) => !name.toLowerCase().startsWith('www.')) ?? '',
      }))
      .filter((candidate) => candidate.domain.length > 0)
      .map((candidate) => ({
        ...candidate,
        mailHostname: mailHostnameFor(candidate.domain),
        mailboxes: 0,
        usedBytes: 0,
        known: false,
      }));

    await loadCountsForPage();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

watch(matching, () => {
  const lastPage = Math.max(1, Math.ceil(matching.value.length / PAGE_SIZE));
  if (page.value > lastPage) page.value = lastPage;
});

watch(visible, () => void loadCountsForPage());

void load();
</script>

<template>
  <div class="mx-auto w-full max-w-5xl">
    <PageHeader
      title="Email"
      description="Mailboxes live with the website that owns the domain. Pick one to add
                   addresses, set how much space each gets, or check delivery."
    >
      <template #actions>
        <label v-if="rows.length > 5" class="relative">
          <Search
            :size="15"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <input
            v-model="query"
            class="field w-52 pl-9"
            placeholder="Search domains"
            aria-label="Search domains"
          />
        </label>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>

    <LoadingBlock v-if="loading" class="h-64 rounded-card bg-surface" />

    <template v-else>
      <section class="card mb-5 flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                   border-line"
            :class="status?.connected ? 'bg-ok-soft/50 text-ok' : 'bg-warn-soft/50 text-warn'"
            aria-hidden="true"
          >
            <Server :size="19" />
          </span>

          <div class="min-w-0">
            <h2 class="text-base font-semibold text-ink">Mail server</h2>
            <p class="mt-1 text-sm text-ink-muted">{{ status?.message }}</p>
          </div>
        </div>

        <dl v-if="status?.connected" class="flex gap-8">
          <div>
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Mailboxes</dt>
            <dd class="text-2xl font-semibold text-ink">
              {{ totals.mailboxes }}<span v-if="!totals.complete" class="text-ink-faint">+</span>
            </dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-ink-faint">Mail stored</dt>
            <dd class="text-2xl font-semibold text-ink">{{ formatBytes(totals.usedBytes) }}</dd>
          </div>
        </dl>

        <RouterLink v-else to="/settings" class="btn btn-primary">Connect it</RouterLink>
      </section>

      <EmptyState
        v-if="rows.length === 0"
        :icon="Globe"
        title="No domains to put mail on"
        description="Email needs a domain, and domains come from websites. Add a website with a
                     web address and it will appear here."
      >
        <RouterLink to="/sites/new" class="btn btn-primary mt-5">Add a website</RouterLink>
      </EmptyState>

      <p v-else-if="matching.length === 0" class="py-12 text-center text-sm text-ink-muted">
        Nothing matches "{{ query }}".
      </p>

      <template v-else>
        <div class="card overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr
                class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint"
              >
                <th scope="col" class="px-5 py-3 font-medium">Domain</th>
                <th scope="col" class="px-5 py-3 font-medium">Website</th>
                <th scope="col" class="px-5 py-3 font-medium">Mailboxes</th>
                <th scope="col" class="hidden px-5 py-3 font-medium md:table-cell">Stored</th>
                <th scope="col" class="w-px px-5 py-3"><span class="sr-only">Manage</span></th>
              </tr>
            </thead>

            <tbody class="divide-y divide-line">
              <tr
                v-for="row in visible"
                :key="row.slug"
                class="transition-colors hover:bg-white/[0.03]"
              >
                <td class="whitespace-nowrap px-5 py-3">
                  <RouterLink
                    :to="`/sites/${row.slug}/email`"
                    class="flex items-center gap-2 font-mono text-ink hover:text-brand-bright"
                  >
                    <AtSign :size="14" class="shrink-0 text-ink-faint" aria-hidden="true" />
                    {{ row.domain }}
                  </RouterLink>
                </td>

                <td class="px-5 py-3 text-ink-muted">{{ row.siteName }}</td>

                <td class="whitespace-nowrap px-5 py-3">
                  <span v-if="row.known" class="flex items-center gap-1.5 text-ink">
                    <Inbox :size="13" class="text-ink-faint" aria-hidden="true" />
                    {{ row.mailboxes }}
                  </span>
                  <span v-else class="text-ink-faint">&mdash;</span>
                </td>

                <td class="hidden whitespace-nowrap px-5 py-3 text-ink-muted md:table-cell">
                  {{ row.known ? formatBytes(row.usedBytes) : '\u2014' }}
                </td>

                <td class="w-px whitespace-nowrap px-5 py-3 text-right">
                  <RouterLink
                    :to="`/sites/${row.slug}/email`"
                    class="inline-flex items-center gap-1 text-xs text-ink-muted
                           hover:text-brand-bright"
                  >
                    Manage
                    <ChevronRight :size="14" aria-hidden="true" />
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <PaginationBar
          v-model:page="page"
          :total="matching.length"
          :page-size="PAGE_SIZE"
          noun="domains"
        />
      </template>
    </template>
  </div>
</template>
