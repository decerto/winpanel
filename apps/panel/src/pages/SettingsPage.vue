<script setup lang="ts">
import { computed, ref } from 'vue';
import { CloudCog, ExternalLink, Info, Power, Server } from 'lucide-vue-next';
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
type BackgroundServices = Awaited<ReturnType<typeof api.system.backgroundServices.query>>;
type ShutdownResult = Awaited<ReturnType<typeof api.system.shutdown.mutate>>;

const info = ref<SystemInfo | null>(null);

const cloudflare = ref<{ connected: boolean; message: string } | null>(null);
const cloudflareToken = ref('');
const cloudflareBusy = ref(false);

const mail = ref<MailStatus | null>(null);
const mailUser = ref('admin');
const mailPassword = ref('');
const mailBusy = ref(false);

const services = ref<BackgroundServices>([]);
const shutdownBusy = ref(false);
const startAllBusy = ref(false);
const serviceBusyId = ref<string | null>(null);
const shutdownResult = ref<ShutdownResult | null>(null);

const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    const [systemInfo, dnsStatus, mailStatus, background] = await Promise.all([
      api.system.info.query(),
      api.dns.status.query(),
      api.mail.serverStatus.query(),
      api.system.backgroundServices.query(),
    ]);
    info.value = systemInfo;
    cloudflare.value = dnsStatus;
    mail.value = mailStatus;
    services.value = background;
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
    // The token can verify against Cloudflare and still not be usable yet —
    // if the web server is not installed, nothing can act on it.
    notice.value = result.warning ? `${result.message} ${result.warning}` : result.message;
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

const STATE_DOT: Record<string, string> = {
  running: 'bg-ok',
  stopped: 'bg-idle',
  starting: 'bg-warn',
  stopping: 'bg-warn',
  unknown: 'bg-idle',
};

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  unknown: 'Unknown',
};

/** One in-flight service operation at a time, so the list cannot fight itself. */
const servicesBusy = computed(
  () => shutdownBusy.value || startAllBusy.value || serviceBusyId.value !== null,
);

const stoppableCount = computed(
  () => services.value.filter((service) => service.state === 'running').length,
);

const startableCount = computed(
  () =>
    services.value.filter((service) => service.kind !== 'panel' && service.state !== 'running')
      .length,
);

/**
 * Stops everything, this panel last.
 *
 * The confirmation spells out the consequence and the way back, because the
 * one thing this button removes is the ability to undo it from here.
 */
async function shutdownEverything(): Promise<void> {
  const running = services.value.filter((service) => service.state === 'running');

  if (
    !window.confirm(
      `Stop all ${running.length} background programs, including this control panel?\n\n` +
        'Your websites and email go offline. Nothing is deleted and no settings change.\n\n' +
        'To start it all again, restart the server, or run "net start winpanel-agent" from ' +
        'an administrator command prompt.',
    )
  ) {
    return;
  }

  shutdownBusy.value = true;
  error.value = null;
  notice.value = null;
  shutdownResult.value = null;

  /*
   * The panel stops itself moments after replying, so this request is one of
   * the few that can legitimately never come back. Without a deadline the
   * button would stay disabled with a spinner and no way out but reloading a
   * page that may no longer be served.
   */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);

  try {
    shutdownResult.value = await api.system.shutdown.mutate(
      { includePanel: true },
      { signal: controller.signal },
    );
  } catch (err) {
    error.value = controller.signal.aborted
      ? 'The server stopped answering before it confirmed. It has most likely shut down. ' +
        'Check services.msc on the server, or restart it to bring everything back.'
      : describeError(err);
  } finally {
    clearTimeout(timer);
    shutdownBusy.value = false;
  }
}

