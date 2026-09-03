/**
 * Moving file bytes to and from the agent.
 *
 * tRPC carries JSON, which is the wrong shape for a file: base64 in a batched
 * request would bloat every upload by a third and hold the whole thing in
 * memory twice. These two talk to the agent's streaming routes instead.
 */

/** Where a file can be fetched from, for a link or a new tab. */
export function downloadUrl(siteSlug: string, path: string): string {
  return `/api/sites/${encodeURIComponent(siteSlug)}/files/download?path=${encodeURIComponent(path)}`;
}

export interface UploadHandle {
  readonly promise: Promise<void>;
  /** Stops the transfer; the promise rejects. */
  cancel: () => void;
}

export interface BackupUploadResult {
  uploadId: string;
  bytes: number;
  scope: 'site' | 'panel';
  includeDependencies: boolean;
  websiteSlug?: string;
  databaseCount: number;
  websiteCount?: number;
}

const UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function uploadRequest<T>(
  url: string,
  file: File,
  onProgress: ((fraction: number) => void) | undefined,
  parse: (request: XMLHttpRequest) => T,
): { promise: Promise<T>; cancel: () => void } {
  const request = new XMLHttpRequest();
  let timedOut = false;

  const promise = new Promise<T>((resolve, reject) => {
    request.open('POST', url);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.withCredentials = true;
    request.timeout = UPLOAD_TIMEOUT_MS;

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(parse(request));
        } catch (error) {
          reject(error);
        }
        return;
      }

      let message = `Upload failed (${request.status}).`;
      try {
        const parsed = JSON.parse(request.responseText) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // A non-JSON body means the agent failed before its own error response.
      }
      reject(new Error(message));
    });

    request.addEventListener('error', () =>
      reject(new Error('Could not reach the server. Check that the panel service is running.')),
    );
    request.addEventListener('timeout', () => {
      timedOut = true;
      reject(new Error('The upload took too long and was stopped.'));
    });
    request.addEventListener('abort', () =>
      reject(new Error(timedOut ? 'The upload took too long and was stopped.' : 'Upload cancelled.')),
    );

    request.send(file);
  });

  return { promise, cancel: () => request.abort() };
}

/**
 * Sends one file into a folder of a website.
 *
 * XHR rather than fetch: upload progress is the whole point of showing a bar,
 * and fetch still cannot report it.
 */
export function uploadFile(
  siteSlug: string,
  folder: string,
  file: File,
  onProgress?: (fraction: number) => void,
): UploadHandle {
  return uploadRequest(
    `/api/sites/${encodeURIComponent(siteSlug)}/files/upload` +
      `?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`,
    file,
    onProgress,
    () => undefined,
  );
}

export function gameDownloadUrl(gameServerSlug: string, path: string): string {
  return `/api/game-servers/${encodeURIComponent(gameServerSlug)}/files/download?path=${encodeURIComponent(path)}`;
}

export function backupDownloadUrl(scope: 'site' | 'panel', id: string): string {
  return `/api/backups/${scope}/${encodeURIComponent(id)}/download`;
}

export function uploadGameFile(
  gameServerSlug: string,
  folder: string,
  file: File,
  onProgress?: (fraction: number) => void,
): UploadHandle {
  return uploadRequest(
    `/api/game-servers/${encodeURIComponent(gameServerSlug)}/files/upload` +
      `?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`,
    file,
    onProgress,
    () => undefined,
  );
}

export function uploadBackupFile(
  scope: 'site' | 'panel',
  file: File,
  siteSlug: string | undefined,
  onProgress?: (fraction: number) => void,
): { promise: Promise<BackupUploadResult>; cancel: () => void } {
  if (scope === 'site' && siteSlug === undefined) {
    throw new Error('A website is required for a website backup upload.');
  }
  if (scope === 'panel' && siteSlug !== undefined) {
    throw new Error('A panel backup upload cannot be attached to a website.');
  }
  const url =
    scope === 'site'
      ? `/api/backups/site/${encodeURIComponent(siteSlug!)}/upload`
      : '/api/backups/panel/upload';
  return uploadRequest<BackupUploadResult>(url, file, onProgress, (request) => {
    return JSON.parse(request.responseText) as BackupUploadResult;
  });
}
