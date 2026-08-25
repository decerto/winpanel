<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { MapPin, Plus, X } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from './AlertMessage.vue';
import LoadingBlock from './LoadingBlock.vue';

/**
 * Who may reach one database from off the machine.
 *
 * This belongs to whoever owns the database rather than to whoever owns the
 * server: the person who needs to connect is the customer or the developer
 * they hired, and an administrator has no way of knowing what address that is.
 *
 * The port itself is shared with every other database on the same engine, so
 * opening it here does not put anything else within reach — the login is
 * restricted to these same addresses, and a database that asked for nothing
 * stays reachable only from this machine.
 */

const props = defineProps<{ databaseId: string; name: string }>();
const emit = defineEmits<{ saved: [] }>();

type Access = Awaited<ReturnType<typeof api.databases.networkAccess.query>>;

const MODES = [
  { value: 'loopback', label: 'This server only' },
  { value: 'any', label: 'Any IP' },
  { value: 'whitelist', label: 'Chosen addresses' },
] as const;

const access = ref<Access | null>(null);
const mode = ref<'loopback' | 'any' | 'whitelist'>('loopback');
const sources = ref<string[]>([]);
const draft = ref('');

const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const yourIp = computed(() => access.value?.yourIp ?? null);
const panelIp = computed(() => access.value?.panelIp ?? null);

/** Loopback would let nothing new in, so offering to add it is a trap. */
const ownIpUsable = computed(() => {
  const ip = yourIp.value;
  return Boolean(ip && ip !== '::1' && !ip.startsWith('127.'));
});

const ownIpListed = computed(() => Boolean(yourIp.value && sources.value.includes(yourIp.value)));
const hasIpv6 = computed(() => sources.value.some((source) => source.includes(':')));

const dirty = computed(() => {
  const saved = access.value?.policy;
  if (!saved) return false;
  return (
    saved.mode !== mode.value ||
    saved.remoteCidrs.join(',') !== sources.value.join(',')
  );
});

function adopt(value: Access): void {
  access.value = value;
  mode.value = value.policy.mode;
  sources.value = [...value.policy.remoteCidrs];
}

async function load(): Promise<void> {
  try {
    adopt(await api.databases.networkAccess.query({ id: props.databaseId }));
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

function addSource(): void {
  const value = draft.value.trim();
  if (!value || sources.value.includes(value)) return;
  sources.value.push(value);
  draft.value = '';
}

function addOwnIp(): void {
  const ip = yourIp.value;
  if (!ip || sources.value.includes(ip)) return;
  sources.value.push(ip);
}

function removeSource(source: string): void {
  sources.value = sources.value.filter((entry) => entry !== source);
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    const result = await api.databases.setNetworkAccess.mutate({
      id: props.databaseId,
      mode: mode.value,
      remoteCidrs: sources.value,
    });

    if (access.value) access.value = { ...access.value, policy: result.policy };
    mode.value = result.policy.mode;
    sources.value = [...result.policy.remoteCidrs];
    notice.value =
      result.policy.mode === 'loopback'
        ? 'Remote connections are switched off.'
        : 'Remote access updated.';
    emit('saved');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="rounded-lg border border-line bg-black/20 p-4 text-sm">
    <LoadingBlock v-if="loading" class="h-24 rounded-md" />

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="font-semibold text-ink">Who can reach {{ name }}</h3>
          <p class="mt-1 text-xs text-ink-faint">
            Databases answer only on this server until you say otherwise.
            <span v-if="access">TCP port {{ access.port }}.</span>
          </p>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="busy || !dirty"
          @click="save"
        >
          {{ busy ? 'Applying\u2026' : 'Apply' }}
        </button>
      </div>

      <div class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Who can connect">
        <button
          v-for="option in MODES"
          :key="option.value"
          type="button"
          class="btn btn-ghost btn-sm"
          :class="mode === option.value ? 'text-ink' : ''"
          :aria-pressed="mode === option.value"
          @click="mode = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <div v-if="mode === 'whitelist'" class="mt-4 space-y-2">
        <div
          v-for="source in sources"
          :key="source"
          class="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
        >
          <code class="min-w-0 truncate text-xs text-ink">{{ source }}</code>
          <button
            type="button"
            class="btn btn-ghost btn-sm shrink-0"
            :aria-label="`Remove ${source}`"
            :disabled="source === panelIp"
            @click="removeSource(source)"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>

        <div class="flex flex-wrap gap-2">
          <input
            v-model="draft"
            class="field min-w-48 flex-1 font-mono text-xs"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="203.0.113.42 or 203.0.113.0/24"
            @keydown.enter.prevent="addSource"
          />
          <button type="button" class="btn btn-ghost btn-sm" @click="addSource">
            <Plus :size="14" aria-hidden="true" /> Add address
          </button>
          <button
            v-if="ownIpUsable"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="ownIpListed"
            @click="addOwnIp"
          >
            <MapPin :size="14" aria-hidden="true" />
            {{ ownIpListed ? 'My IP is on the list' : 'Add my IP (' + yourIp + ')' }}
          </button>
        </div>

        <p class="hint">Use an IP address or a CIDR range. At least one is needed.</p>
        <p v-if="panelIp" class="hint">
          The panel server address <span class="font-mono">{{ panelIp }}</span> is always included,
          so applications running on this server can use the same connection details.
        </p>
        <p v-if="!ownIpUsable" class="hint">
          You are signed in on the server itself, so your own address would let nothing new in.
          Add the address of the computer that needs to connect.
        </p>
        <p v-if="hasIpv6" class="hint">
          Databases listen on IPv4, so an IPv6 entry is allowed through the firewall but still
          will not connect.
        </p>
      </div>

      <AlertMessage v-if="mode === 'any'" tone="warning" class="mt-4">
        Anyone who can reach this server may try to sign in to this database. Only the password
        stands in their way. Choose the addresses instead whenever you know them.
      </AlertMessage>
      <p v-else-if="mode === 'loopback'" class="hint mt-4">
        Only applications running on this server can connect.
      </p>

      <p v-if="access?.addresses.length && mode !== 'loopback'" class="mt-3 text-xs text-ink-faint">
        Connect to <span class="font-mono">{{ access.addresses.join(', ') }}</span
        >, or the server&rsquo;s public address if it is behind a router.
      </p>

      <AlertMessage v-if="error" tone="danger" class="mt-3">{{ error }}</AlertMessage>
      <AlertMessage v-if="notice" tone="success" class="mt-3">{{ notice }}</AlertMessage>
    </template>
  </div>
</template>
