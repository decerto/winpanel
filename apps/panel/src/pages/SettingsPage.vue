<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  Download,
  ExternalLink,
  FolderSearch,
  Gamepad2,
  Github,
  Info,
  Lock,
  Mail,
  Power,
  RefreshCw,
  Server,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { LOG_LEVEL_CLASS, useJobLog } from '../lib/job-log';
import PageHeader from '../components/PageHeader.vue';
import AlertMessage from '../components/AlertMessage.vue';
import ComponentsPanel from '../components/ComponentsPanel.vue';
import HowTo from '../components/HowTo.vue';
import SearchableSelect from '../components/SearchableSelect.vue';
import ServerPathPicker from '../components/ServerPathPicker.vue';
import Tooltip from '../components/Tooltip.vue';

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
type PanelCertificate = Awaited<ReturnType<typeof api.system.panelCertificate.query>>;
type GameServersSettings = Awaited<ReturnType<typeof api.gameServers.settings.query>>;
type PanelEmailSettings = Awaited<ReturnType<typeof api.notifications.settings.query>>;
type PanelEmailAddressOption = Awaited<ReturnType<typeof api.notifications.localAddresses.query>>[number];
type OfficialReleases = Awaited<ReturnType<typeof api.system.releases.query>>;
type OfficialRelease = OfficialReleases['releases'][number];

const info = ref<SystemInfo | null>(null);

/** Owner-only sections. Re-read by every refresh, not fetched once at setup. */
const isOwner = ref(false);

/** The hostname box is only filled from the server before the user touches it. */
let firstLoad = true;

const mail = ref<MailStatus | null>(null);
const mailUser = ref('admin');
const mailPassword = ref('');
const mailBusy = ref(false);
/** The manual sign-in is the fallback, so it stays out of the way until asked for. */
const mailManual = ref(false);
const panelEmail = ref<PanelEmailSettings | null>(null);
const panelEmailLocalAddresses = ref<PanelEmailAddressOption[]>([]);
const panelEmailMode = ref<'local' | 'external' | 'new'>('local');
const panelEmailAddress = ref('');
const panelEmailName = ref('WinPanel');
const panelEmailLocalPassword = ref('');
const panelEmailSmtpHost = ref('');
const panelEmailSmtpPort = ref('587');
const panelEmailSmtpSecurity = ref<'none' | 'starttls' | 'tls'>('starttls');
const panelEmailSmtpUsername = ref('');
const panelEmailSmtpPassword = ref('');
const panelEmailSaving = ref(false);
const panelEmailTestRecipient = ref('');
const panelEmailTesting = ref(false);

const services = ref<BackgroundServices>([]);
const gameServers = ref<GameServersSettings | null>(null);
const gameServersBusy = ref(false);
const steamUsername = ref('');
const steamPassword = ref('');
const steamCredentialsBusy = ref(false);
const steamWebApiKey = ref('');
const steamWebApiKeyBusy = ref(false);
const gameServersJob = useJobLog({
  onFinished: async () => {
    gameServersBusy.value = false;
    await refreshGameServers();
  },
});
const shutdownBusy = ref(false);
const startAllBusy = ref(false);
const serviceBusyId = ref<string | null>(null);
const shutdownResult = ref<ShutdownResult | null>(null);

const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * The panel's own address and certificate.
 *
 * Separate from the websites' certificates in every respect: this is the name
 * the administrator signs in at, it belongs to no website, and setting it
 * changes nothing about how the websites are served or how their certificates
 * are obtained.
 */
const panelCertificate = ref<PanelCertificate | null>(null);
const panelHostname = ref('');
const panelHostnameBusy = ref(false);
/**
 * The web server obtains the certificate seconds after the name is saved, so
 * the page polls rather than telling the user to come back and look again.
 */
const awaitingPanelCertificate = ref(false);
let panelPoll: ReturnType<typeof setInterval> | null = null;
let panelPollsLeft = 0;

function stopPanelPoll(): void {
  if (panelPoll) clearInterval(panelPoll);
  panelPoll = null;
  awaitingPanelCertificate.value = false;
}

onUnmounted(stopPanelPoll);

async function loadPanelCertificate({ adoptHostname = false } = {}): Promise<void> {
  try {
    const result = await api.system.panelCertificate.query();
    panelCertificate.value = result;
    if (adoptHostname) panelHostname.value = result.hostname ?? '';
    // Nothing left to wait for once it is in place.
    if (result.source === 'issued') stopPanelPoll();
  } catch {
    // An administrator who is not the owner still sees the rest of the page.
  }
}

function startPanelPoll(): void {
  stopPanelPoll();
  awaitingPanelCertificate.value = true;
  // Two minutes. Beyond that it is a DNS or firewall problem, not slowness.
  panelPollsLeft = 40;
  panelPoll = setInterval(() => {
    if (panelPollsLeft-- <= 0) {
      stopPanelPoll();
      return;
    }
    void loadPanelCertificate();
  }, 3000);
}

