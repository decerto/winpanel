<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { CloudCog, Globe2, RefreshCw, Trash2 } from 'lucide-vue-next';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';

/**
 * DNS for this website, through Cloudflare.
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

const IP_STORAGE_KEY = 'winpanel.serverIpv4';

type Zone = Awaited<ReturnType<typeof api.dns.zones.query>>[number];
type ZoneRecord = Awaited<ReturnType<typeof api.dns.records.query>>[number];

const connection = ref<{ connected: boolean; message: string } | null>(null);
const zones = ref<Zone[]>([]);
const records = ref<ZoneRecord[] | null>(null);

const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const serverIpv4 = ref(localStorage.getItem(IP_STORAGE_KEY) ?? '');
const proxied = ref(false);

const primaryDomain = computed(() => site.value?.domains[0] ?? '');

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
    connection.value = await api.dns.status.query();

    if (!serverIpv4.value) {
      const info = await api.system.info.query();
      serverIpv4.value = info.suggestedIpv4 ?? '';
    }

    if (!connection.value.connected) return;

    zones.value = await api.dns.zones.query();
    records.value = zone.value ? await api.dns.records.query({ zoneId: zone.value.id }) : null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function pointHere(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.dns.pointDomainHere.mutate({
      domain: primaryDomain.value,
      serverIpv4: serverIpv4.value.trim(),
      proxied: proxied.value,
    });
    localStorage.setItem(IP_STORAGE_KEY, serverIpv4.value.trim());
    notice.value = `${result.applied.join(', ')}. ${result.note}`;
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
    await api.dns.deleteRecord.mutate({ zoneId: zone.value.id, recordId });
    await load();
  } catch (err) {
    error.value = describeError(err);
  }
}

watch(primaryDomain, load, { immediate: true });
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="h-40 animate-pulse rounded-card bg-surface" />

    <template v-else>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <!-- No Cloudflare account connected: nothing on this tab can work. -->
      <EmptyState
        v-if="!connection?.connected"
        :icon="CloudCog"
        title="Cloudflare is not connected"
        description="DNS is managed through your Cloudflare account. Connect it once in Settings and
                     every website on this server can point its own domain here."
      >
        <RouterLink to="/settings" class="btn btn-primary mt-4">Open Settings</RouterLink>
      </EmptyState>

      <template v-else>
        <section class="card p-5">
          <h3 class="text-sm font-semibold text-ink">Point this domain at the server</h3>
          <p class="mt-1 text-sm text-ink-muted">
            Creates or updates the records that make
            <span class="font-mono text-ink">{{ primaryDomain || 'your domain' }}</span>
            and its <span class="font-mono text-ink">www</span> reach this machine. Safe to run
            again: it updates rather than duplicates.
          </p>

          <AlertMessage v-if="!zone" tone="warning" class="mt-4">
            <span class="font-mono">{{ primaryDomain }}</span> is not in your Cloudflare account.
            Add the domain to Cloudflare first, then come back.
          </AlertMessage>

          <div v-else class="mt-4 flex flex-wrap items-end gap-3">
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
                  <button
                    v-if="record.id"
                    type="button"
                    class="rounded-md p-1.5 text-ink-faint hover:bg-danger-soft hover:text-danger"
                    :aria-label="`Delete ${record.name}`"
                    @click="removeRecord(record.id, record.name)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </template>
  </div>
</template>
