/**
 * Directory listings are dominated by per-entry `stat` calls, and awaiting
 * them one at a time turns a folder of a few thousand files into a request
 * that outlives the browser's patience. Running a fixed number at once hides
 * that latency without opening an unbounded number of handles.
 */

/** Stats in flight at once. Enough to hide latency, few enough to not exhaust handles. */
export const STAT_CONCURRENCY = 32;

/** Runs `task` over `items` with a fixed number in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}