async function savePanelHostname(): Promise<void> {
  panelHostnameBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const wanted = panelHostname.value.trim();
    const result = await api.system.setPanelHostname.mutate({ hostname: wanted || null });

    if (result.hostname === null) {
      stopPanelPoll();
      notice.value =
        'The panel is back to being reached by IP address, on the certificate it signed ' +
        'itself. Your websites are unaffected.';
    } else if (result.webServerWarning) {
      error.value = result.webServerWarning;
    } else {
      // Saved either way. Whether the name resolves here is reported below,
      // where it can be phrased as the thing to go and fix rather than as a
      // failure of the save.
      notice.value =
        result.dnsPointsHere === true
          ? `Saved. Getting a certificate for ${result.hostname}\u2026`
          : `Saved ${result.hostname} as the panel\u2019s address.`;
      startPanelPoll();
    }

    await loadPanelCertificate();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    panelHostnameBusy.value = false;
  }
}

async function removePanelHostname(): Promise<void> {
  panelHostname.value = '';
  await savePanelHostname();
}

/**
 * Updating the panel from the panel.
 *
 * The installer upgrades in place — it stops what WinPanel runs, replaces the
 * program files and starts it all again, keeping websites, mailboxes and
 * settings. Without this, every fix meant uninstalling, which is why it is
 * here rather than in a document nobody reads at the time.
 */
const updateSource = ref<'official' | 'upload' | 'url' | 'file'>('official');
const updateUrl = ref('');
const updateFile = ref('');
const updateChecksum = ref('');
const updateBusy = ref(false);
const updateJob = useJobLog();
const restartBusy = ref(false);
const officialReleases = ref<OfficialRelease[]>([]);
const officialRepositoryUrl = ref('https://github.com/decerto/winpanel/releases');
const selectedReleaseTag = ref<string | null>(null);
const officialReleasesBusy = ref(false);
const officialReleasesError = ref<string | null>(null);
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

function compareReleaseVersions(left: string, right: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
  };

  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;

  const [leftMajor, leftMinor, leftPatch] = leftParts;
  const [rightMajor, rightMinor, rightPatch] = rightParts;
  if (leftMajor !== rightMajor) return leftMajor > rightMajor ? 1 : -1;
  if (leftMinor !== rightMinor) return leftMinor > rightMinor ? 1 : -1;
  if (leftPatch !== rightPatch) return leftPatch > rightPatch ? 1 : -1;
  return 0;
}

const latestRelease = computed(
  () => officialReleases.value.find((release) => !release.isPrerelease) ?? officialReleases.value[0] ?? null,
);
const selectedRelease = computed(
  () => officialReleases.value.find((release) => release.tagName === selectedReleaseTag.value) ?? latestRelease.value,
);
const releaseStatus = computed<'current' | 'available' | 'ahead' | 'unknown'>(() => {
  const currentVersion = info.value?.version;
  const latest = latestRelease.value;
  if (!currentVersion || !latest) return 'unknown';

  const comparison = compareReleaseVersions(currentVersion, latest.tagName);
  if (comparison === null) return 'unknown';
  if (comparison === 0) return 'current';
  return comparison > 0 ? 'ahead' : 'available';
});

function isLatestRelease(release: OfficialRelease): boolean {
  return latestRelease.value?.tagName === release.tagName;
}

function isCurrentRelease(release: OfficialRelease): boolean {
  return compareReleaseVersions(info.value?.version ?? '', release.tagName) === 0;
}

function formatReleaseDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

