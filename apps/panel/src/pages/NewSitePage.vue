<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Check, FolderTree, Loader, TriangleAlert } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';

/**
 * Add a website.
 *
 * Built around confirming rather than configuring: the panel clones the
 * repository, works out how to build it, and shows the result in plain
 * English. The user only has to intervene when the guess is wrong.
 */

const router = useRouter();

type Step = 'source' | 'confirm' | 'domain' | 'secrets';
const step = ref<Step>('source');

const repoUrl = ref('');
const branch = ref('main');
const token = ref('');
const isPrivate = ref(false);
const displayName = ref('');
const domains = ref('');

/**
 * Deep-links to the right token page for the host being used, since every
 * provider hides it somewhere different.
 */
const tokenHelpUrl = computed(() => {
  const url = repoUrl.value.toLowerCase();
  if (url.includes('github.com')) return 'https://github.com/settings/tokens';
  if (url.includes('gitlab.com')) return 'https://gitlab.com/-/user_settings/personal_access_tokens';
  if (url.includes('bitbucket.org')) {
    return 'https://bitbucket.org/account/settings/app-passwords/';
  }
  return null;
});

const canContinue = computed(
  () => repoUrl.value.trim().length > 0 && (!isPrivate.value || token.value.length > 0),
);

const busy = ref(false);
const error = ref<string | null>(null);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

type Inspection = Awaited<ReturnType<typeof api.sites.inspect.mutate>>;
const inspection = ref<Inspection | null>(null);

const envRows = ref<Array<{ key: string; value: string }>>([]);

const domainList = computed(() =>
  domains.value
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0),
);

const lowConfidence = computed(
  () => inspection.value !== null && inspection.value.confidence < 0.6,
);

