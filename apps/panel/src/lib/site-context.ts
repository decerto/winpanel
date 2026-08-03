import type { InjectionKey, Ref } from 'vue';
import type { api } from './api';

export type SiteDetail = Awaited<ReturnType<typeof api.sites.get.query>>;

/**
 * What a website's tabs are given by the layout above them.
 *
 * The site is fetched once, by the layout, and shared. Every tab asking for it
 * on mount would mean the name and status flicker each time you move between
 * Files and DNS, which makes the panel feel like four pages stapled together
 * rather than one website.
 */
export interface SiteContext {
  site: Ref<SiteDetail | null>;
  reload: () => Promise<void>;
  /** Starts a deployment. The layout renders the live log above every tab. */
  deploy: () => Promise<void>;
  deploying: Ref<boolean>;
}

export const siteContextKey = Symbol('site') as InjectionKey<SiteContext>;
