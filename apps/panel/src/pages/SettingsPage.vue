<script setup lang="ts">
import { computed, ref } from 'vue';
import { CloudCog, Download, ExternalLink, FolderSearch, Info, Power, RefreshCw, Server } from 'lucide-vue-next';
import { CLOUDFLARE_PERMISSION_SUMMARY } from '@winpanel/shared';
import { api, describeError } from '../lib/api';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';
import PageHeader from '../components/PageHeader.vue';
import AlertMessage from '../components/AlertMessage.vue';
import ComponentsPanel from '../components/ComponentsPanel.vue';
import ServerPathPicker from '../components/ServerPathPicker.vue';

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

/*
 * Replacing or stopping the panel is the owner's alone, so an administrator
 * is not shown a button that will only ever refuse them. The server enforces
 * it either way.
 */
const isOwner = ref(false);
void api.auth.me
  .query()
  .then((user) => (isOwner.value = user?.role === 'superadmin'))
  .catch(() => undefined);

const cloudflare = ref<{ connected: boolean; message: string } | null>(null);
const cloudflareToken = ref('');
const cloudflareBusy = ref(false);

const mail = ref<MailStatus | null>(null);
const mailUser = ref('admin');
const mailPassword = ref('');
const mailBusy = ref(false);
/** The manual sign-in is the fallback, so it stays out of the way until asked for. */
const mailManual = ref(false);

const services = ref<BackgroundServices>([]);
const shutdownBusy = ref(false);
const startAllBusy = ref(false);
const serviceBusyId = ref<string | null>(null);
const shutdownResult = ref<ShutdownResult | null>(null);

const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * Updating the panel from the panel.
 *
 * The installer upgrades in place — it stops what WinPanel runs, replaces the
 * program files and starts it all again, keeping websites, mailboxes and
 * settings. Without this, every fix meant uninstalling, which is why it is
 * here rather than in a document nobody reads at the time.
 */
const updateSource = ref<'upload' | 'url' | 'file'>('upload');
const updateUrl = ref('');
const updateFile = ref('');
const updateChecksum = ref('');
const updateBusy = ref(false);
const updateJob = useJobLog();
const restartBusy = ref(false);
/** The server file browser, so nobody has to type a Windows path from memory. */
const browsingForInstaller = ref(false);

/**
 * The installer picked with the ordinary Windows file dialog.
 *
 * A browser hands over a file's contents but never its path, so this one is
 * sent up to the server rather than pointed at. It is the only option that
 * works when the setup file is on the computer you are sitting at and the
 * server has no way to reach it.
 */
const installerFile = ref<File | null>(null);
const uploadPercent = ref<number | null>(null);
let upload: XMLHttpRequest | null = null;

const canUpdate = computed(() => {
  if (updateSource.value === 'url') return updateUrl.value.trim().length > 0;
  if (updateSource.value === 'upload') return installerFile.value !== null;
  return updateFile.value.trim().length > 0;
});

function chooseInstaller(event: Event): void {
  installerFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function describeSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Sends the installer to the server and answers with where it landed.
 *
 * XMLHttpRequest rather than fetch purely for the progress events: this is a
 * transfer measured in tens of megabytes, and a button that says nothing for a
 * minute is indistinguishable from one that has hung.
 */
function sendInstaller(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest();
    upload = request;
    uploadPercent.value = 0;

    request.open('POST', '/api/panel-update/installer');
    request.setRequestHeader('Content-Type', 'application/octet-stream');

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        uploadPercent.value = Math.floor((event.loaded / event.total) * 100);
      }
    });

    request.addEventListener('load', () => {
      let body: { path?: string; error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // Left empty: the status code below is enough to say what happened.
      }

      if (request.status === 200 && body.path) resolve(body.path);
      else reject(new Error(body.error ?? `The server refused the upload (${request.status}).`));
    });

    request.addEventListener('error', () =>
      reject(new Error('The upload was interrupted. Check the connection and try again.')),
    );
    request.addEventListener('abort', () => reject(new Error('The upload was stopped.')));

    request.send(file);
  });
}

function cancelUpload(): void {
  upload?.abort();
}

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

/**
 * Sets the panel up on the mail server without anyone typing a password.
 *
 * The mail server is restarted as part of this, so the wait is long by the
 * standards of a settings page and needs its own deadline rather than the
 * browser's.
 */
