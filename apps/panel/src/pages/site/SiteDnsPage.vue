<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { CloudCog, ExternalLink, Globe2, RefreshCw, Trash2 } from 'lucide-vue-next';
import { CLOUDFLARE_TOKEN_PERMISSION_ROWS, roleAtLeast, type UserRole } from '@winpanel/shared';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import HowTo from '../../components/HowTo.vue';
import LoadingBlock from '../../components/LoadingBlock.vue';
import Tooltip from '../../components/Tooltip.vue';

/**
 * DNS for this website, through Cloudflare.
 *
 * The token lives here rather than in server settings because a token only
 * reaches the zones of the Cloudflare account that issued it, and one server
 * routinely hosts domains belonging to different people. Main websites paste
 * their own token; subdomains use the validated token of their parent.
 *
 * The common case is not "edit a record" but "make this domain reach this
 * server", so that is offered as one action. The record table is underneath
 * for when the answer is more complicated than that.
 *
 * The server's address is offered rather than assumed: behind NAT, a load
 * balancer, or a provider's floating IP, the address this machine sees on its
 * own adapter is not the one the world reaches it on. It is prefilled and
 * editable, which is the difference between checking a value and typing one.
 */

const { site } = inject(siteContextKey)!;
const route = useRoute();

const IP_STORAGE_KEY = 'winpanel.serverIpv4';

type Zone = Awaited<ReturnType<typeof api.dns.zones.query>>[number];
type ZoneRecord = Awaited<ReturnType<typeof api.dns.records.query>>[number];
type Connection = Awaited<ReturnType<typeof api.dns.status.query>>;
type Plan = Awaited<ReturnType<typeof api.dns.previewPointDomain.query>>;

const slug = computed(() => route.params['slug'] as string);

const connection = ref<Connection | null>(null);
const zones = ref<Zone[]>([]);
const records = ref<ZoneRecord[] | null>(null);

const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const token = ref('');
const tokenBusy = ref(false);
const role = ref<UserRole | null>(null);
const isAdmin = computed(() => role.value !== null && roleAtLeast(role.value, 'admin'));

const serverIpv4 = ref(localStorage.getItem(IP_STORAGE_KEY) ?? '');
const proxied = ref(false);
const repointStale = ref(true);

const plan = ref<Plan | null>(null);
const planning = ref(false);
const planError = ref<string | null>(null);

const primaryDomain = computed(() => site.value?.domains[0] ?? '');
const isSubdomain = computed(() => site.value?.isSubdomain === true);
const parentSlug = computed(() => site.value?.parentSlug ?? null);

/** The Cloudflare zone this site's domain belongs to, if the account has it. */
const zone = computed(() => {
  const domain = primaryDomain.value.toLowerCase();
  if (!domain) return null;
  return (
    zones.value.find((z) => domain === z.name || domain.endsWith(`.${z.name}`)) ?? null
  );
});

const looksLikeIpv4 = computed(() =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(serverIpv4.value.trim()),
);

/** Only the edits, so "nothing to do" reads as nothing rather than a list. */
const pending = computed(
  () => plan.value?.changes.filter((change) => change.action !== 'unchanged') ?? [],
);

const removals = computed(() => pending.value.filter((change) => change.action === 'delete'));

/** Records that concern this site, rather than the whole zone. */
const relevant = computed(() => {
  const domains = (site.value?.domains ?? []).map((d) => d.toLowerCase());
  return (records.value ?? []).filter((record) => {
    const name = record.name.toLowerCase();
    return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
  });
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const me = await api.auth.me.query().catch(() => null);
    role.value = me?.role ?? null;
    connection.value = await api.dns.status.query({ slug: slug.value });

    if (!serverIpv4.value && isAdmin.value) {
      const info = await api.system.info.query().catch(() => null);
      if (info?.suggestedIpv4) serverIpv4.value = info.suggestedIpv4;
    }

    if (!connection.value.connected) return;

    zones.value = await api.dns.zones.query({ slug: slug.value });
    records.value = zone.value
      ? await api.dns.records.query({ slug: slug.value, zoneId: zone.value.id })
      : null;
    await refreshPlan();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

/**
 * Works out what pointing the domain here would change, before it changes it.
 *
 * A domain arriving from another host brings records that have to be deleted
 * rather than edited — a stray AAAA, a second A record, a CNAME where an A
 * belongs. Showing that list first is the difference between an informed click
 * and a surprise.
 */
async function refreshPlan(): Promise<void> {
  if (!zone.value || !looksLikeIpv4.value) {
    plan.value = null;
    return;
  }

  planning.value = true;
  planError.value = null;

  try {
    plan.value = await api.dns.previewPointDomain.query({
      slug: slug.value,
      domain: primaryDomain.value,
      serverIpv4: serverIpv4.value.trim(),
      proxied: proxied.value,
      repointStale: repointStale.value,
    });
  } catch (err) {
    plan.value = null;
    planError.value = describeError(err);
  } finally {
    planning.value = false;
  }
}

async function connectToken(): Promise<void> {
  tokenBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.dns.connect.mutate({ slug: slug.value, token: token.value.trim() });
    token.value = '';
    notice.value = result.warning ? `${result.message} ${result.warning}` : result.message;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    tokenBusy.value = false;
  }
}

async function forgetToken(): Promise<void> {
  if (
    !window.confirm(
      'Remove this website\u2019s own Cloudflare token?\n\n' +
        'Its DNS records are untouched. You can add a new token for this website afterwards.',
    )
  ) {
    return;
  }

  tokenBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.dns.disconnect.mutate({ slug: slug.value });
    notice.value = 'The panel has forgotten that token. No DNS records were changed.';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    tokenBusy.value = false;
  }
}

