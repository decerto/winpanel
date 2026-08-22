import { createRouter, createWebHistory } from 'vue-router';
import { roleAtLeast, type UserRole } from '@winpanel/shared';
import { api } from './lib/api';

/**
 * Routes are lazily loaded so the first paint after sign-in is fast even on a
 * slow connection to a remote server.
 *
 * `minRole` marks a page as belonging to whoever runs the server rather than
 * to whoever is hosted on it. It is a signpost, not a lock — the endpoints
 * behind each page are authorised on the server regardless.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Websites are what this server is for, so that is where you land.
    { path: '/', redirect: '/sites' },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('./pages/SetupPage.vue'),
      meta: { public: true, bare: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('./pages/LoginPage.vue'),
      meta: { public: true, bare: true },
    },
    {
      path: '/health',
      name: 'health',
      component: () => import('./pages/HealthPage.vue'),
      meta: { title: 'Server health', minRole: 'admin' },
    },
    {
      path: '/health/websites',
      name: 'website-health',
      component: () => import('./pages/WebsiteHealthPage.vue'),
      meta: { title: 'Website health', minRole: 'admin' },
    },
    {
      path: '/sites',
      name: 'sites',
      component: () => import('./pages/SitesPage.vue'),
      meta: { title: 'Websites' },
    },
    {
      path: '/game-servers',
      name: 'game-servers',
      component: () => import('./pages/GameServersPage.vue'),
      meta: { title: 'Game Servers' },
    },
    {
      path: '/game-servers/new',
      name: 'new-game-server',
      component: () => import('./pages/NewGameServerPage.vue'),
      meta: { title: 'Choose a game' },
    },
    {
      path: '/game-servers/:slug',
      name: 'game-server',
      component: () => import('./pages/GameServerPage.vue'),
      meta: { title: 'Game Server' },
    },
    {
      path: '/sites/new',
      name: 'new-site',
      component: () => import('./pages/NewSitePage.vue'),
      meta: { title: 'Add a website' },
    },
    /*
     * One website, with its tools as tabs beneath it.
     *
     * Files and DNS only mean anything in the context of a site, so they are
     * children of one rather than top-level destinations. The layout fetches
     * the site once and hands it down, so switching tabs does not re-ask.
     */
    {
      path: '/sites/:slug',
      component: () => import('./pages/SiteLayout.vue'),
      meta: { title: 'Website' },
      children: [
        {
          path: '',
          name: 'site-detail',
          component: () => import('./pages/site/SiteOverviewPage.vue'),
        },
        {
          path: 'files',
          name: 'site-files',
          component: () => import('./pages/site/SiteFilesPage.vue'),
        },
        {
          path: 'git',
          name: 'site-git',
          component: () => import('./pages/site/SiteGitPage.vue'),
        },
        {
          path: 'app',
          name: 'site-app',
          component: () => import('./pages/site/SiteAppPage.vue'),
        },
        {
          path: 'php',
          name: 'site-php',
          component: () => import('./pages/site/SitePhpPage.vue'),
        },
        {
          path: 'databases',
          name: 'site-databases',
          component: () => import('./pages/site/SiteDatabasesPage.vue'),
        },
        {
          path: 'traffic',
          name: 'site-traffic',
          component: () => import('./pages/site/SiteTrafficPage.vue'),
        },
        {
          path: 'dns',
          name: 'site-dns',
          component: () => import('./pages/site/SiteDnsPage.vue'),
        },
        {
          path: 'ssl',
          name: 'site-ssl',
          component: () => import('./pages/site/SiteSslPage.vue'),
        },
        {
          path: 'email',
          name: 'site-email',
          component: () => import('./pages/site/SiteEmailPage.vue'),
        },
        {
          path: 'settings',
          name: 'site-settings',
          component: () => import('./pages/site/SiteSettingsPage.vue'),
        },
      ],
    },
    {
      path: '/email',
      name: 'email',
      component: () => import('./pages/MailPage.vue'),
      meta: { title: 'Email', minRole: 'admin' },
    },
    {
      path: '/webmail',
      name: 'webmail',
      component: () => import('./pages/WebmailPage.vue'),
      meta: { title: 'Webmail' },
    },
    {
      path: '/security',
      name: 'security',
      component: () => import('./pages/SecurityPage.vue'),
      meta: { title: 'Security' },
    },
    {
      path: '/people',
      name: 'people',
      component: () => import('./pages/PeoplePage.vue'),
      meta: { title: 'People', minRole: 'admin' },
    },
    {
      path: '/sign-ins',
      name: 'access',
      component: () => import('./pages/AccessPage.vue'),
      meta: { title: 'Sign-in activity', minRole: 'superadmin' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./pages/SettingsPage.vue'),
      meta: { title: 'Settings', minRole: 'admin' },
    },
  ],
});

/**
 * Client-side gate.
 *
 * A convenience, not a security boundary: every endpoint is authorised on the
 * server regardless of what the browser believes. Its job is to send people to
 * the right screen rather than showing an empty page full of failed requests.
 */
router.beforeEach(async (to) => {
  let state: Awaited<ReturnType<typeof api.auth.state.query>>;

  try {
    state = await api.auth.state.query();
  } catch {
    // If the agent cannot be reached, let the page render and show its own
    // error rather than bouncing between routes.
    return true;
  }

  if (state.needsSetup) {
    return to.name === 'setup' ? true : { name: 'setup' };
  }

  if (!state.signedIn) {
    return to.meta['public'] ? true : { name: 'login' };
  }

  // Already signed in: no reason to sit on the sign-in screen.
  if (to.name === 'login' || to.name === 'setup') {
    return { name: 'sites' };
  }

  // Pages that belong to whoever runs the server. The server refuses these
  // calls regardless; this just avoids showing a screen made entirely of
  // errors.
  const minRole = to.meta['minRole'] as UserRole | undefined;
  if (minRole !== undefined && !(state.user && roleAtLeast(state.user.role, minRole))) {
    return { name: 'sites' };
  }

  return true;
});
