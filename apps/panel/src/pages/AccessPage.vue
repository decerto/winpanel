<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  Ban,
  CircleCheck,
  CircleX,
  Laptop,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { ROLE_LABELS } from '@winpanel/shared';
import { describeUserAgent, timeAgo } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationBar from '../components/PaginationBar.vue';

/**
 * Sign-in activity. Owner only.
 *
 * A panel on the open internet is knocked on constantly, and the owner has no
 * way to know that unless the panel says so. This page answers three
 * questions: who is signed in right now, who has been trying, and which
 * addresses are currently shut out — the last one because the address that
 * gets blocked is usually the owner's own office.
 *
 * The server enforces all of this; hiding the page from a non-owner is only
 * so nobody is shown a screen full of failed requests.
 */

type Session = Awaited<ReturnType<typeof api.access.sessions.query>>[number];
type Attempt = Awaited<ReturnType<typeof api.access.attempts.query>>[number];
type Blocked = Awaited<ReturnType<typeof api.access.blockedAddresses.query>>[number];

const PAGE_SIZE = 15;

const summary = ref<Awaited<ReturnType<typeof api.access.summary.query>> | null>(null);
const sessions = ref<Session[]>([]);
const attempts = ref<Attempt[]>([]);
const blocked = ref<Blocked[]>([]);

const loading = ref(true);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const onlyFailures = ref(false);
const page = ref(1);

