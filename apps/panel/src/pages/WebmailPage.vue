<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ArrowLeft,
  Archive,
  Inbox,
  LogOut,
  Mail,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  Search,
  Send,
  Star,
  Trash2,
} from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import { formatBytes } from '../lib/format';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';

/**
 * Reading a mailbox from the panel.
 *
 * This exists because "your mailbox is ready" is not much use to somebody who
 * then has to install a mail program and type four server settings correctly
 * before they can see whether it works. Opening it here proves the mailbox
 * works, and covers the case of checking one message on a machine that is not
 * yours.
 *
 * It is deliberately not a replacement for Outlook or Thunderbird. There is no
 * offline copy, no calendar, no rules — for daily use a real mail program is
 * better, and the settings to configure one are on the website's Email tab.
 *
 * Signing in here is the *mailbox* password, not the panel's. Being able to
 * administer a server is not the same as being allowed to read the mail on it,
 * and the panel keeps that line: it can reset a mailbox password, which is
 * visible, but it cannot silently read a mailbox.
 */

const route = useRoute();

type Folder = Awaited<ReturnType<typeof api.webmail.folders.query>>[number];
type Message = Awaited<ReturnType<typeof api.webmail.messages.query>>['messages'][number];
type MessageDetail = Awaited<ReturnType<typeof api.webmail.message.query>>;

/**
 * Kept for the tab rather than the browser: closing the tab ends the sitting,
 * and the agent forgets the credential an hour after it was last used anyway.
 */
const TOKEN_KEY = 'winpanel.webmail.token';
const ADDRESS_KEY = 'winpanel.webmail.address';

const token = ref<string | null>(null);
const address = ref('');

const signInAddress = ref('');
const signInPassword = ref('');
const signingIn = ref(false);

const folders = ref<Folder[]>([]);
const folderId = ref('');
const messages = ref<Message[]>([]);
const total = ref(0);
const position = ref(0);
const search = ref('');

const open = ref<MessageDetail | null>(null);
const showPlainText = ref(false);

const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const composing = ref(false);
const draft = ref({ to: '', cc: '', subject: '', text: '', inReplyTo: null as string | null });

const PAGE_SIZE = 25;

/** Folders people expect at the top, in the order they expect them. */
const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
};

const ROLE_ICONS: Record<string, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: Pencil,
  archive: Archive,
  junk: Trash2,
  trash: Trash2,
};

const sortedFolders = computed(() =>
  [...folders.value].sort((a, b) => {
    const rank = (folder: Folder) =>
      folder.role ? (ROLE_ORDER[folder.role] ?? 6) : 7;
    return rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  }),
);

const currentFolder = computed(() => folders.value.find((folder) => folder.id === folderId.value));
const trashFolder = computed(() => folders.value.find((folder) => folder.role === 'trash'));
const inTrash = computed(() => currentFolder.value?.role === 'trash');

const lastPage = computed(() => Math.max(0, Math.ceil(total.value / PAGE_SIZE) - 1));
const page = computed(() => Math.floor(position.value / PAGE_SIZE));

function iconFor(folder: Folder): typeof Inbox {
  return (folder.role && ROLE_ICONS[folder.role]) || Mail;
}

function nameOf(person: { name: string | null; email: string }): string {
  return person.name ?? person.email;
}

function peopleOf(list: Array<{ name: string | null; email: string }>): string {
  if (list.length === 0) return '(nobody)';
  return list.map(nameOf).join(', ');
}

/** Today shows a time; this year shows a date; older shows the year too. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();

  if (sameDay) return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.getFullYear() === now.getFullYear()) {
    return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function forget(): void {
  token.value = null;
  folders.value = [];
  messages.value = [];
  open.value = null;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ADDRESS_KEY);
}

/** Every call funnels through here so an expired sitting ends cleanly. */
async function guard<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (err) {
    const message = describeError(err);
    error.value = message;

    // The agent forgets a credential after an hour idle, and the honest
    // answer to that is the sign-in form, not a page of failed requests.
    if (/sitting has ended|sign in/i.test(message)) forget();
    return null;
  }
}