/** Every deadline here exists because a wedged service can hang for minutes. */
function withDeadline(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function startEverything(): Promise<void> {
  startAllBusy.value = true;
  error.value = null;
  notice.value = null;
  shutdownResult.value = null;

  const deadline = withDeadline(300_000);

  try {
    const result = await api.system.startAll.mutate(undefined, { signal: deadline.signal });

    notice.value =
      result.changed.length > 0
        ? `Started ${result.changed.join(', ')}.`
        : 'Everything was already running.';

    if (result.failed.length > 0) {
      error.value = result.failed
        .map((failure) => `${failure.label} — ${failure.reason}`)
        .join(' ');
    }
  } catch (err) {
    error.value = deadline.signal.aborted
      ? 'The server took too long to answer. Refresh to see what is running now.'
      : describeError(err);
  } finally {
    deadline.done();
    startAllBusy.value = false;
    await refresh();
  }
}

async function controlService(
  service: BackgroundServices[number],
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  if (
    action !== 'start' &&
    !window.confirm(
      `${action === 'stop' ? 'Stop' : 'Restart'} ${service.label}?\n\n` +
        'Anything it serves is unreachable until it is running again.',
    )
  ) {
    return;
  }

  serviceBusyId.value = service.id;
  error.value = null;
  notice.value = null;

  const deadline = withDeadline(150_000);

  try {
    await api.system.serviceAction.mutate(
      { id: service.id, action },
      { signal: deadline.signal },
    );
    notice.value = `${service.label} is ${action === 'stop' ? 'stopped' : 'running'}.`;
  } catch (err) {
    error.value = deadline.signal.aborted
      ? `${service.label} did not answer in time. Refresh to see its current state.`
      : describeError(err);
  } finally {
    deadline.done();
    serviceBusyId.value = null;
    await refresh();
  }
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

    <section class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-elevated text-ink-muted"
          aria-hidden="true"
        >
          <Power :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Background programs</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Everything the panel runs for you. None of these have a window of their own, so
            this is the only place they are visible. Stop them all before updating or removing
            WinPanel &mdash; otherwise Windows refuses to replace files they are holding open.
          </p>
        </div>
      </div>

      <ul v-if="services.length > 0" class="mt-5 divide-y divide-line border-y border-line">
        <li
          v-for="service in services"
          :key="service.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
        >
          <span class="h-1.5 w-1.5 rounded-full" :class="STATE_DOT[service.state]" aria-hidden="true" />

          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">{{ service.label }}</span>
            <span class="block truncate font-mono text-xs text-ink-faint">{{ service.id }}</span>
          </span>

          <span
            class="w-20 text-right text-xs"
            :class="service.state === 'running' ? 'text-ok' : 'text-ink-faint'"
          >
            {{ serviceBusyId === service.id ? 'Working\u2026' : STATE_LABEL[service.state] }}
          </span>

          <!--
            The panel is missing its buttons on purpose: it cannot start itself
            once stopped, so stopping it belongs with the all-or-nothing action
            below, where the way back is spelled out.
          -->
          <span v-if="service.kind === 'panel'" class="w-40 text-right text-xs text-ink-faint">
            Stopped with everything else
          </span>
          <span v-else class="flex w-40 justify-end gap-1.5">
            <button
              v-if="service.state === 'running'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="servicesBusy"
              @click="controlService(service, 'restart')"
            >
              Restart
            </button>
            <button
              v-if="service.state === 'running'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="servicesBusy"
              @click="controlService(service, 'stop')"
            >
              Stop
            </button>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="servicesBusy"
              @click="controlService(service, 'start')"
            >
              Start
            </button>
          </span>
        </li>
      </ul>

      <AlertMessage v-else tone="warning" class="mt-5">
        Windows is not managing this panel, so there is nothing here to start or stop. It will
        not come back on its own after a restart. Running the installer again registers it.
      </AlertMessage>

      <AlertMessage
        v-if="shutdownResult"
        :tone="shutdownResult.failed.length > 0 ? 'warning' : 'success'"
        class="mt-5"
      >
        <template v-if="shutdownResult.changed.length > 0">
          Stopped {{ shutdownResult.changed.join(', ') }}.
        </template>
        <template v-else>Nothing was left running to stop.</template>
        <template v-if="shutdownResult.panelStopping">
          This panel is stopping now and will not answer again until the server is restarted,
          or you run <code class="font-mono">net start winpanel-agent</code> on it.
        </template>
        <ul v-if="shutdownResult.failed.length > 0" class="mt-2 list-disc pl-5">
          <li v-for="failure in shutdownResult.failed" :key="failure.id">
            {{ failure.label }} &mdash; {{ failure.reason }} You may need to end it from Task
            Manager.
          </li>
        </ul>
      </AlertMessage>

      <div class="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="servicesBusy || startableCount === 0"
          @click="startEverything"
        >
          {{ startAllBusy ? 'Starting\u2026' : `Start everything (${startableCount})` }}
        </button>
        <button
          type="button"
          class="btn btn-danger"
          :disabled="servicesBusy || stoppableCount === 0"
          @click="shutdownEverything"
        >
          {{ shutdownBusy ? 'Stopping\u2026' : 'Stop everything' }}
        </button>
        <button type="button" class="btn btn-ghost" :disabled="servicesBusy" @click="refresh">
          Refresh
        </button>
      </div>
    </section>
  </div>
</template>
