<script setup lang="ts">
import { ref } from 'vue';
import { CloudCog, ExternalLink, Info, Server } from 'lucide-vue-next';
import { REQUIRED_CLOUDFLARE_SCOPES } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import PageHeader from '../components/PageHeader.vue';
import AlertMessage from '../components/AlertMessage.vue';
import ComponentsPanel from '../components/ComponentsPanel.vue';

/**
 * Server-wide settings: the services this panel drives on your behalf.
 *
 * Credentials are verified before they are stored, so a wrong one fails while
 * the user is still looking at the field they pasted it into rather than
 * halfway through a deployment or a mailbox creation.
 */

type SystemInfo = Awaited<ReturnType<typeof api.system.info.query>>;
type MailStatus = Awaited<ReturnType<typeof api.mail.serverStatus.query>>;

const info = ref<SystemInfo | null>(null);

const cloudflare = ref<{ connected: boolean; message: string } | null>(null);
const cloudflareToken = ref('');
const cloudflareBusy = ref(false);

const mail = ref<MailStatus | null>(null);
const mailUser = ref('admin');
const mailPassword = ref('');
const mailBusy = ref(false);

const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    const [systemInfo, dnsStatus, mailStatus] = await Promise.all([
      api.system.info.query(),
      api.dns.status.query(),
      api.mail.serverStatus.query(),
    ]);
    info.value = systemInfo;
    cloudflare.value = dnsStatus;
    mail.value = mailStatus;
  } catch (err) {
    error.value = describeError(err);
  }
}

void refresh();

async function connectCloudflare(): Promise<void> {
  cloudflareBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.dns.connect.mutate({ token: cloudflareToken.value.trim() });
    cloudflareToken.value = '';
    notice.value = result.message;
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    cloudflareBusy.value = false;
  }
}

async function disconnectCloudflare(): Promise<void> {
  cloudflareBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.dns.disconnect.mutate();
    notice.value = 'Cloudflare is disconnected. Your DNS records are untouched.';
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    cloudflareBusy.value = false;
  }
}

async function connectMail(): Promise<void> {
  mailBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.mail.connectServer.mutate({
      username: mailUser.value.trim(),
      password: mailPassword.value,
    });
    mailPassword.value = '';
    notice.value = result.message;
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    mailBusy.value = false;
  }
}

async function disconnectMail(): Promise<void> {
  mailBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.mail.disconnectServer.mutate();
    notice.value = 'The panel has forgotten the mail server password. No mail was touched.';
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    mailBusy.value = false;
  }
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
</script>

