<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Mail, RefreshCw } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import StatusBadge from '../components/StatusBadge.vue';
import type { CheckState } from '@winpanel/shared';

/**
 * Mail readiness.
 *
 * Two of these depend on the hosting provider rather than this server, so the
 * page is explicit about which ones you have to go and ask for, and keeps
 * checking rather than making you come back to look.
 */

const domain = ref('');
const mailHostname = computed(() => (domain.value ? `mail.${domain.value}` : ''));

type Readiness = Awaited<ReturnType<typeof api.mail.readiness.query>>;

const report = ref<Readiness | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const LABELS: Record<string, { name: string; what: string; whoFixes: 'you' | 'provider' }> = {
  outbound: {
    name: 'Sending email to the outside world',
    what: 'Whether this server can reach other mail servers at all.',
    whoFixes: 'provider',
  },
  reverseDns: {
    name: 'Your server\u2019s name',
    what: 'How other mail servers see this server. Set in your hosting control panel.',
    whoFixes: 'provider',
  },
  mx: {
    name: 'Where your email is delivered',
    what: 'Points incoming email for your domain at this server.',
    whoFixes: 'you',
  },
  spf: {
    name: 'Proof this server may send for you',
    what: 'Tells other servers this machine is allowed to send your email.',
    whoFixes: 'you',
  },
  dkim: {
    name: 'Signature on your email',
    what: 'Signs outgoing email so it is not mistaken for a forgery.',
    whoFixes: 'you',
  },
  dmarc: {
    name: 'What to do with suspicious email',
    what: 'Tells other servers how to treat email that fails the checks.',
    whoFixes: 'you',
  },
  submission: {
    name: 'Sending from your devices',
    what: 'The port Outlook uses to send.',
    whoFixes: 'you',
  },
  imap: {
    name: 'Reading your email',
    what: 'The port Outlook uses to read your mailbox.',
    whoFixes: 'you',
  },
};

const entries = computed(() =>
  Object.entries(report.value?.checks ?? {}).map(([key, value]) => ({
    key,
    ...LABELS[key]!,
    state: value.state as CheckState,
    summary: value.summary,
    detail: value.detail,
  })),
);

async function check(): Promise<void> {
  if (!domain.value) return;
  loading.value = true;
  error.value = null;

  try {
    report.value = await api.mail.readiness.query({
      domain: domain.value.trim(),
      mailHostname: mailHostname.value,
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function recordRequested(): Promise<void> {
  try {
    await api.mail.recordUnblockRequested.mutate();
    await check();
  } catch (err) {
    error.value = describeError(err);
  }
}

onMounted(() => undefined);
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <div class="mb-4 rounded-[--radius-card] border border-[--color-border]
                bg-[--color-surface] p-5">
      <label for="domain" class="mb-1 block text-sm font-medium text-[--color-text]">
        Which domain do you want email for?
      </label>

      <div class="flex gap-2">
        <input id="domain" v-model="domain" placeholder="example.com"
               class="flex-1 rounded-md border border-[--color-border] bg-[--color-surface]
                      px-3 py-2 text-sm text-[--color-text]" />
        <button type="button" :disabled="!domain || loading"
                class="flex items-center gap-1.5 rounded-md bg-[--color-brand] px-4 py-2
                       text-sm font-medium text-white disabled:opacity-50"
                @click="check">
          <RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          {{ loading ? 'Checking\u2026' : 'Check' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="mb-4 rounded-md bg-[--color-status-blocked-bg] px-4 py-3 text-sm
                           text-[--color-status-blocked]">
      {{ error }}
    </p>

    <div v-if="!report && !loading"
         class="rounded-[--radius-card] border border-dashed border-[--color-border]
                bg-[--color-surface] px-6 py-12 text-center">
      <Mail :size="30" class="mx-auto mb-3 text-[--color-text-muted]" aria-hidden="true" />
      <h3 class="text-base font-medium text-[--color-text]">Check your email setup</h3>
      <p class="mx-auto mt-1 max-w-md text-sm text-[--color-text-muted]">
        Enter your domain above. The panel will check everything email needs and tell you
        exactly what is missing.
      </p>
    </div>

    <template v-if="report">
      <div v-if="report.checks.outbound.state === 'blocked'"
           class="mb-4 rounded-[--radius-card] border border-[--color-status-warn]
                  bg-[--color-status-warn-bg] p-4">
        <h3 class="mb-1 text-sm font-semibold text-[--color-status-warn]">
          Your hosting provider is blocking outgoing email
        </h3>
        <p class="mb-3 text-sm text-[--color-status-warn]">
          This is normal and deliberate \u2014 providers block it by default to stop spam.
          Ask them to unblock outgoing email (port 25) for this server. It usually takes
          a day or two.
        </p>

        <div class="flex items-center gap-3">
          <a href="https://www.ovh.com/manager/" target="_blank" rel="noreferrer noopener"
             class="text-sm font-medium text-[--color-status-warn] underline underline-offset-2">
            Open your hosting control panel
          </a>

          <button v-if="!report.ovhUnblockRequestedAt" type="button"
                  class="text-sm text-[--color-status-warn] underline underline-offset-2"
                  @click="recordRequested">
            I have asked them
          </button>
          <span v-else class="text-xs text-[--color-status-warn]">
            Asked on {{ new Date(report.ovhUnblockRequestedAt).toLocaleDateString() }}.
            The panel will keep checking.
          </span>
        </div>
      </div>

      <ul class="space-y-3">
        <li v-for="entry in entries" :key="entry.key"
            class="rounded-[--radius-card] border border-[--color-border]
                   bg-[--color-surface] p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-medium text-[--color-text]">{{ entry.name }}</h3>
                <StatusBadge :state="entry.state" size="sm" />
              </div>

              <p class="mt-1 text-sm text-[--color-text-muted]">{{ entry.what }}</p>
              <p class="mt-2 text-sm text-[--color-text]">{{ entry.summary }}</p>

              <p v-if="entry.detail"
                 class="mt-2 break-all rounded bg-[--color-surface-sunken] px-2 py-1
                        font-mono text-xs text-[--color-text-muted]">
                {{ entry.detail }}
              </p>
            </div>

            <span v-if="entry.whoFixes === 'provider' && entry.state !== 'ok'"
                  class="shrink-0 rounded-full bg-[--color-surface-sunken] px-2 py-0.5
                         text-xs text-[--color-text-muted]">
              Your host fixes this
            </span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
