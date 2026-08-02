import { createRouter, createWebHistory } from 'vue-router';
import { api } from './lib/api';

/**
 * Routes are lazily loaded so the first paint after sign-in is fast even on a
 * slow connection to a remote server.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/health' },
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
    {
      path: '/sites/:slug',
      name: 'site-detail',
      component: () => import('./pages/SiteDetailPage.vue'),
      meta: { title: 'Website' },
    },
    {
      path: '/sites/:slug/files',
      name: 'site-files',
      component: () => import('./pages/FilesPage.vue'),
      meta: { title: 'Files' },
    },
    {
      path: '/email',
      name: 'email',
      component: () => import('./pages/MailPage.vue'),
      meta: { title: 'Email' },
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
    return { name: 'health' };
  }

  return true;
});
