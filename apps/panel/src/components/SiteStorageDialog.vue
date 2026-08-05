<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { SHARED_DIR, SHARED_URL_PREFIX } from '@winpanel/shared';
import HowTo from './HowTo.vue';

/**
 * What each folder in a website is for, and which of them survive a deploy.
 *
 * The file manager can only afford one line of warning above the listing, and
 * "use the shared folder" raises more questions than it answers: kept where,
 * reachable at what address, and how does the site see it? Those answers are
 * long enough to need somewhere to put them, and short enough that sending
 * someone to a documentation site for them would be insulting.
 */

const props = defineProps<{
  open: boolean;
  /** `git` sites are rebuilt on every deploy; the rest are not. */
  sourceKind: 'git' | 'upload' | 'blank';
  runtime: string;
  /** The site's own address, used so the example URL is one that really works. */
  origin: string;
  /** False when this site has switched off publishing the folder at `/shared`. */
  published: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const isGit = computed(() => props.sourceKind === 'git');
const isStatic = computed(() => props.runtime === 'static');
// No invented hostname: a site with no domain and no preview port has no
// address to show, and a made-up one would be copied straight into a browser.
const exampleUrl = computed(() => `${props.origin}${SHARED_URL_PREFIX}/text.txt`);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="card flex max-h-[85vh] w-full max-w-2xl flex-col p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Where your files live"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-ink">Where your files live</h2>
          <p class="mt-1 text-sm text-ink-muted">
            A website has a few folders, and only some of them are yours to keep.
          </p>
        </div>

        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close" @click="emit('close')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>

      <div class="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 text-sm">
        <dl class="divide-y divide-line rounded-lg border border-line">
          <div v-if="isGit" class="grid gap-1 p-3 sm:grid-cols-[8rem_1fr] sm:gap-3">
            <dt class="font-medium text-ink">release</dt>
            <dd class="text-ink-muted">
              Your website, exactly as the last deployment built it.
              <strong class="font-medium text-warn">Deleted and rebuilt every deploy.</strong>
              Anything you add here by hand is gone the next time you deploy, so change it in your
              project and deploy again instead.
            </dd>
          </div>

          <div v-else class="grid gap-1 p-3 sm:grid-cols-[8rem_1fr] sm:gap-3">
            <dt class="font-medium text-ink">public</dt>
            <dd class="text-ink-muted">
              Your website. The panel never overwrites anything in here &mdash; upload, edit and
              delete freely.
            </dd>
          </div>

          <div class="grid gap-1 p-3 sm:grid-cols-[8rem_1fr] sm:gap-3">
            <dt class="font-medium text-ink">{{ SHARED_DIR }}</dt>
            <dd class="text-ink-muted">
              Files that are not part of your project and must survive every deploy: uploads,
              invoices, a verification file someone asked you to put on the site.
              <strong class="font-medium text-ink">Kept forever</strong>.
              <template v-if="published">
                Published at <code class="rounded bg-black/30 px-1">{{ SHARED_URL_PREFIX }}</code
                >.
              </template>
              <template v-else>
                Publishing it at
                <code class="rounded bg-black/30 px-1">{{ SHARED_URL_PREFIX }}</code> is switched
                off for this website, so nothing here has a web address.
              </template>
            </dd>
          </div>

          <div class="grid gap-1 p-3 sm:grid-cols-[8rem_1fr] sm:gap-3">
            <dt class="font-medium text-ink">logs</dt>
            <dd class="text-ink-muted">What your site has printed and what the web server saw.</dd>
          </div>
        </dl>

        <HowTo v-if="published" title="Adding a file that stays, and its address">
          <li>
            Open the <strong>{{ SHARED_DIR }}</strong> folder from Site root, and upload
            <strong>text.txt</strong> into it.
          </li>
          <li>
            It is live straight away, at
            <code class="break-all rounded bg-black/30 px-1">{{ exampleUrl }}</code
            >. No deployment, and nothing to add to your project.
          </li>
          <li>
            Folders work the same way:
            <strong>{{ SHARED_DIR }}/files/invoice.pdf</strong> is served at
            <code class="break-all rounded bg-black/30 px-1"
              >{{ SHARED_URL_PREFIX }}/files/invoice.pdf</code
            >.
          </li>
        </HowTo>

        <HowTo v-else title="Giving these files a web address">
          <li>
            Open <strong>Settings</strong> for this website and switch
            <strong>Shared folder</strong> on.
          </li>
          <li>
            Everything already in the folder is reachable immediately —
            <strong>{{ SHARED_DIR }}/text.txt</strong> at
            <code class="break-all rounded bg-black/30 px-1"
              >{{ SHARED_URL_PREFIX }}/text.txt</code
            >. There is nothing to deploy and nothing to move.
          </li>
          <li>
            Leave it off if your own app wants that address, or if these files are only ever read
            by the app rather than by a browser.
          </li>
        </HowTo>

        <p v-if="!isStatic" class="text-ink-muted">
          Your app can read these files too. They sit one folder above your code, so from the app's
          own directory the path is
          <code class="rounded bg-black/30 px-1">../{{ SHARED_DIR }}</code> &mdash; that path does
          not change between deployments.
        </p>

        <p v-if="published" class="text-ink-faint">
          Everything in this folder is on the public web, so treat it as public. Files whose name
          starts with a dot are refused whatever the address asked for, and the site's environment
          variables are kept outside it entirely.
        </p>
      </div>

      <div class="mt-4 flex justify-end border-t border-line pt-4">
        <button type="button" class="btn btn-ghost" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>