async function testRepository(): Promise<void> {
  busy.value = true;
  error.value = null;
  testResult.value = null;

  try {
    testResult.value = await api.sites.testRepository.mutate({
      url: repoUrl.value.trim(),
      branch: branch.value.trim(),
      ...(token.value ? { token: token.value } : {}),
    });
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function inspectRepository(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    const result = await api.sites.inspect.mutate({
      url: repoUrl.value.trim(),
      branch: branch.value.trim(),
      ...(token.value ? { token: token.value } : {}),
    });

    inspection.value = result;

    // Pre-fill from what was found, so the remaining steps are mostly reading.
    envRows.value = result.manifest.envVars.map((key) => ({ key, value: '' }));

    if (!displayName.value) {
      const match = /\/([^/]+?)(?:\.git)?$/.exec(repoUrl.value.trim());
      displayName.value = match?.[1] ?? 'My website';
    }

    step.value = 'confirm';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function createSite(): Promise<void> {
  if (!inspection.value) return;

  busy.value = true;
  error.value = null;

  try {
    const envVars = Object.fromEntries(
      envRows.value.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    );

    const created = await api.sites.create.mutate({
      displayName: displayName.value.trim(),
      domains: domainList.value,
      source: {
        kind: 'git',
        url: repoUrl.value.trim(),
        branch: branch.value.trim(),
        subdirectory: '',
        ...(token.value ? { token: token.value } : {}),
      },
      manifest: inspection.value.manifest,
      envVars,
      deployNow: true,
    });

    await router.push(`/sites/${created.slug}`);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const inputClass =
  'w-full rounded-md border border-[--color-border] bg-[--color-surface] px-3 py-2 ' +
  'text-sm text-[--color-text]';
</script>

<template>
  <div class="mx-auto max-w-2xl">
    <ol class="mb-6 flex items-center gap-2 text-xs text-[--color-text-muted]">
      <li v-for="(label, index) in ['Your code', 'What we found', 'Web address', 'Settings']" :key="label"
          class="flex items-center gap-2">
        <span
          class="flex h-5 w-5 items-center justify-center rounded-full text-[10px]"
          :class="
            index <= ['source', 'confirm', 'domain', 'secrets'].indexOf(step)
              ? 'bg-[--color-brand] text-white'
              : 'bg-[--color-surface-sunken]'
          "
        >{{ index + 1 }}</span>
        {{ label }}
        <span v-if="index < 3" class="text-[--color-border]">/</span>
      </li>
    </ol>

    <div class="rounded-[--radius-card] border border-[--color-border] bg-[--color-surface] p-6">
      <!-- Step 1 -->
      <template v-if="step === 'source'">
        <h2 class="mb-1 text-base font-semibold text-[--color-text]">Where is your code?</h2>
        <p class="mb-4 text-sm text-[--color-text-muted]">
          Paste the address of your repository. The panel will look at it and work out how
          to build your site.
        </p>

        <div class="space-y-4">
          <div>
            <label for="repo" class="mb-1 block text-sm font-medium text-[--color-text]">
              Repository address
            </label>
            <input id="repo" v-model="repoUrl" :class="inputClass"
                   placeholder="https://github.com/you/your-project.git" />
            <p class="mt-1 text-xs text-[--color-text-muted]">
              Use the https:// address, not the SSH one.
            </p>
          </div>

          <div>
            <label for="branch" class="mb-1 block text-sm font-medium text-[--color-text]">
              Branch
            </label>
            <input id="branch" v-model="branch" :class="inputClass" />
          </div>

          <!--
            Private repositories are the common case, so this is a visible
            choice rather than a field people have to notice.
          -->
          <fieldset class="rounded-md border border-[--color-border] p-3">
            <legend class="px-1 text-sm font-medium text-[--color-text]">
              Is this repository private?
            </legend>

            <div class="flex gap-4 text-sm">
              <label class="flex items-center gap-1.5 text-[--color-text]">
                <input type="radio" :value="false" v-model="isPrivate" /> No, it's public
              </label>
              <label class="flex items-center gap-1.5 text-[--color-text]">
                <input type="radio" :value="true" v-model="isPrivate" /> Yes, it's private
              </label>
            </div>

            <div v-if="isPrivate" class="mt-3">
              <label for="token" class="mb-1 block text-sm font-medium text-[--color-text]">
                Access token
              </label>
              <input id="token" v-model="token" type="password" :class="inputClass"
                     placeholder="ghp_..." autocomplete="off" />
              <p class="mt-1 text-xs text-[--color-text-muted]">
                A read-only token is enough. It is stored encrypted on this server and is
                never written into your project files.
                <a v-if="tokenHelpUrl" :href="tokenHelpUrl" target="_blank"
                   rel="noreferrer noopener"
                   class="text-[--color-brand] underline underline-offset-2">
                  Create one
                </a>
              </p>
            </div>
          </fieldset>

          <p
            v-if="testResult"
            class="flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            :class="
              testResult.ok
                ? 'bg-[--color-status-ok-bg] text-[--color-status-ok]'
                : 'bg-[--color-status-blocked-bg] text-[--color-status-blocked]'
            "
          >
            <component :is="testResult.ok ? Check : TriangleAlert" :size="15" class="mt-0.5 shrink-0" />
            {{ testResult.message }}
          </p>

          <p v-if="error" class="rounded-md bg-[--color-status-blocked-bg] px-3 py-2 text-sm
                                 text-[--color-status-blocked]">
            {{ error }}
          </p>

          <div class="flex gap-2">
            <button type="button" :disabled="!canContinue || busy"
                    class="rounded-md border border-[--color-border] px-3 py-2 text-sm
                           text-[--color-text] disabled:opacity-50"
                    @click="testRepository">
              Test connection
            </button>
            <button type="button" :disabled="!canContinue || busy"
                    class="flex-1 rounded-md bg-[--color-brand] px-4 py-2 text-sm font-medium
                           text-white hover:bg-[--color-brand-hover] disabled:opacity-50"
                    @click="inspectRepository">
              {{ busy ? 'Looking at your project\u2026' : 'Continue' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Step 2 -->
      <template v-else-if="step === 'confirm' && inspection">
        <h2 class="mb-1 text-base font-semibold text-[--color-text]">Here's what we found</h2>
        <p class="mb-4 text-sm text-[--color-text-muted]">{{ inspection.summary }}</p>

        <div
          v-if="lowConfidence"
          class="mb-4 flex items-start gap-2 rounded-md bg-[--color-status-warn-bg] px-3 py-2
                 text-sm text-[--color-status-warn]"
        >
          <TriangleAlert :size="15" class="mt-0.5 shrink-0" />
          We are not confident about this. Check the steps below before continuing.
        </div>

        <div v-if="inspection.folders.length > 0" class="mb-4">
          <h3 class="mb-2 flex items-center gap-1.5 text-sm font-medium text-[--color-text]">
            <FolderTree :size="15" /> Folders
          </h3>
          <ul class="space-y-1 text-sm">
            <li v-for="folder in inspection.folders" :key="folder.path"
                class="flex justify-between rounded bg-[--color-surface-sunken] px-3 py-1.5">
              <span class="font-mono text-[--color-text]">{{ folder.path || '(root)' }}</span>
              <span class="text-[--color-text-muted]">
                {{ folder.kind === 'server' ? 'runs your site' : folder.kind }}
              </span>
            </li>
          </ul>
        </div>

        <div v-if="inspection.steps.length > 0" class="mb-4">
          <h3 class="mb-2 text-sm font-medium text-[--color-text]">Build steps</h3>
          <ol class="space-y-1 text-sm">
            <li v-for="(s, i) in inspection.steps" :key="i"
                class="flex gap-2 rounded bg-[--color-surface-sunken] px-3 py-1.5">
              <span class="text-[--color-text-muted]">{{ i + 1 }}.</span>
              <span class="text-[--color-text]">{{ s.name }}</span>
              <span class="ml-auto font-mono text-xs text-[--color-text-muted]">{{ s.folder }}</span>
            </li>
          </ol>
        </div>

        <p v-for="note in inspection.notes" :key="note"
           class="mb-2 rounded-md bg-[--color-surface-sunken] px-3 py-2 text-sm
                  text-[--color-text-muted]">
          {{ note }}
        </p>

        <div class="mt-5 flex gap-2">
          <button type="button" class="rounded-md border border-[--color-border] px-3 py-2 text-sm"
                  @click="step = 'source'">Back</button>
          <button type="button"
                  class="flex-1 rounded-md bg-[--color-brand] px-4 py-2 text-sm font-medium text-white"
                  @click="step = 'domain'">Looks right</button>
        </div>
      </template>

      <!-- Step 3 -->
      <template v-else-if="step === 'domain'">
        <h2 class="mb-1 text-base font-semibold text-[--color-text]">What web address?</h2>
        <p class="mb-4 text-sm text-[--color-text-muted]">
          The address visitors will type. You can add more later.
        </p>

        <div class="space-y-4">
          <div>
            <label for="name" class="mb-1 block text-sm font-medium text-[--color-text]">
              Name
            </label>
            <input id="name" v-model="displayName" :class="inputClass" />
          </div>

          <div>
            <label for="domains" class="mb-1 block text-sm font-medium text-[--color-text]">
              Web address
            </label>
            <input id="domains" v-model="domains" :class="inputClass"
                   placeholder="example.com, www.example.com" />
            <p class="mt-1 text-xs text-[--color-text-muted]">
              Separate several with commas.
            </p>
          </div>

          <div class="flex gap-2">
            <button type="button" class="rounded-md border border-[--color-border] px-3 py-2 text-sm"
                    @click="step = 'confirm'">Back</button>
            <button type="button" :disabled="domainList.length === 0 || !displayName"
                    class="flex-1 rounded-md bg-[--color-brand] px-4 py-2 text-sm font-medium
                           text-white disabled:opacity-50"
                    @click="step = 'secrets'">Continue</button>
          </div>
        </div>
      </template>

      <!-- Step 4 -->
      <template v-else-if="step === 'secrets'">
        <h2 class="mb-1 text-base font-semibold text-[--color-text]">Anything secret?</h2>
        <p class="mb-4 text-sm text-[--color-text-muted]">
          Database addresses, API keys and similar. These are stored encrypted and are only
          visible to your app.
        </p>

        <div class="space-y-2">
          <div v-for="(row, index) in envRows" :key="index" class="flex gap-2">
            <input v-model="row.key" :class="inputClass" class="font-mono" placeholder="NAME" />
            <input v-model="row.value" type="password" :class="inputClass" placeholder="value" />
            <button type="button" class="px-2 text-[--color-text-muted]"
                    aria-label="Remove" @click="envRows.splice(index, 1)">&times;</button>
          </div>

          <button type="button" class="text-sm text-[--color-brand]"
                  @click="envRows.push({ key: '', value: '' })">
            + Add another
          </button>
        </div>

        <p v-if="error" class="mt-4 rounded-md bg-[--color-status-blocked-bg] px-3 py-2 text-sm
                               text-[--color-status-blocked]">
          {{ error }}
        </p>

        <div class="mt-5 flex gap-2">
          <button type="button" class="rounded-md border border-[--color-border] px-3 py-2 text-sm"
                  @click="step = 'domain'">Back</button>
          <button type="button" :disabled="busy"
                  class="flex-1 rounded-md bg-[--color-brand] px-4 py-2 text-sm font-medium
                         text-white disabled:opacity-50"
                  @click="createSite">
            <Loader v-if="busy" :size="14" class="mr-1 inline animate-spin" />
            {{ busy ? 'Creating\u2026' : 'Create and deploy' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
