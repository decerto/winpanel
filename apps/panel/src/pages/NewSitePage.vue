<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  ArrowLeft,
  Check,
  FileCode,
  FolderTree,
  GitBranch,
  Loader,
  Plus,
  Server,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';

/**
 * Add a website.
 *
 * The first question is what kind of website it is, because that decides
 * everything after it. Assuming a git repository — as this page used to —
 * made a folder of HTML files impossible to host, which is the simplest kind
 * of website there is.
 *
 * For git the page still confirms rather than configures: the panel clones the
 * repository, works out how to build it, and shows the result in plain English.
 */

const router = useRouter();

type Kind = 'static' | 'upload' | 'git' | 'node';

const KINDS = [
  {
    key: 'static' as const,
    icon: FileCode,
    title: 'A simple website',
    blurb:
      'HTML, CSS and images. We create the folder and a starter page for you to edit or replace.',
  },
  {
    key: 'upload' as const,
    icon: Upload,
    title: 'I already have the files',
    blurb:
      'The same, but starting empty. Add your files from the Files tab once the website exists.',
  },
  {
    key: 'git' as const,
    icon: GitBranch,
    title: 'From a Git repository',
    blurb:
      'We clone your repository, work out how to build it, and redeploy whenever you ask.',
  },
  {
    key: 'node' as const,
    icon: Server,
    title: 'A Node app from scratch',
    blurb:
      'Creates a small working Node server you can edit here. Choose this to start writing code straight away.',
  },
];

type Step = 'kind' | 'source' | 'confirm' | 'domain' | 'secrets';
const step = ref<Step>('kind');
const kind = ref<Kind>('static');

/** Everything except git is created from a folder rather than a build. */
const isGit = computed(() => kind.value === 'git');
/** Only these run a process, so only these can have secrets. */
const hasSecrets = computed(() => kind.value === 'git' || kind.value === 'node');
/** Only these are served by the web server directly. */
const servesFiles = computed(() => kind.value === 'static' || kind.value === 'upload');

const repoUrl = ref('');
const branch = ref('main');
const token = ref('');
const isPrivate = ref(false);
const displayName = ref('');
const domains = ref('');
const spaFallback = ref(false);

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

function chooseKind(next: Kind): void {
  kind.value = next;
  step.value = next === 'git' ? 'source' : 'domain';
}

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

/** The source and runtime each choice on the first step maps to. */
function payloadFor(): {
  source: Record<string, unknown> & { kind: 'git' | 'upload' | 'blank' };
  runtime: 'static' | 'node';
} {
  switch (kind.value) {
    case 'git':
      return {
        source: {
          kind: 'git',
          url: repoUrl.value.trim(),
          branch: branch.value.trim(),
          subdirectory: '',
          ...(token.value ? { token: token.value } : {}),
        },
        runtime: 'static',
      };
    case 'upload':
      return { source: { kind: 'upload' }, runtime: 'static' };
    case 'node':
      return { source: { kind: 'blank' }, runtime: 'node' };
    default:
      return { source: { kind: 'blank' }, runtime: 'static' };
  }
}

