import { computed, onUnmounted, ref } from 'vue';
import { api } from './api';

/**
 * Following a job the user has just started.
 *
 * Anything that takes more than a moment on the server becomes a job with a
 * log, and every screen that starts one has the same problem: poll for new
 * lines, do not re-fetch the ones already shown, stop when it ends, and never
 * let a slow tick overlap the next one. Written once here, because three
 * copies of it is three chances to leak an interval.
 */

export interface JobLogLine {
  seq: number;
  level: string;
  message: string;
}

export interface UseJobLogOptions {
  /** Called once the job reaches a terminal state, to refresh what it changed. */
  onFinished?: (status: string) => void | Promise<void>;
  pollMs?: number;
}

export function useJobLog(options: UseJobLogOptions = {}) {
  const jobId = ref<string | null>(null);
  const lines = ref<JobLogLine[]>([]);
  const status = ref<string | null>(null);
  const progress = ref(0);

  let timer: ReturnType<typeof setInterval> | null = null;
  /** A slow tick must not overlap the next one, or lines arrive twice. */
  let polling = false;

  const running = computed(() => status.value === 'running' || status.value === 'pending');

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function poll(): Promise<void> {
    if (!jobId.value || polling) return;
    polling = true;

    try {
      const job = await api.jobs.get.query({ jobId: jobId.value });
      status.value = job?.status ?? null;
      progress.value = job?.progress ?? 0;

      const lastSeq = lines.value.at(-1)?.seq ?? -1;
      const fresh = await api.jobs.logs.query({ jobId: jobId.value, afterSeq: lastSeq });
      lines.value.push(...fresh);

      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        stop();
        await options.onFinished?.(job.status);
      }
    } catch {
      // A transient failure while polling should not tear down the view.
    } finally {
      polling = false;
    }
  }

  /** Starts following a job, discarding whatever was being followed before. */
  function watchJob(id: string): void {
    stop();
    jobId.value = id;
    lines.value = [];
    status.value = 'pending';
    progress.value = 0;
    timer = setInterval(() => void poll(), options.pollMs ?? 1000);
    void poll();
  }

  function reset(): void {
    stop();
    jobId.value = null;
    lines.value = [];
    status.value = null;
    progress.value = 0;
  }

  onUnmounted(stop);

  return { jobId, lines, status, progress, running, watchJob, stop, reset };
}

export const LOG_LEVEL_CLASS: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warn',
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
};