async function signIn(): Promise<void> {
  signingIn.value = true;
  error.value = null;

  try {
    const result = await api.webmail.signIn.mutate({
      address: signInAddress.value.trim(),
      password: signInPassword.value,
    });

    token.value = result.token;
    address.value = result.address;
    sessionStorage.setItem(TOKEN_KEY, result.token);
    sessionStorage.setItem(ADDRESS_KEY, result.address);
    signInPassword.value = '';

    await loadFolders();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    signingIn.value = false;
  }
}

async function signOut(): Promise<void> {
  const current = token.value;
  forget();

  if (current) {
    await api.webmail.signOut.mutate({ token: current }).catch(() => undefined);
  }
}

async function loadFolders(): Promise<void> {
  if (!token.value) return;
  loading.value = true;

  const result = await guard(() => api.webmail.folders.query({ token: token.value! }));

  if (result) {
    folders.value = result;
    const inbox = result.find((folder) => folder.role === 'inbox') ?? result[0];
    folderId.value = folderId.value || inbox?.id || '';
  }

  loading.value = false;
  if (folderId.value) await loadMessages();
}

async function loadMessages(): Promise<void> {
  if (!token.value || !folderId.value) return;
  loading.value = true;

  const result = await guard(() =>
    api.webmail.messages.query({
      token: token.value!,
      mailboxId: folderId.value,
      position: position.value,
      limit: PAGE_SIZE,
      ...(search.value.trim() ? { search: search.value.trim() } : {}),
    }),
  );

  if (result) {
    messages.value = result.messages;
    total.value = result.total;
  }

  loading.value = false;
}

async function openMessage(message: Message): Promise<void> {
  open.value = null;
  showPlainText.value = false;
  loading.value = true;

  const result = await guard(() =>
    api.webmail.message.query({ token: token.value!, id: message.id }),
  );

  loading.value = false;
  if (!result) return;

  open.value = result;
  showPlainText.value = result.html === null;

  if (!message.seen) {
    message.seen = true;
    await guard(() =>
      api.webmail.setSeen.mutate({ token: token.value!, ids: [message.id], seen: true }),
    );
    await loadFolders();
  }
}

async function toggleFlag(message: Message): Promise<void> {
  message.flagged = !message.flagged;
  await guard(() =>
    api.webmail.setFlagged.mutate({
      token: token.value!,
      ids: [message.id],
      flagged: message.flagged,
    }),
  );
}

async function discard(id: string): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  // In the bin already, "delete" can only mean gone. Anywhere else it means
  // moved, the way it does in every other mail program.
  if (inTrash.value || !trashFolder.value) {
    if (!window.confirm('Delete this message permanently? It cannot be recovered.')) {
      busy.value = false;
      return;
    }
    await guard(() => api.webmail.destroy.mutate({ token: token.value!, ids: [id] }));
    notice.value = 'Message deleted.';
  } else {
    await guard(() =>
      api.webmail.move.mutate({
        token: token.value!,
        ids: [id],
        mailboxId: trashFolder.value!.id,
      }),
    );
    notice.value = 'Moved to the bin.';
  }

  open.value = null;
  busy.value = false;
  await loadMessages();
  await loadFolders();
}

function compose(): void {
  draft.value = { to: '', cc: '', subject: '', text: '', inReplyTo: null };
  composing.value = true;
  open.value = null;
}

function reply(): void {
  const message = open.value;
  if (!message) return;

  const to = message.replyTo.length > 0 ? message.replyTo : message.from;
  const quoted = (message.text ?? message.preview ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  draft.value = {
    to: to.map((person) => person.email).join(', '),
    cc: '',
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    text: `\n\nOn ${new Date(message.receivedAt).toLocaleString()}, ${peopleOf(
      message.from,
    )} wrote:\n${quoted}`,
    inReplyTo: null,
  };
  composing.value = true;
  open.value = null;
}

/** `Someone <a@b.com>, c@d.com` — the way people actually type recipients. */
function parseAddresses(value: string): Array<{ name: string | null; email: string }> {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const angled = /^(.*?)<([^>]+)>$/.exec(entry);
      if (!angled) return { name: null, email: entry };
      return { name: angled[1]!.trim().replace(/^"|"$/g, '') || null, email: angled[2]!.trim() };
    });
}

