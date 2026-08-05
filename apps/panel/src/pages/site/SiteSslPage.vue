<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { CLOUDFLARE_SSL_PERMISSION_ROW } from '@winpanel/shared';
import { api, describeError } from '../../lib/api';
import { siteContextKey } from '../../lib/site-context';
import AlertMessage from '../../components/AlertMessage.vue';
import HowTo from '../../components/HowTo.vue';
import StatusBadge from '../../components/StatusBadge.vue';

/**
 * HTTPS for one website.
 *
 * A visitor's connection is encrypted twice over when Cloudflare sits in
 * front: browser to Cloudflare, then Cloudflare to this server. Only the
 * second leg is ours, and it is the one that quietly goes wrong — a padlock in
 * the browser says nothing about it. Keeping both on one page is the whole
 * point: split across two screens, this is exactly how a site ends up looking
 * secure while half the journey is in the clear.
 *
 * The token is the website's existing Cloudflare token rather than a second
 * one. One account owns the domain, so one token can do both jobs; it just
 * needs a permission that tokens made before this page existed do not carry,
 * which is asked for only when it turns out to be missing.
 */

const { site } = inject(siteContextKey)!;
const route = useRoute();

type Status = Awaited<ReturnType<typeof api.ssl.status.query>>;
type SslMode = NonNullable<NonNullable<Status['cloudflare']['settings']>['sslMode']>;
type TlsVersion = NonNullable<NonNullable<Status['cloudflare']['settings']>['minTlsVersion']>;

const slug = computed(() => route.params['slug'] as string);

const status = ref<Status | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const token = ref('');
const tokenBusy = ref(false);

const settings = computed(() => status.value?.cloudflare.settings ?? null);
const blocked = computed(() => status.value?.cloudflare.blocked ?? null);

/**
 * Cloudflare's encryption modes, in the order its own dashboard lists them.
 *
 * Described by what they do to the traffic rather than by their names:
 * "Full" and "Full (strict)" are indistinguishable to anyone who has not read
 * the documentation, and the difference between them is whether the second leg
 * of the connection is verified at all.
 */
const SSL_MODES = [
  {
    value: 'off',
    label: 'Off',
    detail: 'No HTTPS at all. Visitors are sent to the plain, unencrypted version.',
  },
  {
    value: 'flexible',
    label: 'Flexible',
    detail:
      'Encrypted as far as Cloudflare, then plain HTTP to this server. The padlock covers ' +
      'only half the journey.',
  },
  {
    value: 'full',
    label: 'Full',
    detail:
      'Encrypted the whole way, but this server\u2019s certificate is not checked, so the ' +
      'second leg can be impersonated.',
  },
  {
    value: 'strict',
    label: 'Full (strict)',
    detail:
      'Encrypted and verified the whole way. This server holds a real certificate, so ' +
      'requiring one costs nothing.',
  },
] as const;

const TLS_VERSIONS = ['1.0', '1.1', '1.2', '1.3'] as const;

const CERT_LABEL = {
  valid: 'Secured',
  expiring: 'Renewing soon',
  expired: 'Expired',
  absent: 'No certificate yet',
} as const;

const CERT_STATE = {
  valid: 'ok',
  expiring: 'warning',
  expired: 'blocked',
  absent: 'absent',
} as const;

/** Anything short of strict leaves part of the connection unprotected. */
const weakMode = computed(() => {
  const mode = settings.value?.sslMode;
  return mode != null && mode !== 'strict';
});

const missingCertificate = computed(() =>
  (status.value?.certificates ?? []).some((entry) => entry.state !== 'valid'),
);

function formatExpiry(value: Date | null): string {
  return value ? new Date(value).toLocaleDateString() : '\u2014';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    status.value = await api.ssl.status.query({ slug: slug.value });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

interface SettingChange {
  sslMode?: SslMode;
  alwaysUseHttps?: boolean;
  automaticHttpsRewrites?: boolean;
  minTlsVersion?: TlsVersion;
  tls13?: boolean;
}

/** Every control writes immediately; a Save button here would only add a step. */
async function save(change: SettingChange): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.ssl.updateSettings.mutate({ slug: slug.value, ...change });
    if (status.value) status.value.cloudflare.settings = result.settings;
    notice.value = 'Cloudflare has been updated. It reaches visitors within a minute or two.';
  } catch (err) {
    error.value = describeError(err);
    // The control is now showing whatever was clicked, which is no longer
    // true. Re-reading is the only honest way back.
    await load();
  } finally {
    busy.value = false;
  }
}

