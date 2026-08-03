<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AtSign,
  Copy,
  Inbox,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-vue-next';
import {
  DEFAULT_MAILBOX_QUOTA_BYTES,
  MAILBOX_QUOTA_PRESETS,
  mailHostnameFor,
  type CheckState,
} from '@winpanel/shared';
import { api, describeError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import EmptyState from '../../components/EmptyState.vue';
import StatusBadge from '../../components/StatusBadge.vue';

/**
 * Email for one website.
 *
 * Mailboxes belong to a domain, and a domain belongs to a website, so this is
 * where they live rather than on a server-wide screen. The panel never stores
 * a mailbox password: it is shown once, at the moment it is set, and then it
 * only exists inside the mail server.
 */

const { site } = inject(siteContextKey)!;

type ServerStatus = Awaited<ReturnType<typeof api.mail.serverStatus.query>>;
type Mailbox = Awaited<ReturnType<typeof api.mail.mailboxes.query>>[number];
type Readiness = Awaited<ReturnType<typeof api.mail.readiness.query>>;

const status = ref<ServerStatus | null>(null);
const mailboxes = ref<Mailbox[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/** A site can answer on several domains; mail only makes sense for one. */
const domain = ref('');
const domains = computed(() =>
  (site.value?.domains ?? []).filter((name) => !name.toLowerCase().startsWith('www.')),
);
const mailHostname = computed(() => (domain.value ? mailHostnameFor(domain.value) : ''));

const creating = ref(false);
const localPart = ref('');
const displayName = ref('');
const newQuota = ref<number>(DEFAULT_MAILBOX_QUOTA_BYTES);

/** Shown once, then gone. The panel has no way to produce it again. */
const revealed = ref<{ address: string; password: string } | null>(null);
const copied = ref(false);

const readiness = ref<Readiness | null>(null);
const checking = ref(false);

const DELIVERY_LABELS: Record<string, string> = {
  outbound: 'Sending to the outside world',
  reverseDns: 'This server\u2019s name',
  mx: 'Where your email is delivered',
  spf: 'Proof this server may send for you',
  dkim: 'Signature on your email',
  dmarc: 'What to do with suspicious email',
  submission: 'Sending from your devices',
  imap: 'Reading your email',
};

const deliveryChecks = computed(() =>
  Object.entries(readiness.value?.checks ?? {}).map(([key, value]) => ({
    key,
    name: DELIVERY_LABELS[key] ?? key,
    state: value.state as CheckState,
    summary: value.summary,
  })),
);

function usage(mailbox: Mailbox): number {
  if (mailbox.quotaBytes === 0) return 0;
  return Math.min(100, (mailbox.usedBytes / mailbox.quotaBytes) * 100);
}

async function loadMailboxes(): Promise<void> {
  if (!domain.value || !status.value?.connected) return;

  try {
    mailboxes.value = await api.mail.mailboxes.query({ domain: domain.value });
  } catch (err) {
    error.value = describeError(err);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    status.value = await api.mail.serverStatus.query();
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function createMailbox(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.createMailbox.mutate({
      address: `${localPart.value.trim()}@${domain.value}`,
      displayName: displayName.value.trim(),
      quotaBytes: newQuota.value,
    });

    revealed.value = { address: result.address, password: result.password };
    localPart.value = '';
    displayName.value = '';
    creating.value = false;
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function changeQuota(mailbox: Mailbox, quotaBytes: number): Promise<void> {
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.setMailboxQuota.mutate({
      address: mailbox.address,
      quotaBytes,
    });
    notice.value = `${mailbox.address}: ${result.note}`;
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function resetPassword(mailbox: Mailbox): Promise<void> {
  if (!window.confirm(`Give ${mailbox.address} a new password? The old one stops working.`)) {
    return;
  }

  error.value = null;

  try {
    const result = await api.mail.setMailboxPassword.mutate({ address: mailbox.address });
    revealed.value = { address: mailbox.address, password: result.password };
  } catch (err) {
    error.value = describeError(err);
  }
}

async function remove(mailbox: Mailbox): Promise<void> {
  const typed = window.prompt(
    `Deleting a mailbox destroys the mail in it. Type ${mailbox.address} to confirm.`,
  );
  if (typed === null) return;

  error.value = null;

  try {
    await api.mail.deleteMailbox.mutate({
      address: mailbox.address,
      confirmAddress: typed,
    });
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function runDeliveryChecks(): Promise<void> {
  checking.value = true;
  error.value = null;

  try {
    readiness.value = await api.mail.readiness.query({
      domain: domain.value,
      mailHostname: mailHostname.value,
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    checking.value = false;
  }
}

async function copyPassword(): Promise<void> {
  if (!revealed.value) return;

  try {
    await navigator.clipboard.writeText(revealed.value.password);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard access can be refused; the password is on screen to be read.
  }
}

watch(
  domains,
  (list) => {
    if (!domain.value || !list.includes(domain.value)) domain.value = list[0] ?? '';
  },
  { immediate: true },
);

watch(domain, loadMailboxes);
watch(() => site.value?.slug, load, { immediate: true });
</script>

<template>
  <div class="space-y-5">
    <div v-if="loading" class="h-40 animate-pulse rounded-card bg-surface" />

    <template v-else>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <EmptyState
        v-if="domains.length === 0"
        :icon="AtSign"
        title="This website has no domain yet"
        description="Email needs a domain of its own. Give this website a web address and its
                     mailboxes will live here."
      />

      <!-- Nothing on this tab can work without the mail server. -->
      <EmptyState
        v-else-if="!status?.connected"
        :icon="Server"
        :title="
          status?.reachable && !status.manageable
            ? 'This mail server cannot be managed from the panel'
            : 'The mail server is not connected'
        "
        :description="status?.message ?? ''"
      >
        <RouterLink
          v-if="!(status?.reachable && !status.manageable)"
          to="/settings"
          class="btn btn-primary mt-5"
        >
          Open Settings
        </RouterLink>
      </EmptyState>

      <template v-else>
        <!-- A password can be read exactly once, so it gets the whole width. -->
        <section v-if="revealed" class="card border-brand/40 p-5">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-brand-bright">
            <KeyRound :size="15" aria-hidden="true" /> Password for {{ revealed.address }}
          </h3>
          <p class="mt-1 text-sm text-ink-muted">
            Write this down now. It is not stored in the panel and cannot be shown again — only
            replaced.
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <code
              class="rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-sm text-ink"
            >
              {{ revealed.password }}
            </code>
            <button type="button" class="btn btn-ghost btn-sm" @click="copyPassword">
              <Copy :size="14" aria-hidden="true" /> {{ copied ? 'Copied' : 'Copy' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="revealed = null">
              I have saved it
            </button>
          </div>

          <p class="hint">
            In Outlook, use <span class="font-mono text-ink">{{ mailHostname }}</span> for both
            incoming (IMAP, port 993) and outgoing (SMTP, port 587) mail, with the full address
            as the username.
          </p>
        </section>

        <section class="card overflow-hidden">
          <div class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
            <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
              <Inbox :size="15" class="text-ink-faint" aria-hidden="true" /> Mailboxes
            </h3>

            <select
              v-if="domains.length > 1"
              v-model="domain"
              class="field max-w-56 py-1 text-xs"
              aria-label="Domain"
            >
              <option v-for="name in domains" :key="name" :value="name">@{{ name }}</option>
            </select>
            <span v-else class="font-mono text-xs text-ink-faint">@{{ domain }}</span>

            <button
              type="button"
              class="btn btn-primary btn-sm ml-auto"
              @click="creating = !creating"
            >
              <Plus :size="14" aria-hidden="true" /> New mailbox
            </button>
          </div>

          <form
            v-if="creating"
            class="flex flex-wrap items-end gap-3 border-b border-line bg-sunken px-5 py-4"
            @submit.prevent="createMailbox"
          >
            <div>
              <label for="local-part" class="label">Address</label>
              <div class="flex items-center gap-1">
                <input
                  id="local-part"
                  v-model="localPart"
                  class="field w-40 font-mono"
                  placeholder="hello"
                  autofocus
                />
                <span class="font-mono text-sm text-ink-faint">@{{ domain }}</span>
              </div>
            </div>

            <div>
              <label for="display-name" class="label">Name on messages</label>
              <input
                id="display-name"
                v-model="displayName"
                class="field w-48"
                placeholder="Sales team"
              />
            </div>

            <div>
              <label for="quota" class="label">Size</label>
              <select id="quota" v-model.number="newQuota" class="field w-32">
                <option
                  v-for="preset in MAILBOX_QUOTA_PRESETS"
                  :key="preset.label"
                  :value="preset.bytes"
                >
                  {{ preset.label }}
                </option>
              </select>
            </div>

            <button
              type="submit"
              class="btn btn-primary"
              :disabled="busy || localPart.trim().length === 0"
            >
              {{ busy ? 'Creating\u2026' : 'Create mailbox' }}
            </button>
            <button type="button" class="btn btn-ghost" @click="creating = false">Cancel</button>
          </form>

          <EmptyState
            v-if="mailboxes.length === 0"
            :icon="AtSign"
            title="No mailboxes for this domain yet"
            description="Create one and it can be used in Outlook, on a phone, or anywhere else
                         that speaks IMAP."
            flush
          />

          <ul v-else class="divide-y divide-line">
            <li v-for="mailbox in mailboxes" :key="mailbox.address" class="px-5 py-4">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0">
                  <p class="truncate font-mono text-sm text-ink">{{ mailbox.address }}</p>
                  <p v-if="mailbox.displayName" class="text-xs text-ink-muted">
                    {{ mailbox.displayName }}
                  </p>
                </div>

                <div class="flex items-center gap-1">
                  <select
                    class="field w-32 py-1 text-xs"
                    :value="mailbox.quotaBytes"
                    :aria-label="`Size of ${mailbox.address}`"
                    @change="
                      changeQuota(mailbox, Number(($event.target as HTMLSelectElement).value))
                    "
                  >
                    <!-- A size the panel did not offer is still a real size. -->
                    <option
                      v-if="!MAILBOX_QUOTA_PRESETS.some((p) => p.bytes === mailbox.quotaBytes)"
                      :value="mailbox.quotaBytes"
                    >
                      {{ formatBytes(mailbox.quotaBytes) }}
                    </option>
                    <option
                      v-for="preset in MAILBOX_QUOTA_PRESETS"
                      :key="preset.label"
                      :value="preset.bytes"
                    >
                      {{ preset.label }}
                    </option>
                  </select>

                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :aria-label="`Reset the password for ${mailbox.address}`"
                    @click="resetPassword(mailbox)"
                  >
                    <KeyRound :size="15" />
                  </button>
                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-danger-soft hover:text-danger"
                    :aria-label="`Delete ${mailbox.address}`"
                    @click="remove(mailbox)"
                  >
                    <Trash2 :size="15" />
                  </button>
                </div>
              </div>

              <div class="mt-2.5 flex items-center gap-3">
                <!-- A bar with no limit to fill has nothing to say. -->
                <div
                  v-if="mailbox.quotaBytes > 0"
                  class="h-1.5 w-40 overflow-hidden rounded-full bg-black/40"
                >
                  <div
                    class="h-full rounded-full"
                    :class="usage(mailbox) > 85 ? 'bg-warn' : 'bg-brand'"
                    :style="{ width: `${Math.max(2, usage(mailbox))}%` }"
                  />
                </div>
                <span class="text-xs text-ink-faint">
                  {{ formatBytes(mailbox.usedBytes) }} used
                  <template v-if="mailbox.quotaBytes > 0">
                    of {{ formatBytes(mailbox.quotaBytes) }}
                  </template>
                  <template v-else>, with no limit set</template>
                </span>
              </div>
            </li>
          </ul>
        </section>

        <!--
          Delivery depends on DNS and on the hosting provider, so it is checked
          on demand rather than every time this tab is opened.
        -->
        <section class="card p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-ink">Will your email arrive?</h3>
              <p class="mt-1 text-sm text-ink-muted">
                Checks the records and ports that decide whether mail for
                <span class="font-mono text-ink">{{ domain }}</span> is delivered and believed.
              </p>
            </div>

            <button
              type="button"
              class="btn btn-ghost"
              :disabled="checking"
              @click="runDeliveryChecks"
            >
              <RefreshCw :size="14" :class="checking ? 'animate-spin' : ''" aria-hidden="true" />
              {{ checking ? 'Checking\u2026' : 'Run checks' }}
            </button>
          </div>

          <ul v-if="deliveryChecks.length > 0" class="mt-4 space-y-2">
            <li
              v-for="check in deliveryChecks"
              :key="check.key"
              class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-black/20
                     px-3 py-2"
            >
              <StatusBadge :state="check.state" size="sm" :show-label="false" />
              <span class="text-sm text-ink">{{ check.name }}</span>
              <span class="ml-auto max-w-md truncate text-xs text-ink-faint">
                {{ check.summary }}
              </span>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </div>
</template>
