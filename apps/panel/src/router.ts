import { createRouter, createWebHistory } from 'vue-router';
import { api } from './lib/api';

/**
 * Routes are lazily loaded so the first paint after sign-in is fast even on a
 * slow connection to a remote server.
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
      meta: { title: 'Server health' },
    },
    {
      path: '/sites',
      name: 'sites',
      component: () => import('./pages/SitesPage.vue'),
      meta: { title: 'Websites' },
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
      meta: { title: 'Email' },
    },
    {
      path: '/security',
      name: 'security',
      component: () => import('./pages/SecurityPage.vue'),
      meta: { title: 'Security' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./pages/SettingsPage.vue'),
      meta: { title: 'Settings' },
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

  return true;
});