async function requestCertificates(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.ssl.requestCertificates.mutate({ slug: slug.value });
    notice.value = result.note;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function connectToken(): Promise<void> {
  tokenBusy.value = true;
  error.value = null;
  notice.value = null;

  try {
    await api.dns.connect.mutate({ slug: slug.value, token: token.value.trim() });
    token.value = '';
    notice.value = 'Token saved for this website.';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    tokenBusy.value = false;
  }
}

watch(slug, load, { immediate: true });
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="h-40 animate-pulse rounded-card bg-surface" />

    <template v-else>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <!-- Half one: the certificate this server holds. -->
      <section class="card overflow-hidden">
        <div
          class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3"
        >
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-ink">Certificate on this server</h3>
            <p class="mt-0.5 text-xs text-ink-faint">
              Obtained and renewed automatically, for as long as the domain points here.
            </p>
          </div>

          <div class="flex items-center gap-2">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="load">
              Refresh
            </button>
            <button
              v-if="missingCertificate && status && status.domains.length > 0"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="busy"
              @click="requestCertificates"
            >
              <RefreshCw v-if="busy" :size="14" class="animate-spin" aria-hidden="true" />
              Request now
            </button>
          </div>
        </div>

        <AlertMessage v-if="status && !status.webServerRunning" tone="warning" class="m-5">
          The web server is not running, so nothing can be issued or renewed.
          <RouterLink to="/health">Check the server</RouterLink>.
        </AlertMessage>

        <div v-if="status && status.domains.length === 0" class="px-5 py-6 text-sm text-ink-muted">
          <p>
            This website has no domain yet, and a certificate can only be issued for a name.
            <RouterLink :to="`/sites/${slug}/settings`" class="text-brand-bright hover:underline">
              Add one on its Settings tab</RouterLink
            >, then point it here from the
            <RouterLink :to="`/sites/${slug}/dns`" class="text-brand-bright hover:underline">
              DNS tab</RouterLink
            >.
          </p>
          <p v-if="site?.previewUrl" class="mt-2 text-ink-faint">
            The preview address stays plain HTTP on purpose &mdash; it is reached by IP address,
            and there is no name to put on a certificate.
          </p>
        </div>

        <table v-else class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th class="px-5 py-2 font-medium">Domain</th>
              <th class="px-5 py-2 font-medium">State</th>
              <th class="hidden px-5 py-2 font-medium sm:table-cell">Issued by</th>
              <th class="px-5 py-2 font-medium">Valid until</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line">
            <tr v-for="entry in status?.certificates ?? []" :key="entry.domain">
              <td class="px-5 py-2.5 font-mono text-ink">
                {{ entry.domain }}
                <span v-if="entry.wildcard" class="ml-1 text-xs text-ink-faint">via wildcard</span>
              </td>
              <td class="px-5 py-2.5">
                <StatusBadge
                  :state="CERT_STATE[entry.state]"
                  :label="CERT_LABEL[entry.state]"
                  size="sm"
                />
              </td>
              <td class="hidden px-5 py-2.5 text-ink-muted sm:table-cell">
                {{ entry.issuer ?? '\u2014' }}
              </td>
              <td class="px-5 py-2.5 text-ink-muted">
                {{ formatExpiry(entry.expiresAt) }}
                <span v-if="entry.daysRemaining !== null" class="text-xs text-ink-faint">
                  ({{ entry.daysRemaining }} days)
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Half two: what Cloudflare does in front of it. -->
      <section v-if="blocked === 'no-token' || blocked === 'no-permission'" class="card p-5">
        <div class="flex items-start gap-3">
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border
                   border-line bg-brand-soft/50 text-brand-bright"
            aria-hidden="true"
          >
            <ShieldCheck :size="19" />
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="text-base font-semibold text-ink">
              {{
                blocked === 'no-token'
                  ? 'Connect Cloudflare to manage its SSL settings'
                  : 'This token cannot change SSL settings'
              }}
            </h3>
            <p class="mt-1 text-sm text-ink-muted">
              <template v-if="blocked === 'no-token'">
                The certificate on this server is handled already. Cloudflare&rsquo;s own settings
                &mdash; the encryption mode, forcing HTTPS &mdash; need a token for the account
                the domain lives in: the same token the
                <RouterLink :to="`/sites/${slug}/dns`" class="text-brand-bright hover:underline">
                  DNS tab</RouterLink
                >
                uses.
              </template>
              <template v-else>
                This website&rsquo;s Cloudflare token manages DNS perfectly well, but it was not
                given permission to read or change SSL settings. Add the row below to it in
                Cloudflare &mdash; an existing token can be edited without changing its value
                &mdash; or paste a new one here.
              </template>
            </p>
          </div>
        </div>

        <HowTo title="Giving the token permission" class="mt-5">
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
            in the account that holds
            <strong>{{ status?.domains[0] ?? 'this domain' }}</strong
            >, and edit the token for it &mdash; or create a new one.
          </li>
          <li>
            Under Permissions add this row, using all three dropdowns:
            <code class="ml-1 rounded bg-sunken px-1.5 py-0.5 text-ink">
              {{ CLOUDFLARE_SSL_PERMISSION_ROW.group }} &rarr;
              {{ CLOUDFLARE_SSL_PERMISSION_ROW.resource }} &rarr;
              {{ CLOUDFLARE_SSL_PERMISSION_ROW.level }}
            </code>
          </li>
          <li>
            Save it. Editing a token leaves its value alone, so if you only added the permission
            there is nothing to paste &mdash; press Refresh above.
          </li>
        </HowTo>

        <form class="mt-4 space-y-3" @submit.prevent="connectToken">
          <div>
            <label for="ssl-token" class="label">API token</label>
            <input
              id="ssl-token"
              v-model="token"
              type="password"
              autocomplete="off"
              class="field font-mono"
              placeholder="Only needed if you created a new token"
            />
            <p class="hint">
              This becomes the token used for both DNS and SSL on this website. It is kept
              encrypted on this server and never sent to the browser.
            </p>
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="tokenBusy || token.trim().length < 10"
          >
            {{ tokenBusy ? 'Checking\u2026' : 'Save token' }}
          </button>
        </form>
      </section>

      <AlertMessage v-else-if="blocked === 'zone-not-found'" tone="warning">
        <span class="font-mono">{{ status?.domains[0] }}</span> is not in the Cloudflare account
        this website&rsquo;s token belongs to, so its SSL settings cannot be shown. The
        certificate above is unaffected.
      </AlertMessage>

      <template v-else-if="settings">
        <section class="card p-5">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="text-sm font-semibold text-ink">Encryption between Cloudflare and here</h3>
            <span class="text-xs text-ink-faint">
              Domain <span class="font-mono">{{ status?.cloudflare.zone?.name }}</span>
            </span>
          </div>

          <AlertMessage v-if="weakMode" tone="warning" class="mt-3">
            Traffic between Cloudflare and this server is not fully protected. This server holds
            its own certificate, so Full (strict) closes the gap at no cost.
          </AlertMessage>

          <fieldset class="mt-4 space-y-2" :disabled="busy || !settings.editable">
            <legend class="sr-only">Encryption mode</legend>
            <label
              v-for="mode in SSL_MODES"
              :key="mode.value"
              class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
              :class="
                settings.sslMode === mode.value
                  ? 'border-brand/50 bg-brand-soft/25'
                  : 'border-line hover:border-line-strong'
              "
            >
              <input
                type="radio"
                name="ssl-mode"
                class="mt-1"
                :value="mode.value"
                :checked="settings.sslMode === mode.value"
                @change="save({ sslMode: mode.value })"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-ink">
                  {{ mode.label }}
                  <span v-if="mode.value === 'strict'" class="ml-1 text-xs text-ok">
                    Recommended
                  </span>
                </span>
                <span class="block text-xs text-ink-muted">{{ mode.detail }}</span>
              </span>
            </label>
          </fieldset>

          <p v-if="!settings.editable" class="hint">
            Cloudflare will not let this token change these settings. Check the token&rsquo;s
            permissions, or the plan the domain is on.
          </p>
        </section>

        <section class="card divide-y divide-line">
          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-ink">Always use HTTPS</p>
              <p class="text-xs text-ink-muted">
                Sends anyone arriving over plain HTTP to the secure address instead.
              </p>
            </div>
            <label class="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                :checked="settings.alwaysUseHttps === true"
                :disabled="busy || !settings.editable"
                @change="save({ alwaysUseHttps: ($event.target as HTMLInputElement).checked })"
              />
              {{ settings.alwaysUseHttps ? 'On' : 'Off' }}
            </label>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-ink">Rewrite insecure links</p>
              <p class="text-xs text-ink-muted">
                Fixes <code class="text-ink-faint">http://</code> images and scripts inside your
                own pages, which is the usual reason a padlock does not appear.
              </p>
            </div>
            <label class="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                :checked="settings.automaticHttpsRewrites === true"
                :disabled="busy || !settings.editable"
                @change="
                  save({ automaticHttpsRewrites: ($event.target as HTMLInputElement).checked })
                "
              />
              {{ settings.automaticHttpsRewrites ? 'On' : 'Off' }}
            </label>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-ink">Oldest TLS version allowed</p>
              <p class="text-xs text-ink-muted">
                1.2 is the usual answer. Raising it further shuts out old devices as well as old
                attacks.
              </p>
            </div>
            <select
              class="field w-28"
              aria-label="Oldest TLS version allowed"
              :value="settings.minTlsVersion ?? '1.0'"
              :disabled="busy || !settings.editable"
              @change="
                save({ minTlsVersion: ($event.target as HTMLSelectElement).value as TlsVersion })
              "
            >
              <option v-for="version in TLS_VERSIONS" :key="version" :value="version">
                TLS {{ version }}
              </option>
            </select>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="text-sm font-medium text-ink">TLS 1.3</p>
              <p class="text-xs text-ink-muted">
                The newest version, and the quickest to set up a connection. Safe to leave on.
              </p>
            </div>
            <label class="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                :checked="settings.tls13 === true"
                :disabled="busy || !settings.editable"
                @change="save({ tls13: ($event.target as HTMLInputElement).checked })"
              />
              {{ settings.tls13 ? 'On' : 'Off' }}
            </label>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
