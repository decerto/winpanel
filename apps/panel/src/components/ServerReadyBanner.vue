<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, describeError } from '../lib/api';
import AlertMessage from './AlertMessage.vue';

/**
 * "This server is not ready yet", said once, at the top of every page.
 *
 * Two situations look identical from a website page and are both invisible:
 * a fresh install where nothing has been downloaded yet, and the aftermath of
 * an update, which stops every service and does not start them again. In both
 * cases the panel works, the websites do not, and nothing on screen says so.
 */

const ESSENTIAL = ['caddy', 'git'] as const;

const route = useRoute();
const missing = ref<string[]>([]);
const stopped = ref<string[]>([]);
const starting = ref(false);
const error = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    const [components, services] = await Promise.all([
      api.components.list.query(),
      api.system.backgroundServices.query(),
    ]);

    missing.value = components
      .filter((one) => ESSENTIAL.includes(one.id as (typeof ESSENTIAL)[number]) && !one.installed)
      .map((one) => one.name);

    // The panel itself is excluded: it is answering this request, so whatever
    // Windows believes about it, it is up.
    stopped.value = services
      .filter((one) => one.kind !== 'panel' && one.state !== 'running')
      .map((one) => one.label);
  } catch (err) {
    // A banner that cannot load is not worth an error on every page.
    error.value = describeError(err);
  }
}

async function startEverything(): Promise<void> {
  starting.value = true;
  error.value = null;

  try {
    await api.system.startAll.mutate();
    await refresh();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    starting.value = false;
  }
}

onMounted(refresh);

// Settings is where both problems get fixed, so re-check on the way out of it.
watch(() => route.path, (_to, from) => {
  if (from.startsWith('/settings')) void refresh();
});

const show = computed(() => missing.value.length > 0 || stopped.value.length > 0);
</script>

<template>
  <AlertMessage
    v-if="show"
    tone="warning"
    :title="missing.length > 0 ? 'This server is not set up yet' : 'Some services are stopped'"
    class="mb-6"
  >
    <template v-if="missing.length > 0">
      <p>
        {{ missing.join(' and ') }}
        {{ missing.length === 1 ? 'has' : 'have' }} not been installed, so websites cannot be
        published yet. Install
        {{ missing.length === 1 ? 'it' : 'them' }} from
        <RouterLink to="/settings">Settings &#8250; Programs</RouterLink>.
      </p>
    </template>

    <template v-else>
      <p>
        {{ stopped.join(', ') }}
        {{ stopped.length === 1 ? 'is' : 'are' }} not running. Updating the panel stops
        everything it runs and does not start it again.
      </p>
      <p class="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="starting"
          @click="startEverything"
        >
          {{ starting ? 'Starting\u2026' : 'Start everything' }}
        </button>
        <RouterLink to="/settings" class="btn btn-ghost btn-sm">Open Settings</RouterLink>
      </p>
    </template>

    <p v-if="error" class="mt-2 text-xs">{{ error }}</p>
  </AlertMessage>
</template>