<template>
  <div class="max-w-3xl">
    <PageHeader
      title="Settings"
      description="Services this panel drives on your behalf, and the facts about this machine
                   you occasionally need to look up."
    />

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <ComponentsPanel class="mb-4" @changed="refresh" />

    <section class="card p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <CloudCog :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Cloudflare</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Lets the panel point your domains at this server and keep their records tidy,
            without you copying values between two windows.
          </p>

          <p v-if="cloudflare" class="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span
              class="h-1.5 w-1.5 rounded-full"
              :class="cloudflare.connected ? 'bg-ok' : 'bg-idle'"
              aria-hidden="true"
            />
            <span :class="cloudflare.connected ? 'text-ok' : 'text-ink-muted'">
              {{ cloudflare.connected ? 'Connected' : 'Not connected yet' }}
            </span>
            <!-- The message only carries detail worth reading once a token is in. -->
            <span v-if="cloudflare.connected" class="text-ink-faint">
              {{ cloudflare.message }}
            </span>
          </p>
        </div>
      </div>

      <form v-if="!cloudflare?.connected" class="mt-5 space-y-3" @submit.prevent="connectCloudflare">
        <div>
          <label for="cf-token" class="label">API token</label>
          <input
            id="cf-token"
            v-model="cloudflareToken"
            type="password"
            autocomplete="off"
            class="field font-mono"
            placeholder="Paste your Cloudflare API token"
          />
          <p class="hint">
            Create a token with {{ REQUIRED_CLOUDFLARE_SCOPES.join(' and ') }} permissions on the
            zones you want the panel to manage.
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex items-center gap-1 text-brand-bright underline underline-offset-2"
            >
              Create one <ExternalLink :size="11" aria-hidden="true" />
            </a>
          </p>
        </div>

        <button
          type="submit"
          class="btn btn-primary"
          :disabled="cloudflareBusy || cloudflareToken.trim().length < 10"
        >
          {{ cloudflareBusy ? 'Checking\u2026' : 'Connect Cloudflare' }}
        </button>
      </form>

      <button
        v-else
        type="button"
        class="btn btn-ghost mt-5"
        :disabled="cloudflareBusy"
        @click="disconnectCloudflare"
      >
        {{ cloudflareBusy ? 'Working\u2026' : 'Disconnect' }}
      </button>
    </section>

    <section class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Server :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Mail server</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Lets the panel create mailboxes and set how much space each one gets. The mail
            server holds the mailboxes themselves; the panel only holds the password it uses to
            ask, and only ever talks to it over this machine's own loopback address.
          </p>

          <p v-if="mail?.configured && !mail.connected" class="hint">
            Installing the mail server from Programs above sets this up for you.
          </p>

          <p v-if="mail" class="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span
              class="h-1.5 w-1.5 rounded-full"
              :class="
                mail.connected ? 'bg-ok' : mail.reachable ? 'bg-warn' : 'bg-idle'
              "
              aria-hidden="true"
            />
            <span
              :class="mail.connected ? 'text-ok' : mail.reachable ? 'text-warn' : 'text-ink-muted'"
            >
              <template v-if="mail.connected">Connected</template>
              <template v-else-if="mail.reachable && !mail.manageable">
                Running, not manageable here
              </template>
              <template v-else-if="!mail.reachable">Not running</template>
              <template v-else-if="!mail.configured">Not connected yet</template>
              <template v-else>Signed out</template>
            </span>
            <span class="text-ink-faint">{{ mail.message }}</span>
          </p>
        </div>
      </div>

      <!-- No point asking for a password a version without the API cannot use. -->
      <form
        v-if="!mail?.connected && !(mail?.reachable && !mail.manageable)"
        class="mt-5 space-y-3"
        @submit.prevent="connectMail"
      >
        <div class="flex flex-wrap gap-3">
          <div class="w-40">
            <label for="mail-user" class="label">Administrator</label>
            <input id="mail-user" v-model="mailUser" class="field font-mono" autocomplete="off" />
          </div>

          <div class="min-w-56 flex-1">
            <label for="mail-password" class="label">Password</label>
            <input
              id="mail-password"
              v-model="mailPassword"
              type="password"
              autocomplete="off"
              class="field font-mono"
              placeholder="The mail server's administrator password"
            />
          </div>
        </div>

        <p class="hint">
          Set when the mail server was installed. It is stored encrypted on this server and is
          never sent to the browser.
        </p>

        <button
          type="submit"
          class="btn btn-primary"
          :disabled="mailBusy || mailPassword.length === 0"
        >
          {{ mailBusy ? 'Checking\u2026' : 'Connect mail server' }}
        </button>
      </form>

      <button
        v-else
        type="button"
        class="btn btn-ghost mt-5"
        :disabled="mailBusy || !mail?.configured"
        @click="disconnectMail"
      >
        {{ mailBusy ? 'Working\u2026' : 'Disconnect' }}
      </button>
    </section>

    <section v-if="info" class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-elevated text-ink-muted"
          aria-hidden="true"
        >
          <Info :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">This server</h2>
          <p class="mt-1 text-sm text-ink-muted">
            The details worth having to hand when something needs looking at.
          </p>
        </div>
      </div>

      <dl class="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Panel version</dt>
          <dd class="mt-0.5 font-mono text-sm text-ink">{{ info.version }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Machine name</dt>
          <dd class="mt-0.5 font-mono text-sm text-ink">{{ info.hostname }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Addresses</dt>
          <dd class="mt-0.5 font-mono text-sm text-ink">
            {{ info.addresses.join(', ') || '\u2014' }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Running for</dt>
          <dd class="mt-0.5 text-sm text-ink">{{ uptime(info.uptimeSeconds) }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Websites folder</dt>
          <dd class="mt-0.5 break-all font-mono text-sm text-ink">{{ info.paths.sites }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-ink-faint">Panel folder</dt>
          <dd class="mt-0.5 break-all font-mono text-sm text-ink">{{ info.paths.root }}</dd>
        </div>
      </dl>

      <AlertMessage v-if="!info.httpsEnabled" tone="warning" class="mt-5">
        This panel is being served without encryption. Anyone on the network between you and it
        can read your password and session.
      </AlertMessage>
    </section>
  </div>
</template>
