import type { CheckCategory, CheckResult, CheckState } from '@winpanel/shared';
import { rollUpState } from '@winpanel/shared';

/**
 * The check engine behind every status indicator in the panel.
 *
 * One definition per thing that can be wrong, surfaced in several places:
 * first-run setup, the Health page, Server Setup, and each site's own status
 * badge. Defining a check once and rendering it in four places is what keeps
 * the Health page honest — there is no second, drifting copy of "is Caddy
 * running".
 *
 * Every check must answer three questions in plain English: what is this,
 * what is wrong, and what will fix it.
 */

export interface CheckDefinition {
  id: string;
  category: CheckCategory;
  name: string;
  plainDescription: string;
  /** How long a result stays fresh. Cheap checks re-run often. */
  ttlSeconds: number;
  run: () => Promise<CheckOutcome>;
}

export interface CheckOutcome {
  state: CheckState;
  detail?: string;
  reason?: string;
  fix?: CheckResult['fix'];
}

export class CheckEngine {
  readonly #definitions = new Map<string, CheckDefinition>();
  readonly #cache = new Map<string, CheckResult>();

  register(definition: CheckDefinition): void {
    this.#definitions.set(definition.id, definition);
  }

  registerAll(definitions: readonly CheckDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  list(): readonly CheckDefinition[] {
    return [...this.#definitions.values()];
  }

  /** Runs one check, bypassing the cache. */
  async runOne(id: string): Promise<CheckResult> {
    const definition = this.#definitions.get(id);
    if (!definition) {
      throw new Error(`No check is registered with id "${id}".`);
    }

    let outcome: CheckOutcome;
    try {
      outcome = await definition.run();
    } catch (error) {
      // A check that throws must not take the Health page down with it. An
      // unknown state is honest; a blank page is not.
      outcome = {
        state: 'unknown',
        reason:
          error instanceof Error
            ? `This check could not run: ${error.message}`
            : 'This check could not run.',
      };
    }

    const result: CheckResult = {
      id: definition.id,
      category: definition.category,
      name: definition.name,
      plainDescription: definition.plainDescription,
      state: outcome.state,
      detail: outcome.detail,
      reason: outcome.reason,
      fix: outcome.fix,
      checkedAt: new Date(),
      ttlSeconds: definition.ttlSeconds,
    };

    this.#cache.set(definition.id, result);
    return result;
  }

  /**
   * Runs every check.
   *
   * Checks run concurrently because several involve network round trips and
   * running them in series makes the Health page feel broken.
   */
  async runAll(options: { useCache?: boolean } = {}): Promise<CheckResult[]> {
    const now = Date.now();

    const results = await Promise.all(
      [...this.#definitions.values()].map(async (definition) => {
        if (options.useCache) {
          const cached = this.#cache.get(definition.id);
          if (cached && now - cached.checkedAt.getTime() < cached.ttlSeconds * 1000) {
            return cached;
          }
        }
        return await this.runOne(definition.id);
      }),
    );

    return results;
  }

  /** Worst state across a set of results, for a rolled-up badge. */
  overall(results: readonly CheckResult[]): CheckState {
    return rollUpState(results.map((result) => result.state));
  }

  /**
   * Checks that are failing and can be fixed automatically without risk.
   *
   * Drives the "Fix everything safe" button. Anything that could lock the user
   * out — an RDP port change, an allowlist — is excluded by `safeToBatch`.
   */
  batchFixable(results: readonly CheckResult[]): CheckResult[] {
    return results.filter(
      (result) =>
        (result.state === 'blocked' || result.state === 'warning') &&
        result.fix?.kind === 'automatic' &&
        result.fix.safeToBatch,
    );
  }

  getCached(id: string): CheckResult | undefined {
    return this.#cache.get(id);
  }

  clearCache(): void {
    this.#cache.clear();
  }
}