const visibleAttempts = computed(() =>
  attempts.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

const stats = computed(() => [
  {
    label: 'Signed in now',
    value: String(summary.value?.activeSessions ?? 0),
    icon: Users,
    tone: 'text-ink',
  },
  {
    label: 'Failed attempts, last 24 hours',
    value: String(summary.value?.failuresLastDay ?? 0),
    icon: ShieldAlert,
    tone: (summary.value?.failuresLastDay ?? 0) > 0 ? 'text-warn' : 'text-ink',
  },
  {
    label: 'Addresses trying, last 24 hours',
    value: String(summary.value?.addressesLastDay ?? 0),
    icon: Laptop,
    tone: 'text-ink',
  },
  {
    label: 'Addresses blocked now',
    value: String(summary.value?.blockedAddresses ?? 0),
    icon: Ban,
    tone: (summary.value?.blockedAddresses ?? 0) > 0 ? 'text-danger' : 'text-ink',
  },
]);

async function refresh(): Promise<void> {
  error.value = null;

  try {
    const [summaryResult, sessionResult, attemptResult, blockedResult] = await Promise.all([
      api.access.summary.query(),
      api.access.sessions.query(),
      api.access.attempts.query({ limit: 200, onlyFailures: onlyFailures.value }),
      api.access.blockedAddresses.query(),
    ]);

    summary.value = summaryResult;
    sessions.value = sessionResult;
    attempts.value = attemptResult;
    blocked.value = blockedResult;
    page.value = 1;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

void refresh();

// Attempts arrive while the page is open, and the whole point of looking at it
// is to watch something happen.
const timer = window.setInterval(() => void refresh(), 30_000);
onUnmounted(() => window.clearInterval(timer));

async function run(key: string, action: () => Promise<void>): Promise<void> {
  busy.value = key;
  error.value = null;
  notice.value = null;

  try {
    await action();
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = null;
  }
}

async function endSession(session: Session): Promise<void> {
  const who = session.current
    ? 'End this session? You will be signed out of this browser.'
    : `Sign ${session.username} out of ${describeUserAgent(session.userAgent)}`
      + ` at ${session.ip ?? 'an unknown address'}?`;

  if (!window.confirm(who)) return;

  await run(session.id, async () => {
    await api.access.revokeSession.mutate({ sessionId: session.id });
    if (session.current) window.location.assign('/login');
  });
}

async function endOtherSessions(): Promise<void> {
  if (
    !window.confirm(
      'Sign out every other browser? Anyone using the panel right now will have to sign in '
      + 'again. This one stays signed in.',
    )
  ) {
    return;
  }

  await run('all', async () => {
    const result = await api.access.revokeOtherSessions.mutate();
    notice.value =
      result.revoked === 0
        ? 'There were no other sessions to end.'
        : `Ended ${result.revoked} other session${result.revoked === 1 ? '' : 's'}.`;
  });
}

async function unblock(ip: string): Promise<void> {
  await run(`ban:${ip}`, async () => {
    await api.access.unblockAddress.mutate({ ip });
    notice.value = `${ip} can sign in again. Its failed attempts have been cleared.`;
  });
}

async function toggleFailures(): Promise<void> {
  onlyFailures.value = !onlyFailures.value;
  await refresh();
}

function exactly(value: Date): string {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl">
    <PageHeader
      title="Sign-in activity"
      description="Who is signed in to this panel, who has been trying, and which addresses are
                   shut out. Only the owner of this server can see this page."
    >
      <template #actions>
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="busy !== null"
          @click="refresh"
        >
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </template>
    </PageHeader>

    <AlertMessage v-if="error" class="mb-4">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-4">{{ notice }}</AlertMessage>

    <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div v-for="stat in stats" :key="stat.label" class="card p-4">
        <div class="flex items-center gap-2 text-xs text-ink-faint">
          <component :is="stat.icon" :size="14" aria-hidden="true" />
          {{ stat.label }}
        </div>
        <p class="mt-2 text-2xl font-semibold tabular-nums" :class="stat.tone">
          {{ stat.value }}
        </p>
      </div>
    </div>

    <section class="mb-6">
      <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-ink">Signed in now</h3>
          <p class="mt-1 text-sm text-ink-muted">
            Every browser holding a valid session. Ending one takes effect immediately.
          </p>
        </div>

        <button
          type="button"
          class="btn btn-ghost"
          :disabled="busy !== null || sessions.length < 2"
          @click="endOtherSessions"
        >
          <LogOut :size="15" aria-hidden="true" />
          Sign out everywhere else
        </button>
      </div>

      <div class="card overflow-hidden">
        <p v-if="loading" class="px-5 py-10 text-center text-sm text-ink-muted">Loading&hellip;</p>

        <table v-else class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th scope="col" class="px-5 py-3 font-medium">Account</th>
              <th scope="col" class="px-5 py-3 font-medium">Address</th>
              <th scope="col" class="hidden px-5 py-3 font-medium md:table-cell">Device</th>
              <th scope="col" class="px-5 py-3 font-medium">Signed in</th>
              <th scope="col" class="hidden px-5 py-3 font-medium lg:table-cell">Expires</th>
              <th scope="col" class="w-px px-5 py-3"><span class="sr-only">End session</span></th>
            </tr>
          </thead>

          <tbody class="divide-y divide-line">
            <tr
              v-for="session in sessions"
              :key="session.id"
              class="transition-colors hover:bg-white/[0.03]"
            >
              <td class="whitespace-nowrap px-5 py-3">
                <span class="text-ink">{{ session.username }}</span>
                <span
                  v-if="session.current"
                  class="ml-2 rounded-full bg-brand-soft/70 px-2 py-0.5 text-[0.7rem]
                         font-medium text-brand-bright"
                >
                  This browser
                </span>
                <span class="ml-2 text-xs text-ink-faint">
                  {{ ROLE_LABELS[session.role].label }}
                </span>
              </td>

              <td class="whitespace-nowrap px-5 py-3 font-mono text-xs text-ink-muted">
                {{ session.ip ?? '\u2014' }}
              </td>

              <td
                class="hidden max-w-[16rem] truncate px-5 py-3 text-ink-muted md:table-cell"
                :title="session.userAgent ?? ''"
              >
                {{ describeUserAgent(session.userAgent) }}
              </td>

              <td
                class="whitespace-nowrap px-5 py-3 text-ink-muted"
                :title="exactly(session.createdAt)"
              >
                {{ timeAgo(session.createdAt) }}
              </td>

              <td
                class="hidden whitespace-nowrap px-5 py-3 text-ink-muted lg:table-cell"
                :title="exactly(session.expiresAt)"
              >
                {{ timeAgo(session.expiresAt) }}
              </td>

              <td class="w-px whitespace-nowrap px-5 py-3 text-right">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="busy !== null"
                  @click="endSession(session)"
                >
                  {{ busy === session.id ? 'Ending\u2026' : 'End' }}
                </button>
              </td>
            </tr>

            <tr v-if="sessions.length === 0">
              <td colspan="6" class="px-5 py-10 text-center text-sm text-ink-muted">
                Nothing to show. Your own session should be here, so try Refresh.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="blocked.length > 0" class="mb-6">
      <h3 class="text-base font-semibold text-ink">Blocked addresses</h3>
      <p class="mb-3 mt-1 text-sm text-ink-muted">
        Shut out after too many failed attempts. A whole office usually shares one address, so
        unblock yours if a colleague locked it.
      </p>

      <div class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th scope="col" class="px-5 py-3 font-medium">Address</th>
              <th scope="col" class="px-5 py-3 font-medium">Blocked until</th>
              <th scope="col" class="hidden px-5 py-3 font-medium md:table-cell">Reason</th>
              <th scope="col" class="w-px px-5 py-3"><span class="sr-only">Unblock</span></th>
            </tr>
          </thead>

          <tbody class="divide-y divide-line">
            <tr v-for="ban in blocked" :key="ban.ip" class="transition-colors hover:bg-white/[0.03]">
              <td class="whitespace-nowrap px-5 py-3 font-mono text-xs text-ink">{{ ban.ip }}</td>
              <td class="whitespace-nowrap px-5 py-3 text-ink-muted" :title="exactly(ban.until)">
                {{ timeAgo(ban.until) }}
              </td>
              <td class="hidden px-5 py-3 text-ink-muted md:table-cell">{{ ban.reason }}</td>
              <td class="w-px whitespace-nowrap px-5 py-3 text-right">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="busy !== null"
                  @click="unblock(ban.ip)"
                >
                  {{ busy === `ban:${ban.ip}` ? 'Unblocking\u2026' : 'Unblock' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-ink">Recent attempts</h3>
          <p class="mt-1 text-sm text-ink-muted">
            Successful sign-ins are cleared once you get in, so a long list of failures from one
            address is the thing to look for.
          </p>
        </div>

        <button
          type="button"
          class="btn btn-ghost"
          :aria-pressed="onlyFailures"
          :disabled="busy !== null"
          @click="toggleFailures"
        >
          {{ onlyFailures ? 'Showing failures only' : 'Show failures only' }}
        </button>
      </div>

      <EmptyState
        v-if="!loading && attempts.length === 0"
        :icon="CircleCheck"
        title="Nothing to show"
        :description="
          onlyFailures
            ? 'No failed sign-in attempts have been recorded.'
            : 'No sign-in attempts have been recorded yet.'
        "
      />

      <div v-else class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th scope="col" class="px-5 py-3 font-medium">Result</th>
              <th scope="col" class="px-5 py-3 font-medium">Username tried</th>
              <th scope="col" class="px-5 py-3 font-medium">Address</th>
              <th scope="col" class="px-5 py-3 font-medium">When</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-line">
            <tr
              v-for="attempt in visibleAttempts"
              :key="attempt.id"
              class="transition-colors hover:bg-white/[0.03]"
            >
              <td class="whitespace-nowrap px-5 py-3">
                <span
                  class="inline-flex items-center gap-1.5"
                  :class="attempt.succeeded ? 'text-ok' : 'text-danger'"
                >
                  <component
                    :is="attempt.succeeded ? CircleCheck : CircleX"
                    :size="14"
                    aria-hidden="true"
                  />
                  {{ attempt.succeeded ? 'Signed in' : 'Failed' }}
                </span>
              </td>

              <td class="px-5 py-3 text-ink-muted">
                <span v-if="attempt.username" class="font-mono text-xs">
                  {{ attempt.username }}
                </span>
                <span v-else class="text-ink-faint">&mdash;</span>
              </td>

              <td class="whitespace-nowrap px-5 py-3 font-mono text-xs text-ink-muted">
                {{ attempt.ip }}
              </td>

              <td class="whitespace-nowrap px-5 py-3 text-ink-muted" :title="exactly(attempt.at)">
                {{ timeAgo(attempt.at) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PaginationBar
        v-model:page="page"
        :total="attempts.length"
        :page-size="PAGE_SIZE"
        noun="attempts"
      />
    </section>
  </div>
</template>