async function createSite(): Promise<void> {
  if (isGit.value && !inspection.value) return;

  busy.value = true;
  error.value = null;

  try {
    const envVars = Object.fromEntries(
      envRows.value.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    );

    const { source, runtime } = payloadFor();

    const created = await api.sites.create.mutate({
      displayName: displayName.value.trim(),
      domains: domainList.value,
      source: source as never,
      runtime,
      // Git sites carry the manifest the inspection produced; for everything
      // else the server writes one that matches the runtime.
      ...(isGit.value && inspection.value ? { manifest: inspection.value.manifest } : {}),
      spaFallback: spaFallback.value,
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

/** The wizard is shorter when there is no repository to look at. */
const STEPS = computed(() => {
  const steps: Array<{ key: Step; label: string }> = [{ key: 'kind', label: 'Type' }];

  if (isGit.value) {
    steps.push({ key: 'source', label: 'Your code' }, { key: 'confirm', label: 'What we found' });
  }

  steps.push({ key: 'domain', label: 'Web address' });
  if (hasSecrets.value) steps.push({ key: 'secrets', label: 'Settings' });

  return steps;
});

const stepIndex = computed(() => STEPS.value.findIndex((s) => s.key === step.value));

/** Where "Back" goes from the address step, which differs per kind. */
const backFromDomain = computed<Step>(() => (isGit.value ? 'confirm' : 'kind'));
</script>

<template>
  <div class="max-w-2xl">
    <RouterLink
      to="/sites"
      class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft :size="15" aria-hidden="true" /> All websites
    </RouterLink>

    <!-- Where you are, and how much is left. -->
    <ol class="mb-6 flex items-center gap-2">
      <li v-for="(entry, index) in STEPS" :key="entry.key" class="flex flex-1 items-center gap-2">
        <span
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]
                 font-semibold transition-colors"
          :class="
            index <= stepIndex
              ? 'bg-brand text-white'
              : 'border border-line bg-surface text-ink-faint'
          "
        >
          <Check v-if="index < stepIndex" :size="13" aria-hidden="true" />
          <template v-else>{{ index + 1 }}</template>
        </span>
        <span
          class="hidden text-xs sm:block"
          :class="index === stepIndex ? 'font-medium text-ink' : 'text-ink-faint'"
        >
          {{ entry.label }}
        </span>
        <span
          v-if="index < STEPS.length - 1"
          class="h-px flex-1 rounded-full"
          :class="index < stepIndex ? 'bg-brand' : 'bg-line'"
          aria-hidden="true"
        />
      </li>
    </ol>

    <div class="card p-6">
      <!-- Step 1: what kind of website this is. -->
      <template v-if="step === 'kind'">
        <h2 class="text-lg font-semibold tracking-tight text-ink">What are you hosting?</h2>
        <p class="mt-1 text-sm text-ink-muted">
          This decides where your files come from. Everything else can be changed later.
        </p>

        <div class="mt-5 space-y-2">
          <button
            v-for="option in KINDS"
            :key="option.key"
            type="button"
            class="flex w-full gap-3 rounded-lg border border-line bg-black/20 p-4 text-left
                   transition-colors hover:border-brand hover:bg-brand-soft"
            @click="chooseKind(option.key)"
          >
            <component
              :is="option.icon"
              :size="18"
              class="mt-0.5 shrink-0 text-brand-bright"
              aria-hidden="true"
            />
            <span>
              <span class="block text-sm font-medium text-ink">{{ option.title }}</span>
              <span class="mt-0.5 block text-sm text-ink-muted">{{ option.blurb }}</span>
            </span>
          </button>
        </div>
      </template>

      <!-- Git only: where the code lives. -->
      <template v-else-if="step === 'source'">
        <h2 class="text-lg font-semibold tracking-tight text-ink">Where is your code?</h2>
        <p class="mt-1 text-sm text-ink-muted">
          Paste the address of your repository. The panel will look at it and work out how to
          build your site.
        </p>

        <div class="mt-5 space-y-4">
          <div>
            <label for="repo" class="label">Repository address</label>
            <input
              id="repo"
              v-model="repoUrl"
              class="field font-mono"
              placeholder="https://github.com/you/your-project.git"
            />
            <p class="hint">Use the https:// address, not the SSH one.</p>
          </div>

          <div>
            <label for="branch" class="label">Branch</label>
            <input id="branch" v-model="branch" class="field max-w-48 font-mono" />
          </div>

          <!--
            Private repositories are the common case, so this is a visible
            choice rather than a field people have to notice.
          -->
          <fieldset class="rounded-lg border border-line p-4">
            <legend class="px-1 text-sm font-medium text-ink">Is this repository private?</legend>

            <div class="flex gap-5 text-sm">
              <label class="flex items-center gap-2 text-ink-muted">
                <input v-model="isPrivate" type="radio" :value="false" /> No, it's public
              </label>
              <label class="flex items-center gap-2 text-ink-muted">
                <input v-model="isPrivate" type="radio" :value="true" /> Yes, it's private
              </label>
            </div>

            <div v-if="isPrivate" class="mt-4">
              <label for="token" class="label">Access token</label>
              <input
                id="token"
                v-model="token"
                type="password"
                class="field font-mono"
                placeholder="ghp_..."
                autocomplete="off"
              />
              <p class="hint">
                A read-only token is enough. It is stored encrypted on this server and is never
                written into your project files.
                <a
                  v-if="tokenHelpUrl"
                  :href="tokenHelpUrl"
                  target="_blank"
                  rel="noreferrer noopener"
                  class="text-brand-bright underline underline-offset-2"
                >
                  Create one
                </a>
              </p>
            </div>
          </fieldset>

          <AlertMessage v-if="testResult" :tone="testResult.ok ? 'success' : 'danger'">
            {{ testResult.message }}
          </AlertMessage>

          <AlertMessage v-if="error">{{ error }}</AlertMessage>

          <div class="flex gap-2">
            <button type="button" class="btn btn-ghost" @click="step = 'kind'">Back</button>
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="!canContinue || busy"
              @click="testRepository"
            >
              Test connection
            </button>
            <button
              type="button"
              class="btn btn-primary flex-1"
              :disabled="!canContinue || busy"
              @click="inspectRepository"
            >
              {{ busy ? 'Looking at your project\u2026' : 'Continue' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Git only: what the inspection found. -->
      <template v-else-if="step === 'confirm' && inspection">
        <h2 class="text-lg font-semibold tracking-tight text-ink">Here's what we found</h2>
        <p class="mt-1 text-sm text-ink-muted">{{ inspection.summary }}</p>

        <AlertMessage v-if="lowConfidence" tone="warning" class="mt-4">
          We are not confident about this. Check the steps below before continuing.
        </AlertMessage>

        <div v-if="inspection.folders.length > 0" class="mt-5">
          <h3 class="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
            <FolderTree :size="15" class="text-ink-faint" aria-hidden="true" /> Folders
          </h3>
          <ul class="space-y-1.5 text-sm">
            <li
              v-for="folder in inspection.folders"
              :key="folder.path"
              class="flex justify-between rounded-lg border border-line bg-black/20 px-3 py-2"
            >
              <span class="font-mono text-ink">{{ folder.path || '(root)' }}</span>
              <span class="text-ink-muted">
                {{ folder.kind === 'server' ? 'runs your site' : folder.kind }}
              </span>
            </li>
          </ul>
        </div>

        <div v-if="inspection.steps.length > 0" class="mt-5">
          <h3 class="mb-2 text-sm font-medium text-ink">Build steps</h3>
          <ol class="space-y-1.5 text-sm">
            <li
              v-for="(s, i) in inspection.steps"
              :key="i"
              class="flex gap-2 rounded-lg border border-line bg-black/20 px-3 py-2"
            >
              <span class="text-ink-faint">{{ i + 1 }}.</span>
              <span class="text-ink">{{ s.name }}</span>
              <span class="ml-auto font-mono text-xs text-ink-faint">{{ s.folder }}</span>
            </li>
          </ol>
        </div>

        <p
          v-for="note in inspection.notes"
          :key="note"
          class="mt-3 rounded-lg border border-line bg-black/20 px-3 py-2 text-sm text-ink-muted"
        >
          {{ note }}
        </p>

        <div class="mt-6 flex gap-2">
          <button type="button" class="btn btn-ghost" @click="step = 'source'">Back</button>
          <button type="button" class="btn btn-primary flex-1" @click="step = 'domain'">
            Looks right
          </button>
        </div>
      </template>

      <!-- Name and, optionally, a web address. -->
      <template v-else-if="step === 'domain'">
        <h2 class="text-lg font-semibold tracking-tight text-ink">What should it be called?</h2>
        <p class="mt-1 text-sm text-ink-muted">
          A web address is optional. Without one you still get a link that works immediately, and
          you can add a domain whenever you have it.
        </p>

        <div class="mt-5 space-y-4">
          <div>
            <label for="name" class="label">Name</label>
            <input id="name" v-model="displayName" class="field" placeholder="My website" />
          </div>

          <div>
            <label for="domains" class="label">
              Web address <span class="font-normal text-ink-faint">(optional)</span>
            </label>
            <input
              id="domains"
              v-model="domains"
              class="field font-mono"
              placeholder="example.com, www.example.com"
            />
            <p class="hint">Separate several with commas. Leave empty to decide later.</p>
          </div>

          <!--
            Only meaningful when the web server serves the files itself. A Node
            app has its own routing, and adding a fallback there would swallow
            genuine 404s from its API.
          -->
          <label
            v-if="servesFiles"
            class="flex items-start gap-2.5 rounded-lg border border-line bg-black/20 p-4 text-sm"
          >
            <input v-model="spaFallback" type="checkbox" class="mt-0.5" />
            <span>
              <span class="block font-medium text-ink">This is a single-page app</span>
              <span class="mt-0.5 block text-ink-muted">
                Serves index.html for addresses that do not match a file, so refreshing a page
                inside the app works. Leave this off for an ordinary website.
              </span>
            </span>
          </label>

          <AlertMessage v-if="error">{{ error }}</AlertMessage>

          <div class="flex gap-2">
            <button type="button" class="btn btn-ghost" @click="step = backFromDomain">Back</button>
            <button
              v-if="hasSecrets"
              type="button"
              class="btn btn-primary flex-1"
              :disabled="!displayName"
              @click="step = 'secrets'"
            >
              Continue
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary flex-1"
              :disabled="!displayName || busy"
              @click="createSite"
            >
              <Loader v-if="busy" :size="14" class="animate-spin" aria-hidden="true" />
              {{ busy ? 'Creating\u2026' : 'Create website' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Secrets, for anything that runs a process. -->
      <template v-else-if="step === 'secrets'">
        <h2 class="text-lg font-semibold tracking-tight text-ink">Anything secret?</h2>
        <p class="mt-1 text-sm text-ink-muted">
          Database addresses, API keys and similar. These are stored encrypted and are only
          visible to your app.
        </p>

        <div class="mt-5 space-y-2">
          <div v-for="(row, index) in envRows" :key="index" class="flex gap-2">
            <input v-model="row.key" class="field max-w-56 font-mono" aria-label="Name"
                   placeholder="NAME" />
            <input v-model="row.value" type="password" class="field font-mono" aria-label="Value"
                   placeholder="value" />
            <button
              type="button"
              class="shrink-0 rounded-md p-2 text-ink-faint hover:bg-danger-soft hover:text-danger"
              :aria-label="`Remove ${row.key || 'this setting'}`"
              @click="envRows.splice(index, 1)"
            >
              <Trash2 :size="15" />
            </button>
          </div>

          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="envRows.push({ key: '', value: '' })"
          >
            <Plus :size="14" aria-hidden="true" /> Add another
          </button>
        </div>

        <AlertMessage v-if="error" class="mt-4">{{ error }}</AlertMessage>

        <div class="mt-6 flex gap-2">
          <button type="button" class="btn btn-ghost" @click="step = 'domain'">Back</button>
          <button type="button" class="btn btn-primary flex-1" :disabled="busy" @click="createSite">
            <Loader v-if="busy" :size="14" class="animate-spin" aria-hidden="true" />
            {{ busy ? 'Creating\u2026' : isGit ? 'Create and deploy' : 'Create website' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
