import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/index.js';
import { settings } from '../db/schema.js';
import type { ServiceStopIntentStore } from './service-manager.js';

export const SERVICE_STOP_INTENTS_KEY = 'services.intentionalStops';

export function createServiceStopIntentStore(db: DatabaseHandle): ServiceStopIntentStore {
  return {
    load: () => {
      try {
        const value = db.db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, SERVICE_STOP_INTENTS_KEY))
          .get()?.value;

        return Array.isArray(value)
          ? value.filter((id): id is string => typeof id === 'string')
          : [];
      } catch {
        return [];
      }
    },
    save: (ids) => {
      const value = [...ids];
      db.db
        .insert(settings)
        .values({ key: SERVICE_STOP_INTENTS_KEY, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        })
        .run();
    },
  };
}