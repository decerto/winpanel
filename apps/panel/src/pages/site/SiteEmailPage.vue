<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AtSign,
  Copy,
  ExternalLink,
  Inbox,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
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
import LoadingBlock from '../../components/LoadingBlock.vue';
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

type ServerStatus = Awaited<ReturnType<typeof api.mail.available.query>>;
type Mailbox = Awaited<ReturnType<typeof api.mail.mailboxes.query>>[number];
type Readiness = Awaited<ReturnType<typeof api.mail.readiness.query>>;
type MailDns = Awaited<ReturnType<typeof api.mail.dnsStatus.query>>;
type ClientSetup = Awaited<ReturnType<typeof api.mail.clientSettings.query>>;

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
const ownPassword = ref(false);
const newPassword = ref('');

/** Checked here as well as on the server, so a form can say so before it is sent. */
function passwordProblemFor(value: string): string | null {
  if (value.length === 0) return null;
  if (value.length < 10) return 'Use at least 10 characters.';
  if (value.trim() !== value) {
    return 'A space at the start or end is too easy to lose when it is typed again.';
  }
  return null;
}

const passwordProblem = computed(() =>
  ownPassword.value ? passwordProblemFor(newPassword.value) : null,
);

/** The open "change this mailbox's password" form, if any. */
const passwordReset = ref<{ address: string; own: boolean; password: string } | null>(null);
const resetProblem = computed(() =>
  passwordReset.value?.own ? passwordProblemFor(passwordReset.value.password) : null,
);

/** The open "change the name on this mailbox's messages" form, if any. */
const renaming = ref<{ address: string; displayName: string } | null>(null);

/** The open "other addresses this mailbox answers to" form, if any. */
const aliasEditor = ref<{ address: string; entries: string[] } | null>(null);

/** Shown once, then gone. The panel has no way to produce it again. */
const revealed = ref<{ address: string; password: string; generated: boolean } | null>(null);
const copied = ref(false);

const readiness = ref<Readiness | null>(null);
const checking = ref(false);

/*
 * Where this domain's email actually goes today.
 *
 * Checked whenever the tab opens, because nobody thinks to press "check" on a
 * mail server they believe is already working. Mail quietly still being
 * delivered to a previous host is the failure this catches, and it is
 * invisible from here otherwise: mailboxes exist, the server is running, and
 * nothing ever arrives.
 */
const mailDns = ref<MailDns | null>(null);
const fixingDns = ref(false);
const showRecords = ref(false);

/** True when mail arrives but is not signed or vouched for. */
const deliverabilityGaps = computed(() => {
  const checks = mailDns.value?.checks;
  if (!checks) return [] as string[];

  return [
    checks.spf.ok ? null : 'SPF',
    checks.dkim.ok ? null : 'DKIM',
    checks.dmarc.ok ? null : 'DMARC',
  ].filter((name): name is string => name !== null);
});

