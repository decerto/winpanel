import fs from 'node:fs/promises';

/**
 * Puts a freshly written temporary file in place of another.
 *
 * Windows refuses to rename over a file, so the old one goes first — and it
 * refuses both operations while anything holds a handle. A file this agent
 * has only just finished writing is exactly what a virus scanner opens to
 * read, for a few hundred milliseconds, at the worst possible moment. Every
 * download and every uploaded installer lands this way, so a scanner deciding
 * to look at one must not surface as a failed update.
 */
export async function replaceFile(temp: string, destination: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(destination, { force: true, maxRetries: 3, retryDelay: 200 });
      await fs.rename(temp, destination);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError;
}
