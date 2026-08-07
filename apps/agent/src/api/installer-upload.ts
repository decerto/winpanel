import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { replaceFile } from '../files/replace-file.js';
import { uploadedInstallerPath } from '../components/panel-update.js';
import { SESSION_COOKIE } from './trpc.js';

/**
 * Sending the setup program up from the machine you are sitting at.
 *
 * The other two routes to an update both assume something the user may not
 * have: an https address the server can reach, or the installer already
 * copied onto the server's own disk. Neither matches what people actually do,
 * which is download the .exe onto their own computer and want to pick it with
 * the ordinary Windows file dialog.
 *
 * A browser will only hand over a file's contents, never its path, so this is
 * a plain streamed POST rather than anything tRPC can express. The body is
 * written straight to disk — an installer is far too big to hold in memory,
 * and this process is also serving the panel.
 */

export const INSTALLER_UPLOAD_PATH = '/api/panel-update/installer';

/**
 * Generous, but bounded. The real installer is tens of megabytes; anything an
 * order of magnitude past that is a mistake or an attempt to fill the disk.
 */
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

/** Every Windows executable starts `MZ`. */
function looksExecutable(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
}

export class InstallerUploadError extends Error {}

/**
 * Streams a request body to disk, refusing anything that is not a Windows
 * program.
 *
 * The header is checked from the first bytes rather than after the fact so a
 * wrong file — a zip, an HTML error page saved by mistake — is rejected in the
 * first moment instead of after a hundred megabytes have crossed the network.
 */
export async function saveUploadedInstaller(
  source: AsyncIterable<Buffer>,
  destination: string,
  maxBytes: number = MAX_INSTALLER_BYTES,
): Promise<{ path: string; bytes: number }> {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const temp = `${destination}.part`;
  const out = createWriteStream(temp);
  let head = Buffer.alloc(0);
  let bytes = 0;

  try {
    for await (const chunk of source) {
      if (head.length < 2) {
        head = Buffer.concat([head, chunk.subarray(0, 2)]);
        if (head.length >= 2 && !looksExecutable(head)) {
          throw new InstallerUploadError(
            'That file is not a Windows program. Choose the WinPanel setup .exe.',
          );
        }
      }

      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new InstallerUploadError('That file is too large to be the WinPanel installer.');
      }

      if (!out.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    }

    if (!looksExecutable(head)) {
      throw new InstallerUploadError(
        'That file is not a Windows program. Choose the WinPanel setup .exe.',
      );
    }

    await closeStream(out);

    await replaceFile(temp, destination);

    return { path: destination, bytes };
  } catch (error) {
    // Windows will not delete or rename a file that still has an open handle,
    // so the descriptor has to be gone before either is attempted.
    await closeStream(out).catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Resolves once the file descriptor behind the stream is actually released. */
function closeStream(out: WriteStream): Promise<void> {
  if (out.closed) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('close', () => resolve());
    if (out.writableEnded) out.destroy();
    else out.end();
  });
}

/**
 * Registers the upload route.
 *
 * Guarded by the same session cookie and network allowlist as every other
 * call, and additionally reserved for the owner account, because `system.update`
 * — the only thing that consumes this file — is. What is written here is later
 * run as SYSTEM, so letting a lesser account leave a program at that path would
 * hand it the whole server the moment the owner pressed Update. The checks
 * happen before a single byte of the body is read.
 */
export function registerInstallerUpload(server: FastifyInstance, app: AppContext): void {
  server.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  server.post(INSTALLER_UPLOAD_PATH, { bodyLimit: MAX_INSTALLER_BYTES }, async (request, reply) => {
    const user = app.auth.resolveSession(request.cookies[SESSION_COOKIE]);

    if (!user) {
      return await reply.code(401).send({ error: 'Please sign in.' });
    }
    if (!app.auth.isIpAllowed(request.ip)) {
      return await reply
        .code(403)
        .send({ error: 'This panel does not accept connections from your network.' });
    }
    if (user.role !== 'superadmin') {
      return await reply
        .code(403)
        .send({ error: 'Only the owner of this server can update WinPanel.' });
    }

    try {
      const saved = await saveUploadedInstaller(
        request.raw,
        uploadedInstallerPath(app.config.binDir),
      );
      return await reply.send({ path: saved.path, bytes: saved.bytes });
    } catch (error) {
      if (error instanceof InstallerUploadError) {
        return await reply.code(400).send({ error: error.message });
      }
      request.log.error({ err: error }, 'Installer upload failed');
      return await reply.code(500).send({ error: 'The upload could not be saved.' });
    }
  });
}