const DELIVERY_LABELS: Record<string, string> = {
  outbound: 'Sending to the outside world',
  reverseDns: 'This server\u2019s name',
  mx: 'Where your email is delivered',
  spf: 'Proof this server may send for you',
  dkim: 'Signature on your email',
  dmarc: 'What to do with suspicious email',
  submission: 'Sending from your devices',
  imap: 'Reading your email',
  clientCertificate: 'Certificate mail programs see',
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

/*
 * What to type into Outlook, measured rather than described.
 *
 * A page that simply lists "IMAP, 993, SSL/TLS" is no help to the person who
 * has already typed exactly that and been told only that something went wrong.
 * So every port is opened here the way a mail client opens it, and the answer
 * — closed, encrypted, trusted — is what gets shown.
 */
const clientSetup = ref<ClientSetup | null>(null);
const setupOpen = ref(false);
const setupAddress = ref<string | null>(null);
const loadingSetup = ref(false);
const fixingCertificate = ref(false);
const copiedSettings = ref(false);

const incomingPorts = computed(() =>
  (clientSetup.value?.ports ?? []).filter((port) => port.direction === 'incoming'),
);
const outgoingPorts = computed(() =>
  (clientSetup.value?.ports ?? []).filter((port) => port.direction === 'outgoing'),
);

async function loadClientSetup(): Promise<void> {
  if (!domain.value) return;

  loadingSetup.value = true;

  try {
    clientSetup.value = await api.mail.clientSettings.query({
      domain: domain.value,
      ...(setupAddress.value ? { address: setupAddress.value } : {}),
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loadingSetup.value = false;
  }
}

/** Opens the settings, for a particular mailbox when one was asked for. */
async function openClientSetup(address?: string): Promise<void> {
  setupAddress.value = address ?? setupAddress.value;

  if (setupOpen.value && !address) {
    setupOpen.value = false;
    return;
  }

  setupOpen.value = true;
  await loadClientSetup();
}

/**
 * Replaces the mail server's own certificate with the website's.
 *
 * The mail server issues itself one on first start and keeps it forever, which
 * webmail never notices and no mail client will accept.
 */
async function fixCertificate(): Promise<void> {
  fixingCertificate.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.installCertificate.mutate({ domain: domain.value });
    notice.value = result.note;
    await loadClientSetup();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    fixingCertificate.value = false;
  }
}

function settingsText(): string {
  const setup = clientSetup.value;
  if (!setup) return '';

  const line = (port: (typeof setup.ports)[number]): string =>
    `${port.protocol} \u2014 server ${port.server}, port ${port.port}, ${port.encryption}`;

  return [
    `Username: ${setup.username}`,
    'Password: your mailbox password',
    ...setup.ports.filter((port) => port.preferred).map(line),
  ].join('\n');
}

async function copySettings(): Promise<void> {
  try {
    await navigator.clipboard.writeText(settingsText());
    copiedSettings.value = true;
    setTimeout(() => (copiedSettings.value = false), 2000);
  } catch {
    // Clipboard access can be refused; the settings are on screen to be read.
  }
}

async function loadMailboxes(): Promise<void> {
  if (!domain.value || !status.value?.connected) return;

  try {
    mailboxes.value = await api.mail.mailboxes.query({ domain: domain.value });
  } catch (err) {
    error.value = describeError(err);
  }
}

/**
 * Reads the domain's live DNS.
 *
 * Failures are swallowed on purpose. This runs unprompted, and a DNS lookup
 * that timed out is not something to interrupt somebody about while they are
 * creating a mailbox — the banner simply does not appear.
 */
async function loadMailDns(): Promise<void> {
  if (!domain.value || !status.value?.connected) return;

  mailDns.value = null;

  try {
    mailDns.value = await api.mail.dnsStatus.query({
      domain: domain.value,
      ...(site.value?.slug ? { slug: site.value.slug } : {}),
    });
  } catch {
    mailDns.value = null;
  }
}

/**
 * Publishes the records that bring this domain's email here.
 *
 * Previewed first, and confirmed when the plan deletes anything, because the
 * records being deleted are the ones currently delivering the domain's mail
 * somewhere else. That is a redirection of somebody's post, and it is not a
 * decision to make on their behalf without showing them.
 */
async function fixMailDns(): Promise<void> {
  fixingDns.value = true;
  error.value = null;
  notice.value = null;

  try {
    const scope = {
      domain: domain.value,
      ...(site.value?.slug ? { slug: site.value.slug } : {}),
    };
    const preview = await api.mail.previewDnsSetup.query(scope);

    if (preview.removes.length > 0) {
      const confirmed = window.confirm(
        `This will remove ${preview.removes.join(', ')} from ${preview.zone}. ` +
          'Email currently delivered elsewhere will start arriving here instead. Continue?',
      );
      if (!confirmed) return;
    }

    const result = await api.mail.setUpDns.mutate(scope);
    notice.value = result.note;
    await loadMailDns();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    fixingDns.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    status.value = await api.mail.available.query();
    await loadMailboxes();
    void loadMailDns();
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
      password: ownPassword.value ? newPassword.value : undefined,
    });

    revealed.value = {
      address: result.address,
      password: result.password,
      generated: result.generated,
    };
    localPart.value = '';
    displayName.value = '';
    newPassword.value = '';
    ownPassword.value = false;
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

function openPasswordReset(mailbox: Mailbox): void {
  passwordReset.value =
    passwordReset.value?.address === mailbox.address
      ? null
      : { address: mailbox.address, own: false, password: '' };
}

function openRename(mailbox: Mailbox): void {
  renaming.value =
    renaming.value?.address === mailbox.address
      ? null
      : { address: mailbox.address, displayName: mailbox.displayName ?? '' };
}

async function saveDisplayName(): Promise<void> {
  const form = renaming.value;
  if (!form) return;

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.setMailboxDisplayName.mutate({
      address: form.address,
      displayName: form.displayName.trim(),
    });
    notice.value = `${form.address}: ${result.note}`;
    renaming.value = null;
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function openAliases(mailbox: Mailbox): void {
  aliasEditor.value =
    aliasEditor.value?.address === mailbox.address
      ? null
      : { address: mailbox.address, entries: [...mailbox.aliases, ''] };
}

async function saveAliases(): Promise<void> {
  const form = aliasEditor.value;
  if (!form) return;

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.setMailboxAliases.mutate({
      address: form.address,
      aliases: form.entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    });
    notice.value = `${form.address}: ${result.note}`;
    aliasEditor.value = null;
    await loadMailboxes();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function changePassword(): Promise<void> {
  const form = passwordReset.value;
  if (!form) return;

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.setMailboxPassword.mutate({
      address: form.address,
      password: form.own ? form.password : undefined,
    });
    revealed.value = {
      address: form.address,
      password: result.password,
      generated: result.generated,
    };
    passwordReset.value = null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
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

watch(domain, () => {
  showRecords.value = false;
  setupOpen.value = false;
  setupAddress.value = null;
  clientSetup.value = null;
  void loadMailboxes();
  void loadMailDns();
});
watch(() => site.value?.slug, load, { immediate: true });
</script>

<template>
  <div class="space-y-5">
    <LoadingBlock v-if="loading" class="h-40 rounded-card bg-surface" />

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
        title="Email is not available for this website yet"
        :description="status?.message ?? ''"
      />

      <template v-else>
        <!--
          Email arriving somewhere else is silent from in here: the mailboxes
          exist, the server runs, and nothing ever turns up. So it is said
          plainly and at the top, above everything it would otherwise waste
          somebody's afternoon underneath.
        -->
        <AlertMessage
          v-if="mailDns && !mailDns.pointsHere"
          tone="warning"
          title="Email for this domain does not come to this server"
        >
          <p>
            {{ mailDns.checks.mx.summary }}
            Until that is changed, messages sent to
            <span class="font-mono">@{{ domain }}</span> will not appear in the mailboxes below.
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              v-if="mailDns.canFix"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="fixingDns"
              @click="fixMailDns"
            >
              {{ fixingDns ? 'Setting up\u2026' : 'Point email at this server' }}
            </button>
            <RouterLink
              v-else-if="site?.slug"
              :to="`/sites/${site.slug}/dns`"
              class="btn btn-ghost btn-sm"
            >
              Connect Cloudflare
            </RouterLink>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              @click="showRecords = !showRecords"
            >
              {{ showRecords ? 'Hide the records' : 'Show the records to add by hand' }}
            </button>
          </div>

          <!-- The way out for anyone whose DNS the panel cannot reach. -->
          <table v-if="showRecords" class="mt-3 w-full text-left text-xs">
            <thead class="text-ink-faint">
              <tr>
                <th class="py-1 pr-3 font-medium">Type</th>
                <th class="py-1 pr-3 font-medium">Name</th>
                <th class="py-1 font-medium">Value</th>
              </tr>
            </thead>
            <tbody class="font-mono">
              <tr v-for="record in mailDns.recommended" :key="`${record.type}-${record.name}`">
                <td class="py-1 pr-3 align-top">{{ record.type }}</td>
                <td class="py-1 pr-3 align-top">{{ record.name }}</td>
                <td class="min-w-0 break-all py-1 align-top">
                  <template v-if="record.priority !== null">{{ record.priority }} </template
                  >{{ record.content }}
                </td>
              </tr>
            </tbody>
          </table>
        </AlertMessage>

        <!--
          Mail arrives, but unsigned mail lands in junk folders. Worth saying,
          not worth alarming anybody about.
        -->
        <AlertMessage
          v-else-if="mailDns && mailDns.canFix && deliverabilityGaps.length > 0"
          tone="info"
          title="Your email arrives, but it is not fully vouched for"
        >
          <p>
            {{ deliverabilityGaps.join(', ') }} is missing, which makes some providers treat
            messages from <span class="font-mono">@{{ domain }}</span> as suspicious.
          </p>
          <button
            type="button"
            class="btn btn-ghost btn-sm mt-3"
            :disabled="fixingDns"
            @click="fixMailDns"
          >
            {{ fixingDns ? 'Publishing\u2026' : 'Publish the missing records' }}
          </button>
        </AlertMessage>

        <!-- A password can be read exactly once, so it gets the whole width. -->
        <section v-if="revealed" class="card border-brand/40 p-5">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-brand-bright">
            <KeyRound :size="15" aria-hidden="true" /> Password for {{ revealed.address }}
          </h3>
          <p class="mt-1 text-sm text-ink-muted">
            <template v-if="revealed.generated">
              Write this down now. It is not stored in the panel and cannot be shown again &mdash;
              only replaced.
            </template>
            <template v-else>
              The password you chose is in use from now on. It is not stored in the panel and
              cannot be shown again &mdash; only replaced.
            </template>
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
            incoming and outgoing mail, with the full address as the username.
            <button
              type="button"
              class="text-brand-bright underline"
              @click="openClientSetup(revealed.address)"
            >
              Show the exact settings
            </button>
          </p>
        </section>

        <!--
          Mail client setup.
          ------------------
          Everything below is probed live rather than printed from a table.
          The failure this exists for is invisible otherwise: the mail server
          serves a certificate it made for itself, webmail is perfectly happy
          with it because it never leaves this machine, and Outlook refuses the
          account with nothing more useful than "something went wrong".
        -->
        <section class="card overflow-hidden">
          <div class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
            <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
              <Settings2 :size="15" class="text-ink-faint" aria-hidden="true" />
              Set up Outlook or another mail program
            </h3>

            <button
              type="button"
              class="btn btn-ghost btn-sm ml-auto"
              :disabled="loadingSetup"
              @click="openClientSetup()"
            >
              <RefreshCw
                v-if="loadingSetup"
                :size="14"
                class="animate-spin"
                aria-hidden="true"
              />
              {{
                loadingSetup
                  ? 'Checking the ports\u2026'
                  : setupOpen
                    ? 'Hide settings'
                    : 'Show settings'
              }}
            </button>
          </div>

          <p v-if="!setupOpen" class="px-5 py-4 text-sm text-ink-muted">
            The server name, ports and encryption for
            <span class="font-mono text-ink">@{{ domain }}</span
            >, checked against this server as a mail program would see them.
          </p>

          <div v-else-if="clientSetup" class="space-y-4 px-5 py-4">
            <!-- Nothing else on the card can work if the name is wrong. -->
            <AlertMessage
              v-if="!clientSetup.host.resolvesHere"
              tone="warning"
              title="Mail programs cannot find this server"
            >
              <p>{{ clientSetup.host.summary }}</p>
              <RouterLink
                v-if="site?.slug"
                :to="`/sites/${site.slug}/dns`"
                class="btn btn-ghost btn-sm mt-3"
              >
                Open DNS
              </RouterLink>
            </AlertMessage>

            <!--
              The one that reads as a wrong password. Outlook says only that
              something went wrong, so it has to be named here explicitly.
            -->
            <AlertMessage
              v-if="!clientSetup.certificate.trusted"
              tone="warning"
              :title="clientSetup.certificate.title"
            >
              <p>{{ clientSetup.certificate.summary }}</p>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <button
                  v-if="clientSetup.certificate.canFix"
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="fixingCertificate"
                  @click="fixCertificate"
                >
                  <ShieldCheck :size="14" aria-hidden="true" />
                  {{
                    fixingCertificate
                      ? clientSetup.certificate.issued
                        ? 'Installing\u2026'
                        : 'Getting a certificate\u2026'
                      : clientSetup.certificate.fixLabel
                  }}
                </button>
                <p v-if="clientSetup.certificate.fixHint" class="text-xs text-ink-faint">
                  {{ clientSetup.certificate.fixHint }}
                </p>
              </div>
            </AlertMessage>

            <dl class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-lg border border-line bg-black/20 px-3 py-2">
                <dt class="text-xs text-ink-faint">Username</dt>
                <dd class="font-mono text-sm text-ink">{{ clientSetup.username }}</dd>
              </div>
              <div class="rounded-lg border border-line bg-black/20 px-3 py-2">
                <dt class="text-xs text-ink-faint">Password</dt>
                <dd class="text-sm text-ink">
                  The mailbox password. Reset it above if it is not to hand.
                </dd>
              </div>
            </dl>

            <div v-for="group in [
                { title: 'Incoming mail', ports: incomingPorts },
                { title: 'Outgoing mail', ports: outgoingPorts },
              ]"
              :key="group.title"
            >
              <h4 class="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                {{ group.title }}
              </h4>

              <ul class="mt-2 space-y-2">
                <li
                  v-for="port in group.ports"
                  :key="port.id"
                  class="rounded-lg border bg-black/20 px-3 py-2"
                  :class="port.preferred ? 'border-brand/40' : 'border-line'"
                >
                  <div class="flex flex-wrap items-center gap-3">
                    <StatusBadge :state="port.state" size="sm" :show-label="false" />
                    <span class="text-sm font-medium text-ink">{{ port.protocol }}</span>
                    <span
                      v-if="port.preferred"
                      class="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold
                             uppercase tracking-wide text-brand-bright"
                    >
                      Recommended
                    </span>
                    <span class="ml-auto font-mono text-xs text-ink-muted">
                      {{ port.server }}:{{ port.port }} &middot; {{ port.encryption }}
                    </span>
                  </div>
                  <p class="mt-1 text-xs text-ink-faint">
                    {{ port.summary }}
                    <template v-if="port.configured === false">
                      The mail server has no listener on this port, so this protocol is not
                      available here.
                    </template>
                    <template v-else-if="port.state === 'ok'">{{ port.note }}</template>
                  </p>
                </li>
              </ul>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-ghost btn-sm" @click="copySettings">
                <Copy :size="14" aria-hidden="true" />
                {{ copiedSettings ? 'Copied' : 'Copy the recommended settings' }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="loadingSetup"
                @click="loadClientSetup"
              >
                <RefreshCw
                  :size="14"
                  :class="loadingSetup ? 'animate-spin' : ''"
                  aria-hidden="true"
                />
                Check again
              </button>
              <p class="text-xs text-ink-faint">{{ clientSetup.note }}</p>
            </div>
            <p
              v-if="clientSetup.certificate.trusted && clientSetup.certificate.expiresInDays !== null"
              class="flex items-center gap-1.5 text-xs text-ink-faint"
            >
              <ShieldCheck :size="13" aria-hidden="true" />
              {{ clientSetup.certificate.summary }}
            </p>
          </div>
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

            <div>
              <label for="password-mode" class="label">Password</label>
              <select id="password-mode" v-model="ownPassword" class="field w-40">
                <option :value="false">Generate one</option>
                <option :value="true">Set my own</option>
              </select>
            </div>

            <div v-if="ownPassword">
              <label for="mailbox-password" class="label">Chosen password</label>
              <input
                id="mailbox-password"
                v-model="newPassword"
                type="password"
                class="field w-56 font-mono"
                autocomplete="new-password"
                placeholder="At least 10 characters"
              />
            </div>

            <button
              type="submit"
              class="btn btn-primary"
              :disabled="
                busy ||
                localPart.trim().length === 0 ||
                passwordProblem !== null ||
                (ownPassword && newPassword.length === 0)
              "
            >
              {{ busy ? 'Creating\u2026' : 'Create mailbox' }}
            </button>
            <button type="button" class="btn btn-ghost" @click="creating = false">Cancel</button>

            <p v-if="passwordProblem" class="w-full text-sm text-danger">{{ passwordProblem }}</p>
            <p v-else-if="ownPassword" class="hint w-full">
              This is what the mailbox owner types into Outlook or their phone. The panel keeps no
              copy of it, so it can only be replaced, never looked up.
            </p>
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
                  <p v-if="mailbox.aliases.length > 0" class="truncate text-xs text-ink-faint">
                    also {{ mailbox.aliases.join(', ') }}
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

                  <!--
                    Opening the mailbox asks for its own password. The panel
                    can reset that password, which is visible; it cannot read
                    somebody's mail without being given it.
                  -->
                  <RouterLink
                    :to="`/webmail?address=${encodeURIComponent(mailbox.address)}`"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :aria-label="`Open ${mailbox.address} in webmail`"
                  >
                    <ExternalLink :size="15" />
                  </RouterLink>

                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :aria-label="`Mail program settings for ${mailbox.address}`"
                    @click="openClientSetup(mailbox.address)"
                  >
                    <Settings2 :size="15" />
                  </button>

                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :class="renaming?.address === mailbox.address ? 'bg-white/5 text-ink' : ''"
                    :aria-label="`Change the name shown on mail from ${mailbox.address}`"
                    :aria-expanded="renaming?.address === mailbox.address"
                    @click="openRename(mailbox)"
                  >
                    <Pencil :size="15" />
                  </button>

                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :class="aliasEditor?.address === mailbox.address ? 'bg-white/5 text-ink' : ''"
                    :aria-label="`Other addresses for ${mailbox.address}`"
                    :aria-expanded="aliasEditor?.address === mailbox.address"
                    @click="openAliases(mailbox)"
                  >
                    <AtSign :size="15" />
                  </button>

                  <button
                    type="button"
                    class="rounded-md p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
                    :class="passwordReset?.address === mailbox.address ? 'bg-white/5 text-ink' : ''"
                    :aria-label="`Change the password for ${mailbox.address}`"
                    :aria-expanded="passwordReset?.address === mailbox.address"
                    @click="openPasswordReset(mailbox)"
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

              <form
                v-if="renaming && renaming.address === mailbox.address"
                class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line
                       bg-sunken px-4 py-3"
                @submit.prevent="saveDisplayName"
              >
                <div>
                  <label for="rename-display-name" class="label">Name on messages</label>
                  <input
                    id="rename-display-name"
                    v-model="renaming.displayName"
                    class="field w-64"
                    placeholder="Sales team"
                    maxlength="120"
                  />
                </div>

                <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">
                  {{ busy ? 'Saving\u2026' : 'Save name' }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="renaming = null">
                  Cancel
                </button>

                <p class="hint w-full">
                  What people see this mailbox called when it sends them mail. Leave it empty to
                  show only the address.
                </p>
              </form>

              <form
                v-if="aliasEditor && aliasEditor.address === mailbox.address"
                class="mt-3 rounded-lg border border-line bg-sunken px-4 py-3"
                @submit.prevent="saveAliases"
              >
                <p class="label">Other addresses</p>

                <div class="mt-1 space-y-2">
                  <div
                    v-for="(_, index) in aliasEditor.entries"
                    :key="index"
                    class="flex items-center gap-2"
                  >
                    <input
                      v-model="aliasEditor.entries[index]"
                      class="field w-72 font-mono text-sm"
                      type="email"
                      :placeholder="`noreply@${domain}`"
                      :aria-label="`Other address ${index + 1} for ${mailbox.address}`"
                      maxlength="254"
                    />
                    <button
                      type="button"
                      class="rounded-md p-2 text-ink-faint hover:bg-danger-soft hover:text-danger"
                      :aria-label="`Remove address ${index + 1}`"
                      @click="aliasEditor.entries.splice(index, 1)"
                    >
                      <Trash2 :size="15" />
                    </button>
                  </div>
                </div>

                <div class="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    @click="aliasEditor.entries.push('')"
                  >
                    <Plus :size="15" /> Add another
                  </button>
                  <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">
                    {{ busy ? 'Saving\u2026' : 'Save addresses' }}
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" @click="aliasEditor = null">
                    Cancel
                  </button>
                </div>

                <p class="hint mt-2">
                  Mail sent to these arrives in this mailbox, and an app signed in as
                  {{ mailbox.address }} may send from them. That is what a website needs when it
                  sends as more than one address — the mail server refuses a message whose sender
                  is not one the account owns.
                </p>
              </form>

              <form
                v-if="passwordReset && passwordReset.address === mailbox.address"
                class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line
                       bg-sunken px-4 py-3"
                @submit.prevent="changePassword"
              >
                <div>
                  <label for="reset-mode" class="label">New password</label>
                  <select id="reset-mode" v-model="passwordReset.own" class="field w-40">
                    <option :value="false">Generate one</option>
                    <option :value="true">Set my own</option>
                  </select>
                </div>

                <div v-if="passwordReset.own">
                  <label for="reset-password" class="label">Chosen password</label>
                  <input
                    id="reset-password"
                    v-model="passwordReset.password"
                    type="password"
                    class="field w-56 font-mono"
                    autocomplete="new-password"
                    placeholder="At least 10 characters"
                  />
                </div>

                <button
                  type="submit"
                  class="btn btn-primary btn-sm"
                  :disabled="
                    busy ||
                    resetProblem !== null ||
                    (passwordReset.own && passwordReset.password.length === 0)
                  "
                >
                  {{ busy ? 'Saving\u2026' : 'Change password' }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="passwordReset = null">
                  Cancel
                </button>

                <p v-if="resetProblem" class="w-full text-sm text-danger">{{ resetProblem }}</p>
                <p v-else class="hint w-full">
                  The old password for
                  <span class="font-mono text-ink">{{ mailbox.address }}</span> stops working as
                  soon as this is saved, on every phone and mail program using it.
                </p>
              </form>
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
