<script setup lang="ts">
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  Activity,
  ChevronRight,
  Globe,
  Gamepad2,
  History,
  Inbox,
  LogOut,
  Mail,
  Menu,
  ServerCog,
  Settings,
  ShieldCheck,
  UsersRound,
  X,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { roleAtLeast, type UserRole } from '@winpanel/shared';
import { api } from './lib/api';
import ServerReadyBanner from './components/ServerReadyBanner.vue';

/**
 * Application shell: persistent sidebar, top bar, content area.
 *
 * Navigation is deliberately server-shaped rather than feature-shaped. Files
 * and DNS belong to a website, not to the server, so they are not here — you
 * reach them by opening a website, the same way a filing cabinet has no
 * drawer labelled "paper".
 *
 * Wording throughout uses what things do rather than what they are called
 * internally — "Websites", not "Sites"; "Email", not "Stalwart".
 */

const route = useRoute();
const router = useRouter();

const NAV = [
  { to: '/sites', label: 'Websites', icon: Globe, hint: 'Everything you host' },
  { to: '/game-servers', label: 'Game Servers', icon: Gamepad2, hint: 'Games you host' },
  { to: '/health', label: 'Server health', icon: Activity, hint: 'Checks and fixes', minRole: 'admin' },
  {
    to: '/health/websites',
    label: 'Website health',
    icon: Globe,
    hint: 'Is each website answering',
    minRole: 'admin',
  },
  { to: '/email', label: 'Email', icon: Mail, hint: 'Mailboxes and delivery', minRole: 'admin' },
  { to: '/webmail', label: 'Webmail', icon: Inbox, hint: 'Read and send mail' },
  { to: '/security', label: 'Security', icon: ShieldCheck, hint: 'Sign-in protection' },
  { to: '/people', label: 'People', icon: UsersRound, hint: 'Accounts and limits', minRole: 'admin' },
  {
    to: '/sign-ins',
    label: 'Sign-in activity',
    icon: History,
    hint: 'Sessions and attempts',
    minRole: 'superadmin',
  },
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Connected accounts', minRole: 'admin' },
] as const satisfies ReadonlyArray<{
  to: string;
  label: string;
  icon: unknown;
  hint: string;
  minRole?: UserRole;
}>;

// Entries above someone's level are hidden rather than shown-and-refused: a
// customer who only manages their own website has no use for a door they
// cannot open.
const nav = computed(() =>
  NAV.filter(
    (item) =>
      item.to !== '/game-servers' || gameServersEnabled.value,
  ).filter(
    (item) =>
      !('minRole' in item) || (role.value !== null && roleAtLeast(role.value, item.minRole)),
  ),
);

const title = computed(() => (route.meta['title'] as string | undefined) ?? 'WinPanel');

/**
 * The trail in the top bar.
 *
 * Pages state their own heading, so repeating it here would say the same thing
 * twice. What the bar is good for is saying where you are while the page is
 * scrolled away from its heading — which matters most inside a website, where
 * four tabs all look alike.
 */
const crumbs = computed<Array<{ label: string; to?: string }>>(() => {
  if (route.path.startsWith('/game-servers')) {
    const trail: Array<{ label: string; to?: string }> = [
      { label: 'Game Servers', to: '/game-servers' },
    ];
    if (route.name === 'new-game-server') trail.push({ label: 'Choose a game' });
    const slug = route.params['slug'];
    if (typeof slug === 'string' && route.name !== 'new-game-server') trail.push({ label: slug });
    return trail;
  }

  if (!route.path.startsWith('/sites')) return [{ label: title.value }];

  const trail: Array<{ label: string; to?: string }> = [{ label: 'Websites', to: '/sites' }];
  const slug = route.params['slug'];

  if (route.name === 'new-site') trail.push({ label: 'Add a website' });
  else if (typeof slug === 'string') trail.push({ label: slug });

  return trail;
});

// Sign-in and first-run setup are full-screen: there is nothing useful to
// navigate to until you are through them.
const bare = computed(() => route.meta['bare'] === true);

const username = ref('');
const role = ref<UserRole | null>(null);
const gameServersEnabled = ref(false);

async function loadMe(): Promise<void> {
  try {
    const [user, feature] = await Promise.all([
      api.auth.me.query(),
      api.gameServers.feature.query(),
    ]);
    username.value = user?.username ?? '';
    role.value = user?.role ?? null;
    gameServersEnabled.value = feature.enabled;
  } catch {
    // Each page reports a dead agent in its own way; the shell staying as it
    // is beats a sidebar that empties itself over one failed request.
  }
}

