import { ref, watch, type Ref } from 'vue';

/**
 * A setting the browser remembers.
 *
 * Which view someone prefers is not worth a round trip to the server, but it
 * is worth remembering: being put back into a layout you did not choose, every
 * time you sign in, is a small insult repeated daily.
 *
 * Stored values are validated against the allowed set, so an old or hand-edited
 * value cannot leave the panel rendering nothing.
 */
export function usePreference<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): Ref<T> {
  const storageKey = `winpanel.${key}`;

  const initial = (() => {
    try {
      const stored = localStorage.getItem(storageKey) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      // Private browsing and locked-down group policies both refuse storage.
      return fallback;
    }
  })();

  const value = ref(initial) as Ref<T>;

  watch(value, (next) => {
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Not being able to remember the choice is not a reason to reject it.
    }
  });

  return value;
}
