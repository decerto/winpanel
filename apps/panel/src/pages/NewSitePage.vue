<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  FileCode,
  FolderTree,
  GitBranch,
  KeyRound,
  Loader,
  Plus,
  Server,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import {
  deployKeyPageFor,
  hostLabelFor,
  toHttpsUrl,
  toSshUrl,
  tokenPageFor,
} from '../lib/repo-url';
import AlertMessage from '../components/AlertMessage.vue';
import HowTo from '../components/HowTo.vue';

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

/**
 * How the server proves it may read the repository.
 *
 * A deploy key is the default for a private repository because it is the
 * thing that cannot go wrong later: it reads one repository, it belongs to
 * the server rather than to a person, and it does not expire. A token is
 * offered as well because some hosts and some company policies leave no
 * choice, but it is not what we suggest first.
 */
type Access = 'public' | 'key' | 'token';
const access = ref<Access>('public');

const deployKey = ref<{ keyId: string; publicKey: string; fingerprint: string } | null>(null);
const generatingKey = ref(false);
const keyCopied = ref(false);

const displayName = ref('');
const domains = ref('');
const spaFallback = ref(false);

const hostLabel = computed(() => hostLabelFor(repoUrl.value));
const deployKeyUrl = computed(() => deployKeyPageFor(repoUrl.value));
const tokenHelpUrl = computed(() => tokenPageFor(repoUrl.value));

/**
 * A deploy key only authenticates SSH, so the address has to be the SSH one.
 * Converting it here means the user can paste whichever address their host's
 * copy button gave them and still end up with something that works.
 */
watch(access, async (next) => {
  testResult.value = null;

  if (repoUrl.value.trim()) {
    repoUrl.value = next === 'key' ? toSshUrl(repoUrl.value) : toHttpsUrl(repoUrl.value);
  }

  if (next === 'key' && !deployKey.value) await createDeployKey();
  if (next !== 'token') token.value = '';
});

// Typing the address after choosing a deploy key should not undo the switch.
async function createDeployKey(): Promise<void> {
  generatingKey.value = true;
  error.value = null;

  try {
    deployKey.value = await api.sites.deployKey.mutate();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    generatingKey.value = false;
  }
}

async function copyDeployKey(): Promise<void> {
  if (!deployKey.value) return;

  try {
    await navigator.clipboard.writeText(deployKey.value.publicKey);
    keyCopied.value = true;
    setTimeout(() => (keyCopied.value = false), 1500);
  } catch {
    // Clipboard access can be refused; the key is selectable in the box.
  }
}

const canContinue = computed(() => {
  if (repoUrl.value.trim().length === 0) return false;
  if (access.value === 'token') return token.value.length > 0;
  if (access.value === 'key') return deployKey.value !== null;
  return true;
});

/** Only sent when it exists, so an expired key is not silently ignored. */
const credentials = computed(() => ({
  ...(access.value === 'token' && token.value ? { token: token.value } : {}),
  ...(access.value === 'key' && deployKey.value ? { deployKeyId: deployKey.value.keyId } : {}),
}));

const busy = ref(false);
const error = ref<string | null>(null);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

type Inspection = Awaited<ReturnType<typeof api.sites.inspect.mutate>>;
const inspection = ref<Inspection | null>(null);

/** Detected from the lockfile, but the user gets the last word. */
const packageManager = ref<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm');

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
      ...credentials.value,
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
      ...credentials.value,
    });

    inspection.value = result;

    // Pre-fill from what was found, so the remaining steps are mostly reading.
    envRows.value = result.manifest.envVars.map((key) => ({ key, value: '' }));
    packageManager.value = result.manifest.packageManager;

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
          ...credentials.value,
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
      ...(isGit.value ? { packageManager: packageManager.value } : {}),
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

/**
 * What to do once the website exists.
 *
 * Creating a website is the easy half; knowing where to put the files is the
 * half people get stuck on, and it is different for every kind. Saying it
 * before the button is pressed costs nothing and saves a support message.
 */