/*
 * Asked again every time the shell comes back into view.
 *
 * The shell is created once, while the panel is usually still on the sign-in
 * screen — where `me` is nobody. Signing in swaps the page underneath it but
 * does not rebuild it, so a single fetch at start-up would leave the sidebar
 * believing the visitor has no role and hiding every entry that needs one
 * until the next full reload.
 */
watch(
  bare,
  (isBare) => {
    if (!isBare) void loadMe();
  },
  { immediate: true },
);

const drawerOpen = ref(false);
watch(() => route.fullPath, () => (drawerOpen.value = false));

async function signOut(): Promise<void> {
  await api.auth.logout.mutate().catch(() => undefined);
  await router.push('/login');
  // The panel caches nothing sensitive in memory beyond this point, but a
  // full reload is the only way to be sure of it.
  window.location.reload();
}

/**
 * Whether a nav entry is the current page.
 *
 * Prefix matching lets `/sites/acme` light up "Websites", but it also means
 * `/health/websites` matches both "Server health" (`/health`) and "Website
 * health" (`/health/websites`). When two entries match, only the longest —
 * the most specific — is the current one, or both would light up at once.
 */
function isCurrent(to: string): boolean {
  const matches = route.path === to || route.path.startsWith(`${to}/`);
  if (!matches) return false;

  return !nav.value.some(
    (other) => other.to !== to && other.to.length > to.length && route.path.startsWith(other.to),
  );
}
</script>

<template>
  <RouterView v-if="bare" />

  <div v-else class="flex min-h-screen">
    <!-- Backdrop for the narrow-screen drawer. -->
    <div
      v-if="drawerOpen"
      class="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
      @click="drawerOpen = false"
    />

    <aside
      class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line
             bg-canvas/85 backdrop-blur-xl transition-transform md:static md:translate-x-0"
      :class="drawerOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="flex h-16 items-center gap-2.5 px-5">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-b
                 from-brand to-brand-strong shadow-brand"
        >
          <ServerCog :size="17" class="text-white" aria-hidden="true" />
        </span>
        <span class="text-[0.95rem] font-semibold tracking-tight">WinPanel</span>

        <button
          type="button"
          class="ml-auto text-ink-muted hover:text-ink md:hidden"
          aria-label="Close menu"
          @click="drawerOpen = false"
        >
          <X :size="18" />
        </button>
      </div>

      <nav class="flex-1 overflow-y-auto px-3 py-2" aria-label="Main">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="group relative mb-1 flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors"
          :class="
            isCurrent(item.to)
              ? 'bg-brand-soft/70 text-brand-bright'
              : 'text-ink-muted hover:bg-white/5 hover:text-ink'
          "
        >
          <!-- The active marker is a shape as well as a colour. -->
          <span
            v-if="isCurrent(item.to)"
            class="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-bright"
            aria-hidden="true"
          />
          <component :is="item.icon" :size="17" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ item.label }}</span>
            <span class="block truncate text-xs text-ink-faint">{{ item.hint }}</span>
          </span>
        </RouterLink>
      </nav>

      <div class="border-t border-line p-3">
        <div class="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft
                   text-xs font-semibold text-brand-bright"
            aria-hidden="true"
          >
            {{ (username || '?').slice(0, 1).toUpperCase() }}
          </span>
          <span class="min-w-0 flex-1 truncate text-sm text-ink-muted">
            {{ username || 'Signed in' }}
          </span>
          <button
            type="button"
            class="shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-white/5 hover:text-danger"
            aria-label="Sign out"
            @click="signOut"
          >
            <LogOut :size="15" />
          </button>
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line
               bg-canvas/70 px-4 backdrop-blur-xl md:px-8"
      >
        <button
          type="button"
          class="rounded-md p-2 text-ink-muted hover:bg-white/5 hover:text-ink md:hidden"
          aria-label="Open menu"
          @click="drawerOpen = true"
        >
          <Menu :size="18" />
        </button>

        <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
          <template v-for="(crumb, index) in crumbs" :key="crumb.label">
            <ChevronRight
              v-if="index > 0"
              :size="14"
              class="shrink-0 text-ink-faint"
              aria-hidden="true"
            />
            <RouterLink
              v-if="crumb.to && index < crumbs.length - 1"
              :to="crumb.to"
              class="shrink-0 text-ink-muted hover:text-ink"
            >
              {{ crumb.label }}
            </RouterLink>
            <span v-else class="truncate font-medium text-ink" aria-current="page">
              {{ crumb.label }}
            </span>
          </template>
        </nav>
      </header>

      <main class="mx-auto w-full max-w-[160rem] px-4 py-6 md:px-8 md:py-8">
        <ServerReadyBanner v-if="role !== null && roleAtLeast(role, 'admin')" />
        <RouterView />
      </main>
    </div>
  </div>
</template>
