<script setup lang="ts">
import { computed, ref } from 'vue';
import { Copy, Download } from 'lucide-vue-next';
import AlertMessage from './AlertMessage.vue';

/**
 * The one and only showing of a set of recovery codes.
 *
 * They are stored hashed, so this screen cannot be produced again — a set
 * that is not saved here can only be replaced, not recovered. That is why
 * moving on requires ticking a box rather than a single easy click.
 */

const props = defineProps<{ codes: readonly string[]; doneLabel?: string }>();
const emit = defineEmits<{ done: [] }>();

const saved = ref(false);
const copied = ref(false);

const asText = computed(() => props.codes.join('\r\n'));

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(asText.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard access can be refused. The codes are on screen to be copied
    // by hand, so this is not worth an error message.
  }
}

function download(): void {
  const url = URL.createObjectURL(new Blob([asText.value], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'winpanel-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div>
    <AlertMessage tone="warning" class="mb-4">
      Save these now. Each one signs you in once if you lose your authenticator app. They are not
      shown again and cannot be recovered — only replaced.
    </AlertMessage>

    <ul
      class="mb-4 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-black/25 p-4
             font-mono text-sm text-ink"
    >
      <li v-for="code in codes" :key="code">{{ code }}</li>
    </ul>

    <div class="mb-4 flex gap-2">
      <button type="button" class="btn btn-ghost btn-sm" @click="copy">
        <Copy :size="14" aria-hidden="true" />
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
      <button type="button" class="btn btn-ghost btn-sm" @click="download">
        <Download :size="14" aria-hidden="true" />
        Download
      </button>
    </div>

    <label class="mb-4 flex items-start gap-2 text-sm text-ink">
      <input v-model="saved" type="checkbox" class="mt-0.5" />
      <span>I have saved these somewhere safe</span>
    </label>

    <button
      type="button"
      :disabled="!saved"
      class="btn btn-primary btn-lg w-full"
      @click="emit('done')"
    >
      {{ doneLabel ?? 'Done' }}
    </button>
  </div>
</template>
