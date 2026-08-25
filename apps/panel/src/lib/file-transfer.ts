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
  const request = new XMLHttpRequest();

  const promise = new Promise<void>((resolve, reject) => {
    const url =
      `/api/sites/${encodeURIComponent(siteSlug)}/files/upload` +
      `?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`;

    request.open('POST', url);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.withCredentials = true;

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }

      let message = `Upload failed (${request.status}).`;
      try {
        const parsed = JSON.parse(request.responseText) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // A non-JSON body means the agent never got as far as its own error
        // handling; the status code is all there is to report.
      }
      reject(new Error(message));
    });

    request.addEventListener('error', () =>
      reject(new Error('Could not reach the server. Check that the panel service is running.')),
    );
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));

    request.send(file);
  });

  return { promise, cancel: () => request.abort() };
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
  const request = new XMLHttpRequest();
  const promise = new Promise<void>((resolve, reject) => {
    const url =
      `/api/game-servers/${encodeURIComponent(gameServerSlug)}/files/upload` +
      `?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`;
    request.open('POST', url);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.withCredentials = true;
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      let message = `Upload failed (${request.status}).`;
      try {
        const parsed = JSON.parse(request.responseText) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // The status is the only useful response when the request failed early.
      }
      reject(new Error(message));
    });
    request.addEventListener('error', () => reject(new Error('Could not reach the server.')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    request.send(file);
  });
  return { promise, cancel: () => request.abort() };
}