const canUpdate = computed(() => {
  if (updateSource.value === 'official') return Boolean(selectedRelease.value?.installer);
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

/**
 * Reloads every panel on the page.
 *
 * Settled rather than all: these are independent sections, and one of them
 * failing should cost the user that section rather than the whole page. It
 * also has to cover *everything* the page shows, including who is signed in —
 * anything fetched once at setup and never again turns a momentary failure
 * into a section that stays missing until the page is reloaded, with a Refresh
 * button sitting there that cannot bring it back.
 */
async function refresh(): Promise<void> {
  error.value = null;

  const results = await Promise.allSettled([
    api.system.info.query(),
    api.mail.serverStatus.query(),
    api.system.backgroundServices.query(),
    api.auth.me.query(),
    api.gameServers.settings.query(),
  ]);

  const [systemInfo, mailStatus, background, me, gameServerSettings] = results;

  if (systemInfo.status === 'fulfilled') info.value = systemInfo.value;
  if (mailStatus.status === 'fulfilled') mail.value = mailStatus.value;
  if (background.status === 'fulfilled') services.value = background.value;
  /*
   * Replacing or stopping the panel is the owner's alone, so an administrator
   * is not shown a button that will only ever refuse them. The server enforces
   * it either way.
   */
  if (me.status === 'fulfilled') {
    isOwner.value = me.value?.role === 'superadmin';
    if (isOwner.value) {
      void refreshOfficialReleases();
      void refreshPanelEmail();
    } else {
      panelEmail.value = null;
    }
  }
  if (gameServerSettings.status === 'fulfilled') gameServers.value = gameServerSettings.value;

  await loadPanelCertificate({ adoptHostname: firstLoad });
  firstLoad = false;

  const failure = results.find((result) => result.status === 'rejected');
  if (failure) error.value = describeError(failure.reason);
}

async function refreshPanelEmail(): Promise<void> {
  const [settingsResult, addressesResult] = await Promise.allSettled([
    api.notifications.settings.query(),
    api.notifications.localAddresses.query(),
  ]);

  if (settingsResult.status === 'fulfilled') {
    const result = settingsResult.value;
    panelEmail.value = result;
    if (result) {
      panelEmailMode.value = result.mode;
      panelEmailAddress.value = result.fromAddress;
      panelEmailName.value = result.fromName;
      panelEmailLocalPassword.value = '';
      panelEmailSmtpHost.value = result.smtpHost ?? '';
      panelEmailSmtpPort.value = String(result.smtpPort ?? 587);
      panelEmailSmtpSecurity.value = result.smtpSecurity ?? 'starttls';
      panelEmailSmtpUsername.value = result.smtpUsername ?? '';
    }
  }
  if (addressesResult.status === 'fulfilled') panelEmailLocalAddresses.value = addressesResult.value;
}

async function savePanelEmail(): Promise<boolean> {
  const mode = panelEmailMode.value;
  if (!panelEmailAddress.value.trim()) {
    error.value = mode === 'local' ? 'Choose an existing mailbox.' : 'Enter a sender address.';
    return false;
  }

  panelEmailSaving.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.notifications.saveSettings.mutate({
      mode,
      fromAddress: panelEmailAddress.value.trim(),
      fromName: panelEmailName.value.trim() || 'WinPanel',
      smtpHost: mode === 'external' ? panelEmailSmtpHost.value.trim() || null : null,
      smtpPort:
        mode === 'external' ? Number(panelEmailSmtpPort.value) || null : null,
      smtpSecurity: mode === 'external' ? panelEmailSmtpSecurity.value : null,
      smtpUsername:
        mode === 'external' ? panelEmailSmtpUsername.value.trim() || null : null,
      ...(mode === 'external' && panelEmailSmtpPassword.value
        ? { smtpPassword: panelEmailSmtpPassword.value }
        : {}),
      ...(mode === 'local' && panelEmailLocalPassword.value
        ? { localPassword: panelEmailLocalPassword.value }
        : {}),
    });
    panelEmail.value = result;
    panelEmailMode.value = result.mode;
    panelEmailAddress.value = result.fromAddress;
    panelEmailLocalPassword.value = '';
    panelEmailSmtpPassword.value = '';
    notice.value =
      mode === 'new'
        ? 'A new send-only panel mailbox was created on this server.'
        : mode === 'local'
          ? 'Panel email is ready. The selected mailbox will send panel messages.'
        : 'Panel email settings saved. Send a test message to verify the connection.';
    return true;
  } catch (err) {
    error.value = describeError(err);
    return false;
  } finally {
    panelEmailSaving.value = false;
  }
}

function localPasswordIsOptional(): boolean {
  return (
    panelEmail.value?.mode === 'local' &&
    panelEmail.value.fromAddress === panelEmailAddress.value.trim().toLowerCase() &&
    panelEmail.value.localPasswordConfigured
  );
}

async function testPanelEmail(): Promise<void> {
  const recipient = panelEmailTestRecipient.value.trim();
  if (!recipient || panelEmailTesting.value) return;
  panelEmailTesting.value = true;
  error.value = null;
  notice.value = null;

  try {
    if (!(await savePanelEmail())) return;
    notice.value = null;
    await api.notifications.test.mutate({ recipient });
    notice.value = `Test email sent to ${recipient}.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    panelEmailTesting.value = false;
  }
}

async function refreshOfficialReleases(): Promise<void> {
  officialReleasesBusy.value = true;
  officialReleasesError.value = null;

  try {
    const result = await api.system.releases.query();
    officialRepositoryUrl.value = result.repositoryUrl;
    officialReleases.value = result.releases;

    if (!selectedReleaseTag.value || !result.releases.some((release) => release.tagName === selectedReleaseTag.value)) {
      selectedReleaseTag.value =
        result.releases.find((release) => !release.isPrerelease)?.tagName ??
        result.releases[0]?.tagName ??
        null;
    }
  } catch (err) {
    officialReleasesError.value = describeError(err);
  } finally {
    officialReleasesBusy.value = false;
  }
}

async function refreshGameServers(): Promise<void> {
  try {
    gameServers.value = await api.gameServers.settings.query();
  } catch {
    // The rest of Settings remains useful if this optional capability check fails.
  }
}

async function setGameServersEnabled(enabled: boolean): Promise<void> {
  gameServersBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.gameServers.setEnabled.mutate({ enabled });
    await refreshGameServers();
    notice.value = enabled
      ? 'Game servers are enabled. Install the required tools below before creating one.'
      : 'Game servers are disabled. Existing server files were left untouched.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    gameServersBusy.value = false;
  }
}

async function installGameComponent(componentId: 'steamcmd' | 'java'): Promise<void> {
  gameServersBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.components.install.mutate({ componentId });
    gameServersJob.watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    gameServersBusy.value = false;
  }
}

async function saveSteamCredentials(): Promise<void> {
  if (!steamUsername.value.trim() || !steamPassword.value) return;
  steamCredentialsBusy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.gameServers.setSteamCredentials.mutate({
      username: steamUsername.value.trim(),
      password: steamPassword.value,
    });
    steamPassword.value = '';
    await refreshGameServers();
    notice.value = 'Steam credentials saved encrypted on this server.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    steamCredentialsBusy.value = false;
  }
}

async function clearSteamCredentials(): Promise<void> {
  steamCredentialsBusy.value = true;
  try {
    await api.gameServers.clearSteamCredentials.mutate();
    steamUsername.value = '';
    steamPassword.value = '';
    await refreshGameServers();
    notice.value = 'Steam credentials removed.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    steamCredentialsBusy.value = false;
  }
}

/*
 * A Web API key is not a sign-in. It only lets the agent ask Steam what is on
 * a game's Workshop, which is what turns the Workshop tab from "paste a link"
 * into something you can browse.
 */
async function saveSteamWebApiKey(): Promise<void> {
  if (!steamWebApiKey.value.trim()) return;
  steamWebApiKeyBusy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.gameServers.setSteamWebApiKey.mutate({ key: steamWebApiKey.value.trim() });
    steamWebApiKey.value = '';
    await refreshGameServers();
    notice.value = 'Steam Web API key saved. Workshop browsing is now available on game servers.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    steamWebApiKeyBusy.value = false;
  }
}

async function clearSteamWebApiKey(): Promise<void> {
  steamWebApiKeyBusy.value = true;
  try {
    await api.gameServers.clearSteamWebApiKey.mutate();
    steamWebApiKey.value = '';
    await refreshGameServers();
    notice.value = 'Steam Web API key removed. Workshop items can still be added by link.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    steamWebApiKeyBusy.value = false;
  }
}

void refresh();

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
  dead: 'bg-danger',
};

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  unknown: 'Unknown',
  dead: 'Not answering',
};

/**
 * The one state the service word cannot express: Windows says running, but
 * nothing answers on the port, so the site behind it is down. Shown as its
 * own label rather than folded into Running, which is the lie that hid it.
 */
function displayState(service: BackgroundServices[number]): string {
  return service.state === 'running' && service.responding === false ? 'dead' : service.state;
}

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
  const officialInstaller =
    updateSource.value === 'official' ? selectedRelease.value?.installer : null;
  if (updateSource.value === 'official' && !officialInstaller) return;

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

    const source =
      updateSource.value === 'official'
        ? { url: officialInstaller!.url }
        : updateSource.value === 'url'
          ? { url: updateUrl.value.trim() }
          : { filePath: serverPath };
    const checksum =
      updateSource.value === 'official'
        ? officialInstaller!.sha256
        : updateChecksum.value.trim() || null;

    const result = await api.system.update.mutate(
      {
        ...source,
        ...(checksum ? { sha256: checksum } : {}),
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
  <div class="mx-auto w-full max-w-5xl">
    <PageHeader
      title="Settings"
      description="Services this panel drives on your behalf, and the facts about this machine
                   you occasionally need to look up."
    />

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <ComponentsPanel class="mb-4" @changed="refresh" />

    <section class="card mb-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
                 bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Gamepad2 :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold text-ink">Game servers</h2>
              <p class="mt-1 text-sm text-ink-muted">
                Turn on game-server hosting for this machine and prepare the tools used by the
                supported providers.
              </p>
            </div>

            <label class="inline-flex items-center gap-2 text-sm text-ink-muted">
              <span>Enabled</span>
              <input
                type="checkbox"
                :checked="gameServers?.enabled ?? false"
                :disabled="gameServersBusy || !gameServers"
                @change="setGameServersEnabled(($event.target as HTMLInputElement).checked)"
              />
            </label>
          </div>

          <div v-if="gameServers" class="mt-5 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-line bg-black/20 p-3">
              <p class="text-xs uppercase tracking-wide text-ink-faint">SteamCMD</p>
              <p class="mt-1 text-sm" :class="gameServers.steamcmdInstalled ? 'text-ok' : 'text-warn'">
                {{ gameServers.steamcmdInstalled ? 'Installed' : 'Not installed' }}
              </p>
              <button
                v-if="!gameServers.steamcmdInstalled"
                type="button"
                class="btn btn-primary btn-sm mt-3"
                :disabled="gameServersBusy || !gameServers.enabled"
                @click="installGameComponent('steamcmd')"
              >
                Install SteamCMD
              </button>
              <p v-else class="mt-2 text-xs text-ink-faint">
                {{ gameServers.steamCredentialsConfigured ? 'Authenticated Steam account configured.' : 'Anonymous downloads only.' }}
              </p>
              <form v-if="gameServers.steamcmdInstalled" class="mt-3 space-y-2 border-t border-line pt-3" @submit.prevent="saveSteamCredentials">
                <label class="label" for="steam-username">Steam account</label>
                <input id="steam-username" v-model="steamUsername" class="field" autocomplete="off" placeholder="Username" />
                <input v-model="steamPassword" class="field" type="password" autocomplete="new-password" placeholder="Password" />
                <div class="flex flex-wrap gap-2">
                  <button type="submit" class="btn btn-primary btn-sm" :disabled="steamCredentialsBusy || !steamUsername.trim() || !steamPassword">Save encrypted credentials</button>
                  <button v-if="gameServers.steamCredentialsConfigured" type="button" class="btn btn-ghost btn-sm" :disabled="steamCredentialsBusy" @click="clearSteamCredentials">Clear</button>
                </div>
                <p class="text-xs text-ink-faint">Steam Guard may still require an interactive login outside this panel for accounts that request it.</p>
              </form>
            </div>

            <div class="rounded-lg border border-line bg-black/20 p-3">
              <p class="text-xs uppercase tracking-wide text-ink-faint">Minecraft Java</p>
              <p class="mt-1 text-sm" :class="gameServers.javaInstalled ? 'text-ok' : 'text-warn'">
                {{ gameServers.javaInstalled ? gameServers.javaVersion : 'Java was not found' }}
              </p>
              <button
                v-if="!gameServers.javaInstalled"
                type="button"
                class="btn btn-primary btn-sm mt-3"
                :disabled="gameServersBusy || !gameServers.enabled"
                @click="installGameComponent('java')"
              >
                Install Java runtime
              </button>
            </div>

            <div class="rounded-lg border border-line bg-black/20 p-3 sm:col-span-2">
              <p class="text-xs uppercase tracking-wide text-ink-faint">Steam Workshop browsing</p>
              <p class="mt-1 text-sm" :class="gameServers.steamWebApiKeyConfigured ? 'text-ok' : 'text-ink-muted'">
                {{ gameServers.steamWebApiKeyConfigured ? 'Customers can search the Workshop in the panel.' : 'Workshop items can be added by link only.' }}
              </p>
              <form class="mt-3 space-y-2" @submit.prevent="saveSteamWebApiKey">
                <label class="label" for="steam-web-api-key">Steam Web API key</label>
                <input
                  id="steam-web-api-key"
                  v-model="steamWebApiKey"
                  class="field font-mono text-xs"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="32 hexadecimal characters"
                />
                <div class="flex flex-wrap gap-2">
                  <button type="submit" class="btn btn-primary btn-sm" :disabled="steamWebApiKeyBusy || !steamWebApiKey.trim()">Save key</button>
                  <button v-if="gameServers.steamWebApiKeyConfigured" type="button" class="btn btn-ghost btn-sm" :disabled="steamWebApiKeyBusy" @click="clearSteamWebApiKey">Clear</button>
                  <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">Get a key from Valve</a>
                </div>
                <p class="text-xs text-ink-faint">
                  Optional, and separate from the account above: a Web API key reads public Workshop
                  listings and cannot sign in, buy, or change anything. Without one the Workshop tab
                  still works, but customers have to paste a link from Steam instead of searching here.
                </p>
              </form>
            </div>
          </div>

          <HowTo title="Before creating a game server" class="mt-4">
            <li>Enable Game servers here. Existing server files are not changed by this switch.</li>
            <li>
              Install SteamCMD for Steam providers. Valve's bootstrapper updates itself from its
              official download when it first runs.
            </li>
            <li>
              Install the Java runtime from this page for Minecraft Java Edition. Bedrock uses
              its own Windows server and does not need Java.
            </li>
            <li>
              Make sure the game publisher's dedicated-server terms and EULA are accepted before
              installation.
            </li>
          </HowTo>

          <pre
            v-if="gameServersJob.lines.value.length > 0"
            class="mt-4 max-h-48 overflow-y-auto rounded-lg border border-line bg-black/25 p-3
                   font-mono text-xs leading-relaxed"
          ><span
            v-for="line in gameServersJob.lines.value"
            :key="line.seq"
            class="block"
            :class="LOG_LEVEL_CLASS[line.level] ?? 'text-ink'"
          >{{ line.message }}</span></pre>
        </div>
      </div>
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

    <section v-if="isOwner" class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-brand-soft/50 text-brand-bright"
          aria-hidden="true"
        >
          <Mail :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Panel email</h2>
          <p class="mt-1 text-sm text-ink-muted">
            Used for website outage alerts, password recovery, and messages from the panel.
            Only the owner can change these settings.
          </p>
        </div>
      </div>

      <form class="mt-5 space-y-4" @submit.prevent="savePanelEmail">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Email delivery">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="panelEmailMode === 'local' ? 'text-ink' : ''"
            :aria-pressed="panelEmailMode === 'local'"
            @click="panelEmailMode = 'local'"
          >
            From this server
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="panelEmailMode === 'external' ? 'text-ink' : ''"
            :aria-pressed="panelEmailMode === 'external'"
            @click="panelEmailMode = 'external'"
          >
            External SMTP
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="panelEmailMode === 'new' ? 'text-ink' : ''"
            :aria-pressed="panelEmailMode === 'new'"
            @click="panelEmailMode = 'new'"
          >
            Create New
          </button>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="panelEmailMode === 'local'">
            <label for="panel-email-address" class="label">Existing mailbox</label>
            <SearchableSelect
              v-if="panelEmailLocalAddresses.length > 0"
              v-model="panelEmailAddress"
              id="panel-email-address"
              :options="panelEmailLocalAddresses"
              placeholder="Choose an existing mailbox"
              label="Existing mailbox"
            />
            <input
              v-else
              id="panel-email-address"
              v-model="panelEmailAddress"
              class="field"
              type="email"
              autocomplete="off"
              spellcheck="false"
              placeholder="mailbox@example.com"
              required
            />
            <p v-if="panelEmailLocalAddresses.length > 0" class="hint">
              Choose any mailbox or alias on this server. The list can be filtered by typing.
            </p>
            <p v-else class="hint">
              No existing mailboxes were found. Use Create New to make a dedicated sender.
            </p>
          </div>
          <div v-else>
            <label for="panel-email-address" class="label">
              {{ panelEmailMode === 'new' ? 'New mailbox address' : 'Sender address' }}
            </label>
            <input
              id="panel-email-address"
              v-model="panelEmailAddress"
              class="field"
              type="email"
              autocomplete="off"
              spellcheck="false"
              :placeholder="panelEmailMode === 'new' ? 'noreply@example.com' : 'you@example.com'"
              required
            />
          </div>
          <div>
            <label for="panel-email-name" class="label">Sender name</label>
            <input
              id="panel-email-name"
              v-model="panelEmailName"
              class="field"
              type="text"
              autocomplete="organization"
              placeholder="WinPanel"
            />
          </div>
        </div>

        <div v-if="panelEmailMode === 'local'" class="space-y-1">
          <label for="panel-email-local-password" class="label">Mailbox password</label>
          <input
            id="panel-email-local-password"
            v-model="panelEmailLocalPassword"
            class="field"
            type="password"
            autocomplete="current-password"
            :placeholder="localPasswordIsOptional() ? 'Unchanged' : 'Password for this mailbox'"
            :required="!localPasswordIsOptional()"
          />
          <p class="hint">
            Enter the selected mailbox's password. It is stored encrypted on this server and is
            not sent to the browser after saving. Leave it blank to keep the current sender's
            password.
          </p>
        </div>

        <div v-if="panelEmailMode === 'new'" class="hint">
          WinPanel creates this as a send-only mailbox and keeps its generated password encrypted.
          Use From this server to select a mailbox that already exists.
        </div>

        <div v-else-if="panelEmailMode === 'local'" class="hint">
          The selected mailbox must belong to a domain configured in the local mail server. Its
          aliases can also be used as the sender address.
        </div>

        <div v-else class="space-y-3 rounded-lg border border-line bg-black/20 p-4">
          <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div>
              <label for="panel-smtp-host" class="label">SMTP host</label>
              <input
                id="panel-smtp-host"
                v-model="panelEmailSmtpHost"
                class="field"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="smtp.example.com"
                required
              />
            </div>
            <div>
              <label for="panel-smtp-port" class="label">Port</label>
              <input
                id="panel-smtp-port"
                v-model="panelEmailSmtpPort"
                class="field"
                type="number"
                min="1"
                max="65535"
                inputmode="numeric"
                required
              />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label for="panel-smtp-security" class="label">Connection security</label>
              <select id="panel-smtp-security" v-model="panelEmailSmtpSecurity" class="field">
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS from the start</option>
                <option value="none">None</option>
              </select>
            </div>
            <div>
              <label for="panel-smtp-username" class="label">Username</label>
              <input
                id="panel-smtp-username"
                v-model="panelEmailSmtpUsername"
                class="field"
                type="text"
                autocomplete="off"
                placeholder="Optional"
              />
            </div>
          </div>

          <div>
            <label for="panel-smtp-password" class="label">Password</label>
            <input
              id="panel-smtp-password"
              v-model="panelEmailSmtpPassword"
              class="field"
              type="password"
              autocomplete="new-password"
              :placeholder="panelEmail?.smtpPasswordConfigured ? 'Unchanged' : 'Optional'"
            />
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-primary" :disabled="panelEmailSaving">
            {{ panelEmailSaving ? 'Saving...' : 'Save sender settings' }}
          </button>
        </div>
      </form>

      <div class="mt-5 border-t border-line pt-4">
        <label for="panel-email-test-recipient" class="label">Test recipient</label>
        <div class="mt-1 flex flex-wrap gap-2">
          <input
            id="panel-email-test-recipient"
            v-model="panelEmailTestRecipient"
            class="field min-w-56 flex-1"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="panelEmailTesting || panelEmailSaving || !panelEmailTestRecipient.trim()"
            @click="testPanelEmail"
          >
            {{ panelEmailTesting ? 'Sending...' : 'Send test email' }}
          </button>
        </div>
      </div>
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

    <!--
      The panel's own certificate. Deliberately its own section, and worded so
      it cannot be mistaken for the websites' certificates: those live on each
      website's SSL tab and nothing here touches them.
    -->
    <section v-if="panelCertificate?.httpsEnabled" class="card mt-4 p-6">
      <div class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                 border-line bg-elevated text-ink-muted"
          aria-hidden="true"
        >
          <Lock :size="19" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Panel address and certificate</h2>
          <p class="mt-1 text-sm text-ink-muted">
            The address you sign in at, and the certificate this page is served with. Your
            websites keep their own certificates &mdash; nothing here changes them.
          </p>
        </div>
      </div>

      <div class="mt-5 rounded-lg border border-line bg-black/20 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p class="text-sm font-medium text-ink">
            {{
              panelCertificate.source === 'issued'
                ? 'Signed by ' + (panelCertificate.issuer ?? 'a certificate authority')
                : 'Signed by this panel itself'
            }}
          </p>
          <p class="font-mono text-xs text-ink-faint">
            {{
              panelCertificate.expiresAt
                ? 'Expires ' + new Date(panelCertificate.expiresAt).toLocaleDateString()
                : ''
            }}
          </p>
        </div>

        <p class="mt-1 text-sm text-ink-muted">
          {{
            panelCertificate.source === 'issued'
              ? 'Browsers trust it, so this page loads without a warning.'
              : 'A certificate authority will not issue one for a bare IP address, so until the panel has a domain name of its own, browsers show a warning here. Your connection is still encrypted.'
          }}
        </p>

        <p
          v-if="panelCertificate.source === 'self-signed' && panelCertificate.fingerprint"
          class="mt-3 break-all font-mono text-xs text-ink-faint"
        >
          Fingerprint {{ panelCertificate.fingerprint }}
        </p>
      </div>

      <form class="mt-5 space-y-4" @submit.prevent="savePanelHostname">
        <div>
          <label for="panel-hostname" class="label">Panel domain</label>
          <div class="mt-1 flex flex-wrap gap-2">
            <input
              id="panel-hostname"
              v-model="panelHostname"
              class="field min-w-56 flex-1"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="panel.example.com"
            />
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="panelHostnameBusy || panelHostname.trim() === (panelCertificate.hostname ?? '')"
            >
              {{ panelHostnameBusy ? 'Saving\u2026' : 'Save' }}
            </button>
            <button
              v-if="panelCertificate.hostname"
              type="button"
              class="btn btn-ghost"
              :disabled="panelHostnameBusy"
              @click="removePanelHostname"
            >
              Remove
            </button>
          </div>
          <p class="mt-1.5 text-xs text-ink-faint">
            A subdomain such as <span class="font-mono">panel.example.com</span>, or a root
            domain such as <span class="font-mono">example.com</span> if you have one spare
            &mdash; whichever you prefer. The only rule is that no website on this server
            serves it. Leave it empty to go back to signing in by IP address.
          </p>
        </div>
      </form>

      <AlertMessage
        v-if="panelCertificate.hostname && panelCertificate.dnsPointsHere === false"
        tone="warning"
        class="mt-4"
      >
        {{ panelCertificate.hostname }} answers with an address that is not this server, so no
        certificate can be issued for it. On Cloudflare, that usually means the orange cloud is
        on &mdash; turn it off for this record. If you have only just changed it, this
        server&rsquo;s own lookups may show the old answer for a while yet.
      </AlertMessage>

      <AlertMessage
        v-else-if="panelCertificate.hostname && panelCertificate.dnsPointsHere === null"
        tone="warning"
        class="mt-4"
      >
        Nothing answers for {{ panelCertificate.hostname }} yet, so no certificate can be issued
        for it. Add an <strong>A</strong> record for it pointing at
        <strong class="font-mono">{{ panelCertificate.suggestedIpv4 ?? 'this server' }}</strong
        >.
      </AlertMessage>

      <AlertMessage v-else-if="awaitingPanelCertificate" tone="info" class="mt-4">
        Getting a certificate for {{ panelCertificate.hostname }}. This usually takes under a
        minute; you can leave this page.
      </AlertMessage>

      <AlertMessage
        v-else-if="panelCertificate.url && panelCertificate.source === 'issued'"
        tone="success"
        class="mt-4"
      >
        Sign in at
        <a :href="panelCertificate.url" class="font-mono">{{ panelCertificate.url }}</a>
        from now on. The IP address still works, with the warning.
      </AlertMessage>

      <HowTo v-if="!panelCertificate.hostname" title="Giving the panel its own name" class="mt-4">
        <li>
          Pick a name no website on this server serves. A subdomain such as
          <strong>panel.example.com</strong> is the usual choice, but a root domain such as
          <strong>example.com</strong> works just as well if you are not hosting a website on
          it.
        </li>
        <li>
          At your DNS provider, add an <strong>A</strong> record for it pointing at
          <strong class="font-mono">{{ panelCertificate.suggestedIpv4 ?? 'this server' }}</strong
          >. On Cloudflare, turn the orange cloud <strong>off</strong> &mdash; the panel is not
          on port 443, so the proxy cannot reach it.
        </li>
        <li>Put the name in the box above and save. The certificate arrives on its own.</li>
      </HowTo>
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
          :class="updateSource === 'official' ? 'text-ink' : ''"
          :aria-pressed="updateSource === 'official'"
          @click="updateSource = 'official'"
        >
          <Github :size="15" aria-hidden="true" /> Official releases
        </button>
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
          From a URL
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :class="updateSource === 'file' ? 'text-ink' : ''"
          :aria-pressed="updateSource === 'file'"
          @click="updateSource = 'file'"
        >
          From this server
        </button>
      </div>

      <form class="mt-4 space-y-3" @submit.prevent="installUpdate">
        <div v-if="updateSource === 'official'" class="space-y-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <label class="label">Official WinPanel releases</label>
              <p class="hint">
                Choose a published release from
                <a
                  :href="officialRepositoryUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-brand-bright hover:underline"
                  >GitHub</a
                >. The setup file downloads directly to this server.
              </p>
            </div>
            <Tooltip text="Refresh official releases">
              <button
                type="button"
                class="btn btn-ghost btn-sm shrink-0"
                :disabled="officialReleasesBusy"
                aria-label="Refresh official releases"
                @click="refreshOfficialReleases"
              >
                <RefreshCw :size="15" :class="officialReleasesBusy ? 'animate-spin' : ''" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          <div
            v-if="officialReleasesBusy && officialReleases.length === 0"
            class="rounded-card border border-line bg-elevated/30 p-4 text-sm text-ink-muted"
          >
            Checking GitHub for published releases...
          </div>
          <AlertMessage v-else-if="officialReleasesError" tone="warning">
            {{ officialReleasesError }}
          </AlertMessage>
          <div
            v-else-if="officialReleases.length === 0"
            class="rounded-card border border-line bg-elevated/30 p-4 text-sm text-ink-muted"
          >
            No published WinPanel releases were found.
          </div>
          <div v-else class="max-h-72 space-y-2 overflow-y-auto pr-1">
            <button
              v-for="release in officialReleases"
              :key="release.tagName"
              type="button"
              class="flex w-full min-w-0 items-center gap-3 rounded-card border px-3 py-2 text-left transition-colors"
              :class="
                selectedReleaseTag === release.tagName
                  ? 'border-brand bg-brand-soft/40'
                  : 'border-line bg-elevated/30 hover:border-brand/60'
              "
              :aria-pressed="selectedReleaseTag === release.tagName"
              @click="selectedReleaseTag = release.tagName"
            >
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-sm font-semibold text-ink">{{ release.tagName }}</span>
                  <span
                    v-if="isLatestRelease(release)"
                    class="rounded-full bg-brand-soft/70 px-2 py-0.5 text-[0.65rem] font-medium text-brand-bright"
                    >Latest</span
                  >
                  <span
                    v-if="isCurrentRelease(release)"
                    class="rounded-full bg-elevated px-2 py-0.5 text-[0.65rem] font-medium text-ink-muted"
                    >This server</span
                  >
                  <span
                    v-if="release.isPrerelease"
                    class="rounded-full bg-elevated px-2 py-0.5 text-[0.65rem] font-medium text-ink-muted"
                    >Pre-release</span
                  >
                </span>
                <span class="truncate text-sm text-ink-muted">{{ release.name }}</span>
              </span>
              <span class="shrink-0 text-right text-xs text-ink-faint">
                {{ formatReleaseDate(release.publishedAt) }}
              </span>
            </button>
          </div>

          <AlertMessage v-if="latestRelease && releaseStatus === 'current'" tone="success">
            This server is running the latest stable release, {{ latestRelease.tagName }}.
          </AlertMessage>
          <AlertMessage v-else-if="latestRelease && releaseStatus === 'available'" tone="info">
            Update available: {{ latestRelease.tagName }} is newer than this server's
            {{ info?.version }}.
          </AlertMessage>
          <AlertMessage v-else-if="latestRelease && releaseStatus === 'ahead'" tone="info">
            This server is newer than the latest published release, {{ latestRelease.tagName }}.
          </AlertMessage>

          <div v-if="selectedRelease" class="border-t border-line pt-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-semibold text-ink">{{ selectedRelease.name }}</p>
                <p class="mt-1 text-xs text-ink-faint">
                  {{ selectedRelease.tagName }} · Published {{ formatReleaseDate(selectedRelease.publishedAt) }}
                </p>
              </div>
              <a
                :href="selectedRelease.htmlUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex shrink-0 items-center gap-1 text-sm text-brand-bright hover:underline"
              >
                View release <ExternalLink :size="13" aria-hidden="true" />
              </a>
            </div>
            <p v-if="selectedRelease.installer" class="hint mt-2">
              <span class="font-mono">WinPanel-Setup-x64.exe</span>
              <span v-if="selectedRelease.installer.sizeBytes">
                · {{ describeSize(selectedRelease.installer.sizeBytes) }}
              </span>
              <span v-if="selectedRelease.installer.sha256"> · SHA-256 verified by GitHub</span>
            </p>
            <p v-else class="hint mt-2">
              This release does not include the Windows x64 setup program.
            </p>
          </div>
        </div>

        <div v-else-if="updateSource === 'upload'">
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

        <div v-if="updateSource !== 'official'">
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
        class="mt-4 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-card
               bg-black/25 p-4 font-mono text-xs leading-relaxed"
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
          <span class="h-1.5 w-1.5 rounded-full" :class="STATE_DOT[displayState(service)]" aria-hidden="true" />

          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">{{ service.label }}</span>
            <span class="block truncate font-mono text-xs text-ink-faint">{{ service.id }}</span>
            <span
              v-if="displayState(service) === 'dead'"
              class="block truncate text-xs text-danger"
            >
              Windows reports it running, but nothing answers on its port. Restart it to
              bring it back.
            </span>
          </span>

          <span
            class="w-20 text-right text-xs"
            :class="
              displayState(service) === 'running'
                ? 'text-ok'
                : displayState(service) === 'dead'
                  ? 'text-danger'
                  : 'text-ink-faint'
            "
          >
            {{ serviceBusyId === service.id ? 'Working\u2026' : STATE_LABEL[displayState(service)] }}
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