async function pointHere(): Promise<void> {
  /*
   * Deletions are the only irreversible part, and they are also the part
   * nobody expects, so they are the only part worth interrupting for.
   */
  if (removals.value.length > 0) {
    const list = removals.value
      .map((change) => `\u2022 ${change.record.type} ${change.record.name} (${change.was})`)
      .join('\n');

    if (
      !window.confirm(
        `${removals.value.length} existing DNS record${removals.value.length === 1 ? '' : 's'} ` +
          'will be deleted, because they send visitors somewhere other than this server:\n\n' +
          `${list}\n\nContinue?`,
      )
    ) {
      return;
    }
  }

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.dns.pointDomainHere.mutate({
      slug: slug.value,
      domain: primaryDomain.value,
      serverIpv4: serverIpv4.value.trim(),
      proxied: proxied.value,
      repointStale: repointStale.value,
    });
    localStorage.setItem(IP_STORAGE_KEY, serverIpv4.value.trim());
    notice.value = result.applied.length
      ? `${result.applied.join(', ')}. ${result.note}`
      : result.note;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function removeRecord(recordId: string, name: string): Promise<void> {
  if (!zone.value) return;
  if (!window.confirm(`Delete the DNS record for ${name}? This takes effect immediately.`)) return;

  try {
    await api.dns.deleteRecord.mutate({ slug: slug.value, zoneId: zone.value.id, recordId });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

watch(primaryDomain, load, { immediate: true });

/*
 * Debounced: the address field is typed into a character at a time, and
 * Cloudflare rate limits. The button is never gated on this, so a slow or
 * failed preview costs the user nothing.
 */
let planTimer: ReturnType<typeof setTimeout> | undefined;
watch([serverIpv4, proxied, repointStale], () => {
  if (loading.value) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(() => void refreshPlan(), 500);
});
onUnmounted(() => clearTimeout(planTimer));
</script>

<template>
  <div class="space-y-4">
    <LoadingBlock v-if="loading" class="h-40 rounded-card bg-surface" />

    <template v-else>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <!--
        No token that can see this domain: nothing else on this tab can work,
        so this is the whole screen rather than a notice above it.
      -->
      <section v-if="!connection?.connected" class="card p-5">
        <div class="flex items-start gap-3">
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                   border-line bg-brand-soft/50 text-brand-bright"
            aria-hidden="true"
          >
            <CloudCog :size="19" />
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="text-base font-semibold text-ink">
              {{ isSubdomain ? 'Connect Cloudflare on the parent website' : 'Connect Cloudflare for this website' }}
            </h3>
            <p v-if="isSubdomain" class="mt-1 text-sm text-ink-muted">
              This subdomain uses the Cloudflare token already connected to its parent website.
              Connect Cloudflare there first; this page will then manage only
              <span class="font-mono text-ink">{{ primaryDomain || 'this subdomain' }}</span>
              without changing the parent website or its files.
              <RouterLink
                v-if="parentSlug"
                :to="`/sites/${parentSlug}/dns`"
                class="ml-1 text-brand-bright hover:underline"
              >
                Open the parent DNS tab
              </RouterLink>
            </p>
            <p v-else class="mt-1 text-sm text-ink-muted">
              DNS and HTTPS certificates for
              <span class="font-mono text-ink">{{ primaryDomain || 'this website' }}</span>
              are managed through the Cloudflare account the domain lives in. A token only
              reaches the domains of the account that made it, so each website has its own
              &mdash; websites in the same account can share one.
            </p>
          </div>
        </div>

        <HowTo v-if="!isSubdomain" title="Creating the token in Cloudflare" class="mt-5">
          <li>
            Open
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer noopener"
            >
              Cloudflare &rarr; My Profile &rarr; API Tokens
              <ExternalLink :size="11" class="inline" aria-hidden="true" />
            </a>
            while signed in to the account that holds
            <strong>{{ primaryDomain || 'this domain' }}</strong
            >.
          </li>
          <li>Select <strong>Create Token</strong>, then <strong>Create Custom Token</strong>.</li>
          <li>
            Under Permissions add these rows, using all three dropdowns on each. The middle
            dropdown offers both Zone and DNS, and only DNS grants access to records:
            <ul class="mt-1.5 space-y-1">
              <li v-for="row in CLOUDFLARE_TOKEN_PERMISSION_ROWS" :key="row.resource">
                <code class="rounded bg-sunken px-1.5 py-0.5 text-ink">
                  {{ row.group }} &rarr; {{ row.resource }} &rarr; {{ row.level }}
                </code>
                <span v-if="row.resource === 'Zone Settings'" class="ml-1 text-xs text-ink-faint">
                  &mdash; only for the SSL tab; DNS works without it
                </span>
              </li>
            </ul>
          </li>
          <li>
            Under Zone Resources choose <strong>Include &rarr; Specific zone</strong> and pick
            <strong>{{ primaryDomain || 'this domain' }}</strong
            >. Including only what this website needs means a leaked token cannot touch your
            other domains.
          </li>
          <li>
            Leave <strong>Client IP Address Filtering</strong> empty. &ldquo;Use my IP&rdquo;
            fills in the address of the computer you are sitting at, which locks this server
            out of the token.
          </li>
          <li>
            Create the token and copy it. Cloudflare shows it once, and the panel keeps it
            encrypted on this server.
          </li>
        </HowTo>

        <form v-if="!isSubdomain" class="mt-4 space-y-3" @submit.prevent="connectToken">
          <div>
            <label for="cf-site-token" class="label">API token</label>
            <input
              id="cf-site-token"
              v-model="token"
              type="password"
              autocomplete="off"
              class="field font-mono"
              placeholder="Paste the token you just created"
            />
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="tokenBusy || token.trim().length < 10"
          >
            {{ tokenBusy ? 'Checking\u2026' : 'Connect Cloudflare' }}
          </button>
        </form>
      </section>

      <template v-else>
        <!-- Which token is in use, and how to change it. -->
        <section class="card flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
          <span class="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
          <span class="text-sm text-ink">
            {{
              connection.source === 'site'
                ? 'Using this website\u2019s own Cloudflare token'
                : 'Using this website\u2019s parent Cloudflare token'
            }}
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-ink-faint">
            {{ connection.message }}
          </span>
          <button
            v-if="connection.source === 'site'"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="tokenBusy"
            @click="forgetToken"
          >
            Remove this token
          </button>
        </section>

        <section class="card p-5">
          <h3 class="text-sm font-semibold text-ink">
            {{ isSubdomain ? 'Point this subdomain at the server' : 'Point this domain at the server' }}
          </h3>
          <p v-if="isSubdomain" class="mt-1 text-sm text-ink-muted">
            Creates or updates only the A record for
            <span class="font-mono text-ink">{{ primaryDomain || 'this subdomain' }}</span>.
            It does not create <span class="font-mono text-ink">www</span>, change the parent
            website&rsquo;s records, or touch any site files.
          </p>
          <p v-else class="mt-1 text-sm text-ink-muted">
            Creates or updates the records that make
            <span class="font-mono text-ink">{{ primaryDomain || 'your domain' }}</span>
            and its <span class="font-mono text-ink">www</span> reach this machine. Safe to run
            again: it updates rather than duplicates.
          </p>

          <AlertMessage v-if="!zone" tone="warning" class="mt-4">
            <span class="font-mono">{{ primaryDomain }}</span> is not in your Cloudflare account.
            Add the domain to Cloudflare first, then come back.
          </AlertMessage>

          <div v-else class="mt-4 space-y-4">
            <div class="flex flex-wrap items-end gap-3">
              <div class="min-w-48">
                <label for="server-ip" class="label">This server's public address</label>
                <input
                  id="server-ip"
                  v-model="serverIpv4"
                  class="field font-mono"
                  placeholder="203.0.113.10"
                  inputmode="numeric"
                />
                <p class="hint">Detected from this server. Change it if your host gave you another.</p>
              </div>

              <label class="mb-1 flex items-center gap-2 text-sm text-ink-muted">
                <input v-model="proxied" type="checkbox" />
                Route traffic through Cloudflare
              </label>

              <button
                type="button"
                class="btn btn-primary mb-1"
                :disabled="!looksLikeIpv4 || busy"
                @click="pointHere"
              >
                <RefreshCw v-if="busy" :size="15" class="animate-spin" aria-hidden="true" />
                {{ busy ? 'Applying\u2026' : 'Point domain here' }}
              </button>
            </div>

            <label v-if="!isSubdomain" class="flex items-start gap-2 text-sm text-ink-muted">
              <input v-model="repointStale" type="checkbox" class="mt-0.5" />
              <span>
                Also move other names that still point at the old server
                <span class="block text-xs text-ink-faint">
                  Things like <span class="font-mono">mail</span>,
                  <span class="font-mono">ftp</span> and
                  <span class="font-mono">webmail</span>, if they currently resolve to whatever
                  this domain resolved to before.
                </span>
              </span>
            </label>

            <!--
              What the button will do, before it does it. A domain moved from
              another host arrives with records that must be deleted rather than
              edited, and that is not something to spring on someone.
            -->
            <AlertMessage v-if="planError" tone="warning">{{ planError }}</AlertMessage>

            <LoadingBlock v-else-if="planning" class="h-16 rounded-lg bg-sunken" :icon-size="16" />

            <p v-else-if="plan && pending.length === 0" class="text-sm text-ok">
              Nothing to change &mdash; this domain already points at this server.
            </p>

            <div v-else-if="plan" class="rounded-lg border border-line bg-sunken/60 p-3">
              <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                What this will change in {{ plan.zone }}
              </p>
              <ul class="mt-2 space-y-1.5">
                <li
                  v-for="(change, index) in pending"
                  :key="`${change.record.type}-${change.record.name}-${index}`"
                  class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                >
                  <span
                    class="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    :class="{
                      'bg-ok-soft text-ok': change.action === 'create',
                      'bg-brand-soft text-brand-bright': change.action === 'update',
                      'bg-danger-soft text-danger': change.action === 'delete',
                    }"
                  >
                    {{ change.action === 'create' ? 'Add' : change.action === 'update' ? 'Change' : 'Delete' }}
                  </span>
                  <span class="font-mono text-ink">
                    {{ change.record.type }} {{ change.record.name }}
                  </span>
                  <span
                    v-if="change.action !== 'delete'"
                    class="font-mono text-xs text-ink-muted"
                  >
                    &rarr; {{ change.record.content }}
                  </span>
                  <span class="w-full text-xs text-ink-faint">{{ change.reason }}</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section v-if="zone" class="card overflow-hidden">
          <div class="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 class="text-sm font-semibold text-ink">
              Records in <span class="font-mono text-brand-bright">{{ zone.name }}</span>
            </h3>
            <button type="button" class="btn btn-ghost btn-sm" @click="load">Refresh</button>
          </div>

          <EmptyState
            v-if="relevant.length === 0"
            :icon="Globe2"
            title="No records for this website yet"
            description="Use the action above and the panel will create the ones it needs."
            flush
          />

          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th class="px-5 py-2 font-medium">Type</th>
                <th class="px-5 py-2 font-medium">Name</th>
                <th class="px-5 py-2 font-medium">Points to</th>
                <th class="px-5 py-2 font-medium">Cloudflare</th>
                <th class="px-5 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr
                v-for="record in relevant"
                :key="record.id ?? record.name"
                class="transition-colors hover:bg-white/[0.03]"
              >
                <td class="px-5 py-2.5">
                  <span
                    class="rounded-md bg-brand-soft px-1.5 py-0.5 font-mono text-xs
                           text-brand-bright"
                  >
                    {{ record.type }}
                  </span>
                </td>
                <td class="px-5 py-2.5 font-mono text-ink">{{ record.name }}</td>
                <td class="max-w-xs truncate px-5 py-2.5 font-mono text-ink-muted">
                  {{ record.content }}
                </td>
                <td class="px-5 py-2.5 text-xs text-ink-muted">
                  {{ record.proxied ? 'Proxied' : 'Direct' }}
                </td>
                <td class="px-5 py-2.5 text-right">
                  <Tooltip v-if="record.id" :text="`Delete ${record.name}`">
                    <button
                      type="button"
                      class="rounded-md p-1.5 text-ink-faint hover:bg-danger-soft hover:text-danger"
                      :aria-label="`Delete ${record.name}`"
                      @click="removeRecord(record.id, record.name)"
                    >
                      <Trash2 :size="14" aria-hidden="true" />
                    </button>
                  </Tooltip>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </template>
  </div>
</template>