async function send(): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;

  const result = await guard(() =>
    api.webmail.send.mutate({
      token: token.value!,
      to: parseAddresses(draft.value.to),
      cc: parseAddresses(draft.value.cc),
      subject: draft.value.subject,
      text: draft.value.text,
      inReplyTo: draft.value.inReplyTo,
      references: [],
    }),
  );

  busy.value = false;

  if (result) {
    notice.value = result.note;
    composing.value = false;
    await loadFolders();
  }
}

/**
 * Downloads an attachment.
 *
 * It comes through the API as bytes rather than a link, because the mail
 * server is only reachable from this machine — the browser has nowhere to
 * fetch it from directly.
 */
async function download(attachment: {
  blobId: string;
  name: string;
  type: string;
  size: number;
}): Promise<void> {
  busy.value = true;
  error.value = null;

  const result = await guard(() =>
    api.webmail.attachment.query({
      token: token.value!,
      blobId: attachment.blobId,
      size: attachment.size,
      name: attachment.name,
      type: attachment.type,
    }),
  );

  busy.value = false;
  if (!result) return;

  const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: result.type }));

  const link = document.createElement('a');
  link.href = url;
  link.download = result.name;
  link.click();
  URL.revokeObjectURL(url);
}

function goToPage(next: number): void {
  position.value = Math.max(0, Math.min(next, lastPage.value)) * PAGE_SIZE;
  void loadMessages();
}

watch(folderId, () => {
  position.value = 0;
  open.value = null;
  composing.value = false;
  void loadMessages();
});

