import { onMounted, ref, type Ref } from 'vue';
import { api } from './api';

/**
 * Which optional pieces the server has installed.
 *
 * The panel offers a great deal — PHP sites, WordPress, a choice of package
 * managers, git deploys, a database browser — and none of it works until the
 * matching program is on the machine. Asking once and sharing the answer keeps
 * every page consistent, so no dropdown or button offers something that would
 * only fail when pressed.
 */

export interface RuntimeStatus {
  php: boolean;
  mariadb: boolean;
  composer: boolean;
  adminer: boolean;
  git: boolean;
  pnpm: boolean;
  yarn: boolean;
  bun: boolean;
  node: boolean;
}

export interface UseRuntimeStatus {
  /** Null until the answer arrives; treat null as "not known yet". */
  status: Ref<RuntimeStatus | null>;
  /** True once the server has answered, whether or not it succeeded. */
  loaded: Ref<boolean>;
  /** True when a piece is installed; false while unknown, so nothing is offered early. */
  has: (key: keyof RuntimeStatus) => boolean;
}

export function useRuntimeStatus(): UseRuntimeStatus {
  const status = ref<RuntimeStatus | null>(null);
  const loaded = ref(false);

  onMounted(async () => {
    try {
      status.value = await api.sites.runtimeStatus.query();
    } catch {
      // Leave it unknown; the page simply keeps its optional choices hidden.
    } finally {
      loaded.value = true;
    }
  });

  const has = (key: keyof RuntimeStatus): boolean => status.value?.[key] === true;

  return { status, loaded, has };
}
