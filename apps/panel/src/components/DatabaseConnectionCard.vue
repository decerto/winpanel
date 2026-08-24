<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import { databaseUri, type DatabaseConnection } from '@winpanel/shared';

/**
 * Everything somebody needs to point an application at a database.
 *
 * Shown in one block rather than as five fields to copy one at a time,
 * because a connection URI is what almost every framework actually wants —
 * `DATABASE_URL`, `MONGODB_URI`, the argument to `psql`. The individual
 * fields are there too, for the configuration formats that still ask for
 * them separately.
 *
 * The password is only in the URI once it has been revealed. Until then the
 * placeholder stays, so the block is useful immediately without putting a
 * live credential on screen for anybody walking past.
 */

const props = defineProps<{
  connection: DatabaseConnection;
  /** The real password, once it has been revealed. Null keeps the placeholder. */
  password?: string | null;
  /** Drops the frame, for when this already sits inside one. */
  flush?: boolean;
}>();

const uri = computed(() =>
  props.password
    ? databaseUri(
        props.connection.engine,
        props.connection.username,
        props.connection.database,
        props.password,
      )
    : props.connection.uriTemplate,
);

/** The environment variable this normally goes in, so the line can be pasted whole. */
const ENV_NAME: Record<DatabaseConnection['engine'], string> = {
  mariadb: 'DATABASE_URL',
  postgres: 'DATABASE_URL',
  mongodb: 'MONGODB_URI',
};

const copied = ref<string | null>(null);

async function copy(what: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = what;
    setTimeout(() => (copied.value = null), 1500);
  } catch {
    // Clipboard access can be refused; everything here is on screen to read.
  }
}
</script>

<template>
  <div
    class="space-y-3 text-sm"
    :class="flush ? '' : 'rounded-lg border border-line bg-black/20 p-4'"
  >
    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="label mb-0">Connection string</span>
        <button type="button" class="btn btn-ghost btn-sm" @click="copy('uri', uri)">
          <component :is="copied === 'uri' ? Check : Copy" :size="13" aria-hidden="true" />
          {{ copied === 'uri' ? 'Copied' : 'Copy' }}
        </button>
      </div>

      <code
        class="block overflow-x-auto whitespace-pre rounded-md bg-black/40 px-2.5 py-2
               font-mono text-xs text-ink"
        >{{ uri }}</code
      >

      <p class="hint">
        <template v-if="!password">
          Replace <span class="font-mono">PASSWORD</span> with the database's password, or press
          Show to have it filled in.
        </template>
        Most frameworks read this from
        <span class="font-mono">{{ ENV_NAME[connection.engine] }}</span
        >.
      </p>
    </div>

    <dl class="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      <div class="flex items-baseline gap-2">
        <dt class="w-20 shrink-0 text-ink-muted">Host</dt>
        <dd class="font-mono text-ink">{{ connection.host }}</dd>
      </div>
      <div class="flex items-baseline gap-2">
        <dt class="w-20 shrink-0 text-ink-muted">Port</dt>
        <dd class="font-mono text-ink">{{ connection.port }}</dd>
      </div>
      <div class="flex items-baseline gap-2">
        <dt class="w-20 shrink-0 text-ink-muted">Database</dt>
        <dd class="min-w-0 truncate font-mono text-ink">{{ connection.database }}</dd>
      </div>
      <div class="flex items-baseline gap-2">
        <dt class="w-20 shrink-0 text-ink-muted">Username</dt>
        <dd class="min-w-0 truncate font-mono text-ink">{{ connection.username }}</dd>
      </div>
      <!-- MongoDB's login lives inside its own database rather than in
           `admin`, and a driver told nothing looks in `admin` and reports the
           password as wrong. -->
      <div v-if="connection.engine === 'mongodb'" class="flex items-baseline gap-2">
        <dt class="w-20 shrink-0 text-ink-muted">Auth source</dt>
        <dd class="min-w-0 truncate font-mono text-ink">{{ connection.database }}</dd>
      </div>
      <div v-if="password" class="flex items-center gap-2 sm:col-span-2">
        <dt class="w-20 shrink-0 text-ink-muted">Password</dt>
        <dd class="min-w-0 flex-1">
          <code class="block truncate rounded-md bg-black/40 px-2 py-1 font-mono text-xs">
            {{ password }}
          </code>
        </dd>
        <button
          type="button"
          class="btn btn-ghost btn-sm shrink-0"
          @click="copy('password', password)"
        >
          <component :is="copied === 'password' ? Check : Copy" :size="13" aria-hidden="true" />
          {{ copied === 'password' ? 'Copied' : 'Copy' }}
        </button>
      </div>
    </dl>

    <p class="hint">
      The database only answers on this machine, so use these from something running on
      this server.
    </p>
  </div>
</template>
