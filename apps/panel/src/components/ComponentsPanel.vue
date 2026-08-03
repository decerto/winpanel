<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { Boxes, Play, RefreshCw, Square, Trash2 } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from './AlertMessage.vue';

/**
 * The programs the panel drives: web server, mail server, git.
 *
 * Installing one is a job, not a request — it downloads tens of megabytes,
 * unpacks it, and registers a Windows service — so the log is streamed here
 * rather than leaving somebody watching a spinner for three minutes.
 */

type Component = Awaited<ReturnType<typeof api.components.list.query>>[number];

const components = ref<Component[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);

const activeJobId = ref<string | null>(null);
const logLines = ref<Array<{ seq: number; level: string; message: string }>>([]);
const jobStatus = ref<string | null>(null);
let poller: ReturnType<typeof setInterval> | null = null;
/** A slow tick must not overlap the next one, or lines arrive twice. */
let polling = false;

const emit = defineEmits<{ changed: [] }>();

const running = computed(() => jobStatus.value === 'running' || jobStatus.value === 'pending');

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  'not-installed': 'Not registered',
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    components.value = await api.components.list.query();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

void load();

function stopPolling(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

async function pollJob(): Promise<void> {
  if (!activeJobId.value || polling) return;
  polling = true;

  try {
    const job = await api.jobs.get.query({ jobId: activeJobId.value });
    jobStatus.value = job?.status ?? null;

    const lastSeq = logLines.value.at(-1)?.seq ?? -1;
    logLines.value.push(
      ...(await api.jobs.logs.query({ jobId: activeJobId.value, afterSeq: lastSeq })),
    );

    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      stopPolling();
      busyId.value = null;
      await load();
      emit('changed');
    }
  } catch {
    // A transient failure while polling should not tear down the view.
  } finally {
    polling = false;
  }
}

function watchJob(jobId: string): void {
  activeJobId.value = jobId;
  logLines.value = [];
  jobStatus.value = 'pending';
  stopPolling();
  poller = setInterval(() => void pollJob(), 1000);
}

async function install(component: Component): Promise<void> {
  busyId.value = component.id;
  error.value = null;

  try {
    const result = await api.components.install.mutate({ componentId: component.id });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function uninstall(component: Component): Promise<void> {
  if (
    !window.confirm(
      `Remove ${component.name}? Its data is left in place, but anything relying on it stops ` +
        'working until it is installed again.',
    )
  ) {
    return;
  }

  busyId.value = component.id;
  error.value = null;

  try {
    const result = await api.components.uninstall.mutate({ componentId: component.id });
    watchJob(result.jobId);
  } catch (err) {
    error.value = describeError(err);
    busyId.value = null;
  }
}

async function service(component: Component, action: 'start' | 'stop' | 'restart'): Promise<void> {
  busyId.value = component.id;
  error.value = null;

  try {
    await api.components.service.mutate({ componentId: component.id, action });
    await load();
    emit('changed');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busyId.value = null;
  }
}

const levelClass: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warn',
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
};

onUnmounted(stopPolling);
</script>

<template>
  <section class="card p-6">
    <div class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line
               bg-brand-soft/50 text-brand-bright"
        aria-hidden="true"
      >
        <Boxes :size="19" />
      </span>

      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold text-ink">Programs</h2>
        <p class="mt-1 text-sm text-ink-muted">
          The pieces that do the actual work. Each is downloaded from its official release,
          checked, and registered as a Windows service that starts with the machine.
        </p>
      </div>
    </div>

    <AlertMessage v-if="error" class="mt-4">{{ error }}</AlertMessage>

    <div v-if="loading" class="mt-5 space-y-2">
      <div v-for="n in 3" :key="n" class="h-16 animate-pulse rounded-lg bg-elevated/60" />
    </div>

    <ul v-else class="mt-5 divide-y divide-line">
      <li v-for="component in components" :key="component.id" class="flex flex-wrap gap-4 py-4">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-medium text-ink">{{ component.name }}</h3>
            <span class="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs text-ink-faint">
              {{ component.version }}
            </span>

            <span v-if="component.installed" class="flex items-center gap-1.5 text-xs">
              <span
                class="h-1.5 w-1.5 rounded-full"
                :class="
                  !component.serviceName || component.serviceState === 'running'
                    ? 'bg-ok'
                    : 'bg-idle'
                "
                aria-hidden="true"
              />
              <span
                :class="
                  !component.serviceName || component.serviceState === 'running'
                    ? 'text-ok'
                    : 'text-ink-muted'
                "
              >
                {{ component.serviceName ? STATE_LABEL[component.serviceState ?? ''] : 'Installed' }}
              </span>
            </span>
            <span v-else class="text-xs text-ink-faint">
              {{ component.managed ? 'Not installed' : 'None found' }}
            </span>
          </div>

          <p class="mt-1 text-sm text-ink-muted">{{ component.description }}</p>

          <!-- Node is the server's to provide, not the panel's to install. -->
          <p v-if="!component.managed" class="mt-1 text-xs text-ink-faint">
            Provided by the server itself. The panel uses the versions it finds and never
            installs its own.
          </p>
        </div>

        <div v-if="component.managed" class="flex shrink-0 flex-wrap items-start gap-2">
          <template v-if="component.installed">
            <!--
              A program can be on disk with no service registered, when an
              install failed partway. Offering Start then only produces a
              failure; reinstalling is what actually fixes it.
            -->
            <button
              v-if="
                component.serviceName &&
                component.serviceState !== 'not-installed' &&
                component.serviceState !== 'running'
              "
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="service(component, 'start')"
            >
              <Play :size="13" aria-hidden="true" /> Start
            </button>
            <button
              v-else-if="component.serviceName && component.serviceState === 'running'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="service(component, 'stop')"
            >
              <Square :size="13" aria-hidden="true" /> Stop
            </button>

            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busyId !== null"
              @click="install(component)"
            >
              <RefreshCw
                :size="13"
                :class="busyId === component.id && running ? 'animate-spin' : ''"
                aria-hidden="true"
              />
              Reinstall
            </button>

            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="busyId !== null"
              :aria-label="`Remove ${component.name}`"
              @click="uninstall(component)"
            >
              <Trash2 :size="13" />
            </button>
          </template>

          <button
            v-else
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="busyId !== null"
            @click="install(component)"
          >
            {{ busyId === component.id ? 'Installing\u2026' : 'Install' }}
          </button>
        </div>
      </li>
    </ul>

    <div v-if="logLines.length > 0" class="mt-5 overflow-hidden rounded-lg border border-line">
      <div class="flex items-center justify-between border-b border-line px-4 py-2">
        <h3 class="text-sm font-medium text-ink">Installation log</h3>
        <span class="text-xs capitalize text-ink-faint">{{ jobStatus }}</span>
      </div>
      <pre
        class="max-h-64 overflow-y-auto bg-black/25 p-4 font-mono text-xs leading-relaxed"
      ><span
        v-for="line in logLines"
        :key="line.seq"
        class="block"
        :class="levelClass[line.level] ?? 'text-ink'"
      >{{ line.message }}</span></pre>
    </div>
  </section>
</template>