async function provisionMail(): Promise<void> {
  mailBusy.value = true;
  error.value = null;
  notice.value = null;

  const deadline = withDeadline(120_000);

  try {
    const result = await api.mail.provisionServer.mutate(undefined, { signal: deadline.signal });
    notice.value = result.message;
    await refresh();
  } catch (err) {
    error.value = deadline.signal.aborted
      ? 'The mail server took too long to come back. Refresh this page to see where it got to.'
      : describeError(err);
  } finally {
    deadline.done();
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

/**
 * Restarts the panel itself.
 *
 * The reply arrives before the restart begins, so the only honest thing to do
 * afterwards is tell the user the connection is about to drop and when to come
 * back — not spin forever waiting for an answer that cannot come.
 */
async function restartPanel(): Promise<void> {
  if (
    !window.confirm(
      'Restart the control panel?\n\n' +
        'This page will lose its connection for a few seconds. Your websites and email keep ' +
        'running throughout.',
    )
  ) {
    return;
  }

  restartBusy.value = true;
  error.value = null;
  notice.value = null;

  const deadline = withDeadline(30_000);

  try {
    await api.system.restartPanel.mutate(undefined, { signal: deadline.signal });
    notice.value =
      'The panel is restarting. Reload this page in about half a minute.';
  } catch (err) {
    error.value = deadline.signal.aborted
      ? 'The panel stopped answering before it confirmed, which usually means it is already ' +
        'restarting. Reload this page shortly.'
      : describeError(err);
  } finally {
    deadline.done();
    restartBusy.value = false;
  }
}

async function installUpdate(): Promise<void> {
  if (
    !window.confirm(
      'Install this over the running WinPanel?\n\n' +
        'Everything WinPanel runs stops while the files are replaced, so websites and email ' +
        'are briefly offline. Your websites, mailboxes, certificates and settings are kept.',
    )
  ) {
    return;
  }

  updateBusy.value = true;
  error.value = null;
  notice.value = null;

  const deadline = withDeadline(60_000);

  try {
    // Sent first, so a transfer that fails leaves the running panel alone.
    const serverPath =
      updateSource.value === 'upload' && installerFile.value
        ? await sendInstaller(installerFile.value)
        : updateFile.value.trim();

    const result = await api.system.update.mutate(
      {
        ...(updateSource.value === 'url'
          ? { url: updateUrl.value.trim() }
          : { filePath: serverPath }),
        ...(updateChecksum.value.trim() ? { sha256: updateChecksum.value.trim() } : {}),
      },
      { signal: deadline.signal },
    );
    updateJob.watchJob(result.jobId);
  } catch (err) {
    error.value = deadline.signal.aborted
      ? 'The server took too long to accept the update. Refresh and check the Activity list.'
      : describeError(err);
  } finally {
    deadline.done();
    upload = null;
    uploadPercent.value = null;
    updateBusy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl">
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
          <h2 class="text-base font-semibold text-ink">Cloudflare (shared token)</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Used by every website that has no token of its own, which is what you want when all
            your domains live in one Cloudflare account. A token only reaches the domains of the
            account that made it, so a website in a different account gets its own token on its
            DNS tab instead. This one is optional.
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
            Create a token with {{ CLOUDFLARE_PERMISSION_SUMMARY }} permissions on the zones you
            want the panel to manage. Each website&#8217;s DNS tab explains this step by step if
            you would rather do it there.
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

          <p v-if="mail && !mail.connected" class="hint">
            The panel creates its own administrator account on the mail server, so there is no
            password to look up. Nothing already set up in the mail server is changed.
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

      <div v-if="!mail?.connected" class="mt-5 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="mailBusy || !mail?.reachable"
            @click="provisionMail"
          >
            {{ mailBusy ? 'Setting up\u2026' : 'Set up mail management' }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="mailBusy"
            @click="mailManual = !mailManual"
          >
            {{ mailManual ? 'Never mind' : 'Use an existing account instead' }}
          </button>
        </div>

        <p v-if="!mail?.reachable" class="hint">
          The mail server has to be installed and running first. Install it from the list of
          programs above.
        </p>
        <p v-else class="hint">
          This restarts the mail server, so mail pauses for a few seconds. Mailboxes and
          messages are untouched.
        </p>

        <form
          v-if="mailManual"
          class="space-y-3 border-t border-line pt-3"
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
            For a mail server you already administer yourself. The account needs permission to
            manage domains and accounts. It is stored encrypted on this server and is never sent
            to the browser.
          </p>

          <button
            type="submit"
            class="btn btn-ghost"
            :disabled="mailBusy || mailPassword.length === 0"
          >
            {{ mailBusy ? 'Checking\u2026' : 'Sign in' }}
          </button>
        </form>
      </div>

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

    <section v-if="isOwner" class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Download :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Update WinPanel</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Installs a newer WinPanel over this one. There is no need to remove it first: your
            websites, mailboxes, certificates and settings are all kept, and everything is
            started again when the files have been replaced.
          </p>
        </div>
      </div>

      <div class="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :class="updateSource === 'upload' ? 'text-ink' : ''"
          :aria-pressed="updateSource === 'upload'"
          @click="updateSource = 'upload'"
        >
          From my computer
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :class="updateSource === 'url' ? 'text-ink' : ''"
          :aria-pressed="updateSource === 'url'"
          @click="updateSource = 'url'"
        >
          Download it
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :class="updateSource === 'file' ? 'text-ink' : ''"
          :aria-pressed="updateSource === 'file'"
          @click="updateSource = 'file'"
        >
          Already on this server
        </button>
      </div>

      <form class="mt-4 space-y-3" @submit.prevent="installUpdate">
        <div v-if="updateSource === 'upload'">
          <label for="update-upload" class="label">Choose the setup file</label>
          <input
            id="update-upload"
            type="file"
            accept=".exe,application/vnd.microsoft.portable-executable"
            class="field file:mr-3 file:rounded-md file:border-0 file:bg-elevated file:px-3
                   file:py-1.5 file:text-sm file:text-ink"
            :disabled="updateBusy"
            @change="chooseInstaller"
          />
          <p class="hint">
            Opens the ordinary Windows file dialog and sends the setup program to the server, so
            this works even when the server itself cannot reach the internet.
            <span v-if="installerFile">
              Sending {{ describeSize(installerFile.size) }}.
            </span>
          </p>

          <div v-if="uploadPercent !== null" class="mt-3 flex items-center gap-3">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
              <div
                class="h-full rounded-full bg-brand-bright transition-all"
                :style="{ width: `${uploadPercent}%` }"
              />
            </div>
            <span class="text-xs tabular-nums text-ink-muted">{{ uploadPercent }}%</span>
            <button type="button" class="btn btn-ghost btn-sm" @click="cancelUpload">Stop</button>
          </div>
        </div>

        <div v-else-if="updateSource === 'url'">
          <label for="update-url" class="label">Address of the setup file</label>
          <input
            id="update-url"
            v-model="updateUrl"
            class="field font-mono"
            placeholder="Paste the https:// link to WinPanel-Setup-x64.exe"
          />
          <p class="hint">
            Must be an <span class="font-mono">https://</span> link straight to the setup
            program &mdash; on a GitHub release page, the download link for the
            <span class="font-mono">.exe</span> itself.
          </p>
        </div>

        <div v-else>
          <label for="update-file" class="label">Full path on this server</label>
          <div class="flex flex-wrap items-center gap-2">
            <input
              id="update-file"
              v-model="updateFile"
              class="field min-w-64 flex-1 font-mono"
              placeholder="Browse to the setup file, or paste its path"
            />
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="updateBusy"
              @click="browsingForInstaller = true"
            >
              <FolderSearch :size="15" aria-hidden="true" /> Browse
            </button>
          </div>
          <p class="hint">For a server with no internet access. Copy the file across first.</p>
        </div>

        <div>
          <label for="update-checksum" class="label">Fingerprint (optional)</label>
          <input
            id="update-checksum"
            v-model="updateChecksum"
            class="field font-mono"
            placeholder="SHA-256, if the release publishes one"
          />
          <p class="hint">
            Checked before anything is run, so a download that was altered on the way is
            refused rather than installed.
          </p>
        </div>

        <AlertMessage tone="warning">
          Everything WinPanel runs stops while the files are replaced, so websites and email are
          offline for a minute or two. This page will lose its connection &mdash; reload it once
          the panel answers again.
        </AlertMessage>

        <button
          type="submit"
          class="btn btn-primary"
          :disabled="updateBusy || updateJob.running.value || !canUpdate"
        >
          <Download :size="15" aria-hidden="true" />
          {{ updateBusy || updateJob.running.value ? 'Working\u2026' : 'Install this update' }}
        </button>
      </form>

      <pre
        v-if="updateJob.lines.value.length > 0"
        class="mt-4 max-h-64 overflow-y-auto rounded-card bg-black/25 p-4 font-mono text-xs
               leading-relaxed"
      ><span
        v-for="line in updateJob.lines.value"
        :key="line.seq"
        class="block"
        :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
      >{{ line.message }}</span></pre>

      <div class="mt-5 border-t border-line pt-5">
        <h3 class="text-sm font-semibold text-ink">Restart the panel</h3>
        <p class="mt-1 text-sm text-ink-muted">
          Stops and starts the control panel on its own. Websites and email are untouched. Worth
          trying when the panel itself is behaving oddly, and after changing anything it only
          reads at start-up.
        </p>
        <button
          type="button"
          class="btn btn-ghost mt-3"
          :disabled="restartBusy"
          @click="restartPanel"
        >
          <RefreshCw :size="15" :class="restartBusy ? 'animate-spin' : ''" aria-hidden="true" />
          {{ restartBusy ? 'Restarting\u2026' : 'Restart the panel' }}
        </button>
      </div>

      <ServerPathPicker
        v-model="updateFile"
        :open="browsingForInstaller"
        :extensions="['.exe']"
        title="Find the WinPanel setup file"
        @close="browsingForInstaller = false"
      />
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
            this is the only place they are visible. Stop them all before removing WinPanel
            &mdash; otherwise Windows refuses to delete files they are holding open. Updating
            does this for you.
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
          v-if="isOwner"
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