const afterCreation = computed<{ title: string; steps: string[] }>(() => {
  switch (kind.value) {
    case 'git':
      return {
        title: 'What happens next',
        steps: [
          'The panel clones your repository and runs the build steps it found.',
          'Open the website and use its preview link to check it works.',
          'Press "Pull now" on the Git tab whenever you push new commits.',
        ],
      };
    case 'node':
      return {
        title: 'What happens next',
        steps: [
          'The panel writes a small working Node server and starts it.',
          'Open the Files tab to edit the code.',
          'Press Restart on the App tab to pick up your changes.',
        ],
      };
    case 'upload':
      return {
        title: 'What happens next',
        steps: [
          'The panel creates an empty folder for this website.',
          'Open the Files tab and upload your files, or drop in a zip.',
          'Anything named index.html is what visitors see first.',
        ],
      };
    default:
      return {
        title: 'What happens next',
        steps: [
          'The panel creates the folder and writes a starter page.',
          'Open the Files tab to edit index.html, or replace it with your own.',
          'Changes are live as soon as you save them.',
        ],
      };
  }
});

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
  <div class="mx-auto w-full max-w-2xl">
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
              :placeholder="
                access === 'key'
                  ? 'git@github.com:you/your-project.git'
                  : 'https://github.com/you/your-project.git'
              "
            />
            <p class="hint">
              Paste whichever address the
              <template v-if="repoUrl">{{ hostLabel }}</template>
              <template v-else>code host</template>
              copy button gives you. It is changed to match the sign-in method below if it needs
              to be.
            </p>
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
            <legend class="px-1 text-sm font-medium text-ink">How should the server sign in?</legend>

            <div class="space-y-2">
              <label
                class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm
                       transition-colors"
                :class="
                  access === 'public'
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-line hover:border-brand/60'
                "
              >
                <input v-model="access" type="radio" value="public" class="mt-1" />
                <span>
                  <span class="block font-medium text-ink">It doesn't need to &mdash; it's public</span>
                  <span class="mt-0.5 block text-ink-muted">
                    Anyone can read this repository without signing in.
                  </span>
                </span>
              </label>

              <label
                class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm
                       transition-colors"
                :class="
                  access === 'key'
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-line hover:border-brand/60'
                "
              >
                <input v-model="access" type="radio" value="key" class="mt-1" />
                <span>
                  <span class="flex items-center gap-1.5 font-medium text-ink">
                    <KeyRound :size="14" class="text-brand-bright" aria-hidden="true" />
                    With a deploy key
                    <span
                      class="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold
                             uppercase tracking-wide text-brand-bright"
                    >
                      Recommended
                    </span>
                  </span>
                  <span class="mt-0.5 block text-ink-muted">
                    The panel makes a key, you paste it into this one repository. Read-only, never
                    expires, and gives away nothing else in your account.
                  </span>
                </span>
              </label>

              <label
                class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm
                       transition-colors"
                :class="
                  access === 'token'
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-line hover:border-brand/60'
                "
              >
                <input v-model="access" type="radio" value="token" class="mt-1" />
                <span>
                  <span class="block font-medium text-ink">With an access token</span>
                  <span class="mt-0.5 block text-ink-muted">
                    Use this if your organisation does not allow deploy keys. Tokens expire, and
                    the deploy stops working when they do.
                  </span>
                </span>
              </label>
            </div>

            <!-- Deploy key: the panel does its half, then says what yours is. -->
            <div v-if="access === 'key'" class="mt-4 space-y-3">
              <div>
                <label for="deploy-key" class="label">Your server's public key</label>
                <div class="flex gap-2">
                  <textarea
                    id="deploy-key"
                    :value="deployKey?.publicKey ?? ''"
                    readonly
                    rows="3"
                    class="field resize-none break-all font-mono text-xs"
                    :placeholder="generatingKey ? 'Making a key\u2026' : ''"
                    @focus="($event.target as HTMLTextAreaElement).select()"
                  ></textarea>
                  <button
                    type="button"
                    class="btn btn-ghost shrink-0 self-start"
                    :disabled="!deployKey"
                    @click="copyDeployKey"
                  >
                    <component
                      :is="keyCopied ? Check : Copy"
                      :size="14"
                      aria-hidden="true"
                    />
                    {{ keyCopied ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <p class="hint">
                  Only the half above leaves this server. The matching private half is stored
                  encrypted here and is never shown again.
                </p>
              </div>

              <HowTo :title="`Add this key to ${hostLabel}`">
                <li>
                  Copy the key above.
                </li>
                <li>
                  <template v-if="deployKeyUrl">
                    Open
                    <a :href="deployKeyUrl" target="_blank" rel="noreferrer noopener">
                      the repository's Deploy keys page
                      <ExternalLink :size="12" class="inline align-baseline" aria-hidden="true" />
                    </a>
                    and choose <strong>Add deploy key</strong>.
                  </template>
                  <template v-else>
                    Open the repository on {{ hostLabel }}, then
                    <strong>Settings &rarr; Deploy keys &rarr; Add deploy key</strong>.
                  </template>
                </li>
                <li>
                  Give it any title &mdash; <strong>WinPanel</strong> is a good one &mdash; and paste
                  the key into the box.
                </li>
                <li>
                  Leave <strong>Allow write access</strong> unticked. The panel only ever reads.
                </li>
                <li>
                  Save it, then press <strong>Test connection</strong> below to check it worked.
                </li>
              </HowTo>
            </div>

            <div v-if="access === 'token'" class="mt-4">
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

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <label for="new-site-package-manager" class="text-sm text-ink-muted">
              Run those steps with
            </label>
            <select
              id="new-site-package-manager"
              v-model="packageManager"
              class="field w-32 py-1.5"
            >
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">yarn</option>
              <option value="bun">bun</option>
            </select>
          </div>
          <p class="hint">
            Taken from the lockfile in your repository. Change it if you would rather this
            server used something else.
          </p>
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

          <!-- The half of the job that happens on somebody else's screen. -->
          <HowTo v-if="domainList.length > 0" title="How to point this address at the server">
            <li>
              Sign in wherever you bought <strong>{{ domainList[0] }}</strong> and open its DNS
              records.
            </li>
            <li>
              Add an <strong>A record</strong> for each address above, pointing at this server's
              public IP address.
            </li>
            <li>Save, then give it a few minutes to spread.</li>
            <li>
              Nothing else to do: the panel notices and gets an HTTPS certificate on its own. Until
              then, use the preview link on the website's page.
            </li>
          </HowTo>

          <HowTo v-else :title="afterCreation.title">
            <li v-for="line in afterCreation.steps" :key="line">{{ line }}</li>
          </HowTo>

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