onMounted(() => {
  const stored = sessionStorage.getItem(TOKEN_KEY);
  signInAddress.value = (route.query['address'] as string | undefined) ?? '';

  if (stored) {
    token.value = stored;
    address.value = sessionStorage.getItem(ADDRESS_KEY) ?? '';
    void loadFolders();
  }
});
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5">
    <PageHeader
      title="Webmail"
      :description="
        token
          ? `Signed in as ${address}.`
          : 'Open a mailbox on this server to read and send email.'
      "
    >
      <template #actions>
        <div v-if="token" class="flex items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="loading"
            @click="loadFolders"
          >
            <RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
            Refresh
          </button>
          <button type="button" class="btn btn-primary btn-sm" @click="compose">
            <Pencil :size="14" aria-hidden="true" /> Write
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="signOut">
            <LogOut :size="14" aria-hidden="true" /> Close mailbox
          </button>
        </div>
      </template>
    </PageHeader>

    <AlertMessage v-if="error">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

    <!-- Signing in is the mailbox password, which the panel never stores. -->
    <section v-if="!token" class="card mx-auto max-w-md p-6">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <Inbox :size="15" class="text-ink-faint" aria-hidden="true" /> Open a mailbox
      </h2>
      <p class="mt-1 text-sm text-ink-muted">
        Use the email address and the password that was shown when the mailbox was created. This
        is not your panel sign-in.
      </p>

      <form class="mt-4 space-y-3" @submit.prevent="signIn">
        <div>
          <label for="webmail-address" class="label">Email address</label>
          <input
            id="webmail-address"
            v-model="signInAddress"
            type="email"
            class="field font-mono"
            autocomplete="username"
            placeholder="you@example.com"
            required
          />
        </div>

        <div>
          <label for="webmail-password" class="label">Mailbox password</label>
          <input
            id="webmail-password"
            v-model="signInPassword"
            type="password"
            class="field"
            autocomplete="current-password"
            required
          />
        </div>

        <button
          type="submit"
          class="btn btn-primary w-full"
          :disabled="signingIn || signInAddress.trim().length === 0"
        >
          {{ signingIn ? 'Opening\u2026' : 'Open mailbox' }}
        </button>
      </form>

      <p class="hint mt-4">
        Lost the password? Reset it on the website's Email tab — the new one is shown once, and
        the old one stops working.
      </p>
    </section>

    <div v-else class="grid gap-4 lg:grid-cols-[13rem_1fr]">
      <!-- Folders -->
      <nav class="card h-fit overflow-hidden" aria-label="Mail folders">
        <ul class="divide-y divide-line">
          <li v-for="folder in sortedFolders" :key="folder.id">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm
                     hover:bg-white/5"
              :class="folder.id === folderId ? 'bg-white/5 text-ink' : 'text-ink-muted'"
              :aria-current="folder.id === folderId ? 'true' : undefined"
              @click="folderId = folder.id"
            >
              <component :is="iconFor(folder)" :size="15" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ folder.name }}</span>
              <span
                v-if="folder.unread > 0"
                class="rounded-full bg-brand/20 px-1.5 py-0.5 text-[11px] font-semibold
                       text-brand-bright"
              >
                {{ folder.unread }}
              </span>
            </button>
          </li>
        </ul>
      </nav>

      <!-- Compose -->
      <section v-if="composing" class="card p-5">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-ink">New message</h2>
          <button type="button" class="btn btn-ghost btn-sm" @click="composing = false">
            <ArrowLeft :size="14" aria-hidden="true" /> Back
          </button>
        </div>

        <form class="mt-4 space-y-3" @submit.prevent="send">
          <div>
            <label for="draft-to" class="label">To</label>
            <input
              id="draft-to"
              v-model="draft.to"
              class="field font-mono"
              placeholder="someone@example.com, another@example.com"
              required
            />
          </div>

          <div>
            <label for="draft-cc" class="label">Copy to (optional)</label>
            <input id="draft-cc" v-model="draft.cc" class="field font-mono" />
          </div>

          <div>
            <label for="draft-subject" class="label">Subject</label>
            <input id="draft-subject" v-model="draft.subject" class="field" />
          </div>

          <div>
            <label for="draft-text" class="label">Message</label>
            <textarea id="draft-text" v-model="draft.text" rows="12" class="field font-sans" />
          </div>

          <button
            type="submit"
            class="btn btn-primary"
            :disabled="busy || draft.to.trim().length === 0"
          >
            <Send :size="14" aria-hidden="true" /> {{ busy ? 'Sending\u2026' : 'Send' }}
          </button>
        </form>
      </section>

      <!-- One message -->
      <section v-else-if="open" class="card overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <button type="button" class="btn btn-ghost btn-sm" @click="open = null">
            <ArrowLeft :size="14" aria-hidden="true" /> Back
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="reply">
            <Reply :size="14" aria-hidden="true" /> Reply
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm ml-auto"
            :disabled="busy"
            @click="discard(open.id)"
          >
            <Trash2 :size="14" aria-hidden="true" />
            {{ inTrash || !trashFolder ? 'Delete' : 'Move to bin' }}
          </button>
        </div>

        <header class="border-b border-line px-5 py-4">
          <h2 class="text-base font-semibold text-ink">{{ open.subject }}</h2>
          <p class="mt-1 text-sm text-ink-muted">
            From <span class="text-ink">{{ peopleOf(open.from) }}</span>
            to <span class="text-ink">{{ peopleOf(open.to) }}</span>
          </p>
          <p v-if="open.cc.length > 0" class="text-sm text-ink-muted">
            Copied to {{ peopleOf(open.cc) }}
          </p>
          <p class="mt-1 text-xs text-ink-faint">
            {{ new Date(open.receivedAt).toLocaleString() }} · {{ formatBytes(open.size) }}
          </p>

          <div v-if="open.attachments.length > 0" class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="attachment in open.attachments"
              :key="attachment.blobId"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click="download(attachment)"
            >
              <Paperclip :size="13" aria-hidden="true" />
              {{ attachment.name }}
              <span class="text-ink-faint">({{ formatBytes(attachment.size) }})</span>
            </button>
          </div>

          <div v-if="open.html && open.text" class="mt-3">
            <button
              type="button"
              class="text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
              @click="showPlainText = !showPlainText"
            >
              {{ showPlainText ? 'Show the formatted message' : 'Show the plain text version' }}
            </button>
          </div>
        </header>

        <AlertMessage v-if="open.truncated" tone="info" class="m-5">
          This message is very long, so only the beginning is shown here. Open it in a mail
          program to read the rest.
        </AlertMessage>

        <!--
          Message HTML is somebody else's, so it is rendered in a frame with
          scripting switched off and its own origin. The panel can create
          websites and change DNS; a message must never be able to reach that.
        -->
        <iframe
          v-if="open.html && !showPlainText"
          :srcdoc="open.html"
          sandbox=""
          referrerpolicy="no-referrer"
          class="h-[60vh] w-full bg-white"
          title="Message"
        />
        <pre
          v-else
          class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-sans
                 text-sm text-ink"
          >{{ open.text ?? open.preview }}</pre
        >
      </section>

      <!-- The list -->
      <section v-else class="card overflow-hidden">
        <div class="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <h2 class="text-sm font-semibold text-ink">{{ currentFolder?.name ?? 'Mail' }}</h2>

          <form class="ml-auto flex items-center gap-2" @submit.prevent="goToPage(0)">
            <label for="webmail-search" class="sr-only">Search this folder</label>
            <input
              id="webmail-search"
              v-model="search"
              class="field w-48 py-1 text-xs"
              placeholder="Search this folder"
            />
            <button type="submit" class="btn btn-ghost btn-sm">
              <Search :size="14" aria-hidden="true" /> Search
            </button>
          </form>
        </div>

        <LoadingBlock v-if="loading" class="h-40 bg-surface" />

        <EmptyState
          v-else-if="messages.length === 0"
          :icon="Inbox"
          title="Nothing here"
          :description="
            search.trim()
              ? 'No messages in this folder match that search.'
              : 'This folder is empty.'
          "
          flush
        />

        <ul v-else class="divide-y divide-line">
          <li
            v-for="message in messages"
            :key="message.id"
            class="flex items-center gap-3 px-5 py-3 hover:bg-white/5"
          >
            <button
              type="button"
              class="rounded-md p-1 text-ink-faint hover:text-warn"
              :class="message.flagged ? 'text-warn' : ''"
              :aria-label="message.flagged ? 'Remove star' : 'Add star'"
              @click.stop="toggleFlag(message)"
            >
              <Star :size="14" :fill="message.flagged ? 'currentColor' : 'none'" />
            </button>

            <button
              type="button"
              class="flex min-w-0 flex-1 items-baseline gap-3 text-left"
              @click="openMessage(message)"
            >
              <span
                class="w-40 shrink-0 truncate text-sm"
                :class="message.seen ? 'text-ink-muted' : 'font-semibold text-ink'"
              >
                {{ peopleOf(message.from) }}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">
                <span :class="message.seen ? 'text-ink-muted' : 'font-semibold text-ink'">
                  {{ message.subject }}
                </span>
                <span class="text-ink-faint"> — {{ message.preview }}</span>
              </span>
              <Paperclip
                v-if="message.hasAttachment"
                :size="13"
                class="shrink-0 text-ink-faint"
                aria-hidden="true"
              />
              <span class="w-20 shrink-0 text-right text-xs text-ink-faint">
                {{ when(message.receivedAt) }}
              </span>
            </button>
          </li>
        </ul>

        <div
          v-if="lastPage > 0"
          class="flex items-center justify-between gap-3 border-t border-line px-5 py-3"
        >
          <span class="text-xs text-ink-faint">
            {{ position + 1 }}–{{ Math.min(position + messages.length, total) }} of {{ total }}
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="page === 0"
              @click="goToPage(page - 1)"
            >
              Newer
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="page >= lastPage"
              @click="goToPage(page + 1)"
            >
              Older
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
