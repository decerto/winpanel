import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameServerCatalogEntry, GameServerWorkshop } from '@winpanel/shared';
import { runCommand } from '../process/run-command.js';
import { resolveSeedPath, setFlatProperty } from './seed-files.js';
import { createSteamRedactor } from './steam-privacy.js';

/**
 * Steam Workshop items, downloaded by the panel on the customer's behalf.
 *
 * The awkward part of mods on a rented server is ownership: the operator's
 * Steam account is what SteamCMD signs in with, and handing that to every
 * customer is out of the question. So nobody signs in but the server. A
 * customer pastes a Workshop link, the agent runs the download here, and the
 * credentials never leave the machine — the same arrangement that already
 * installs the game files.
 *
 * Anonymous is tried first for apps whose Workshop Valve serves without a
 * login, because that path needs no account at all.
 */

const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const QUERY_URL = 'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/';
const MAX_ITEM_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANIFEST_DEPTH = 3;
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
/** Steam caps a page at 100; the panel's grid wants far fewer than that. */
export const MAX_BROWSE_PAGE_SIZE = 30;

export class WorkshopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkshopError';
  }
}

export interface WorkshopItemDetails {
  publishedFileId: string;
  title: string;
  description: string;
  previewUrl: string | null;
  sizeBytes: number;
  appId: number | null;
  updatedAt: Date | null;
}

interface SteamDetailsResponse {
  response?: {
    publishedfiledetails?: Array<{
      publishedfileid?: string;
      result?: number;
      title?: string;
      description?: string;
      file_size?: number | string;
      preview_url?: string;
      consumer_app_id?: number;
      creator_app_id?: number;
      time_updated?: number;
      banned?: number;
      ban_reason?: string;
    }>;
  };
}

/** Steam serves previews from these hosts; anything else is not proxied. */
const PREVIEW_HOSTS = new Set([
  'steamuserimages-a.akamaihd.net',
  'images.steamusercontent.com',
  'community.cloudflare.steamstatic.com',
  'community.akamai.steamstatic.com',
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
]);

/** True for a preview URL the art proxy is willing to fetch. */
export function isAllowedPreviewUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && PREVIEW_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/*
 * Thumbnails for items nobody has added yet.
 *
 * The preview proxy will only fetch a URL Steam gave the agent, which works
 * neatly for an installed item because its URL is on the row. Browse results
 * are not rows yet, so the URLs seen while searching are remembered here for
 * the proxy to look up. Taking the URL from the browser instead would turn the
 * route into "fetch whatever this parameter says", which is a different and
 * much worse feature.
 */
const PREVIEW_MEMO_LIMIT = 600;
const previewMemo = new Map<string, string>();

function rememberPreview(publishedFileId: string, url: string | null): void {
  if (!isAllowedPreviewUrl(url)) return;
  previewMemo.delete(publishedFileId);
  previewMemo.set(publishedFileId, url);
  while (previewMemo.size > PREVIEW_MEMO_LIMIT) {
    const oldest = previewMemo.keys().next();
    if (oldest.done) break;
    previewMemo.delete(oldest.value);
  }
}

/** The preview URL Steam last gave for an item the agent has looked at. */
export function recallPreview(publishedFileId: string): string | null {
  return previewMemo.get(publishedFileId) ?? null;
}

function toNumber(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return Number.isFinite(parsed) && parsed !== undefined ? Math.max(0, Number(parsed)) : 0;
}

/**
 * Asks Steam what a published file actually is.
 *
 * Checked before anything is downloaded so a mistyped id, a private item or a
 * mod for a different game is refused with a sentence rather than a SteamCMD
 * exit code twenty minutes later.
 */
export async function fetchWorkshopDetails(
  publishedFileIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<WorkshopItemDetails[]> {
  if (publishedFileIds.length === 0) return [];

  const body = new URLSearchParams({ itemcount: String(publishedFileIds.length) });
  publishedFileIds.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));

  let payload: SteamDetailsResponse;
  try {
    const response = await fetchImpl(DETAILS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) throw new WorkshopError(`Steam did not answer the lookup (${response.status}).`);
    payload = (await response.json()) as SteamDetailsResponse;
  } catch (error) {
    if (error instanceof WorkshopError) throw error;
    throw new WorkshopError('Steam could not be reached to look up that Workshop item.');
  }

  const details = payload.response?.publishedfiledetails ?? [];
  return details.map((detail, index) => {
    const id = detail.publishedfileid ?? publishedFileIds[index] ?? '';
    if (detail.result !== undefined && detail.result !== 1) {
      throw new WorkshopError(`Steam has no public Workshop item with the id ${id}.`);
    }
    if (detail.banned) {
      throw new WorkshopError(`Steam has removed Workshop item ${id}${detail.ban_reason ? `: ${detail.ban_reason}` : '.'}`);
    }
    const sizeBytes = toNumber(detail.file_size);
    if (sizeBytes > MAX_ITEM_BYTES) {
      throw new WorkshopError(`Workshop item ${id} is larger than this panel will download.`);
    }
    const previewUrl = isAllowedPreviewUrl(detail.preview_url) ? detail.preview_url : null;
    rememberPreview(id, previewUrl);
    return {
      publishedFileId: id,
      title: detail.title?.slice(0, 200) || `Workshop item ${id}`,
      description: (detail.description ?? '').slice(0, 2000),
      previewUrl,
      sizeBytes,
      appId: detail.consumer_app_id ?? detail.creator_app_id ?? null,
      updatedAt: detail.time_updated ? new Date(detail.time_updated * 1000) : null,
    } satisfies WorkshopItemDetails;
  });
}

/**
 * How a browse is ordered.
 *
 * The same four choices Steam's own Workshop page leads with, because someone
 * who has browsed the Workshop before should not have to learn a new
 * vocabulary to do it here.
 */
export const WORKSHOP_SORTS = ['trend', 'popular', 'updated', 'newest'] as const;
export type WorkshopSort = (typeof WORKSHOP_SORTS)[number];

/** EPublishedFileQueryType, from Steam's clientenums.h. */
const QUERY_TYPE: Record<WorkshopSort, number> = {
  trend: 3,
  popular: 12,
  updated: 21,
  newest: 1,
};

export interface WorkshopBrowseItem {
  publishedFileId: string;
  title: string;
  description: string;
  /** The URL itself stays on the agent; the panel asks the preview proxy. */
  hasPreview: boolean;
  sizeBytes: number;
  tags: string[];
  subscriptions: number;
  favourites: number;
  votesUp: number;
  votesDown: number;
  updatedAt: Date | null;
}

export interface WorkshopBrowseResult {
  items: WorkshopBrowseItem[];
  total: number;
}

/** One shared key serves every customer, so identical pages are not re-asked. */
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_LIMIT = 60;
const searchCache = new Map<string, { result: WorkshopBrowseResult; expiresAt: number }>();

/** Called when the Web API key changes, so results from the old one are dropped. */
export function clearWorkshopSearchCache(): void {
  searchCache.clear();
}

export interface WorkshopBrowseOptions {
  apiKey: string;
  appId: number;
  search?: string;
  sort?: WorkshopSort;
  tag?: string;
  page?: number;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

interface SteamQueryResponse {
  response?: {
    total?: number;
    publishedfiledetails?: Array<{
      publishedfileid?: string;
      result?: number;
      title?: string;
      short_description?: string;
      file_description?: string;
      file_size?: number | string;
      preview_url?: string;
      previews?: Array<{ url?: string; preview_type?: number; sortorder?: number }>;
      time_updated?: number;
      banned?: number;
      subscriptions?: number;
      lifetime_subscriptions?: number;
      favorited?: number;
      tags?: Array<{ tag?: string; display_name?: string }>;
      vote_data?: { votes_up?: number; votes_down?: number };
    }>;
  };
}

/**
 * Searches a game's Workshop from inside the panel.
 *
 * Needs a Steam Web API key, which is why it is optional: Valve gives one to
 * anyone with a Steam account, but requiring one to install a mod would be a
 * poor trade for an operator who just wants the paste-a-link path. Without a
 * key the tab still works and the Browse button opens Steam's own page; with
 * one, the browsing happens here.
 *
 * The key is the operator's and never leaves the agent — the panel receives
 * results, not credentials. Results are cached briefly because every customer
 * on the machine shares that one key, and a page of mods should not be a way
 * to spend somebody else's rate limit.
 */
export async function searchWorkshop(options: WorkshopBrowseOptions): Promise<WorkshopBrowseResult> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 24, 1), MAX_BROWSE_PAGE_SIZE);
  const sort = options.sort ?? 'trend';
  const search = options.search?.trim().slice(0, 200) ?? '';
  const tag = options.tag?.trim().slice(0, 80) ?? '';
  const page = Math.max(options.page ?? 1, 1);

  const cacheKey = [options.appId, sort, search, tag, page, pageSize].join('\u0000');
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const query = new URLSearchParams({
    key: options.apiKey,
    appid: String(options.appId),
    query_type: String(QUERY_TYPE[sort]),
    page: String(page),
    numperpage: String(pageSize),
    // Items, not collections or artwork.
    filetype: '0',
    return_details: '1',
    return_previews: '1',
    return_short_description: '1',
    return_tags: '1',
    return_vote_data: '1',
    strip_description_bbcode: '1',
    cache_max_age_seconds: '300',
  });
  if (search) query.set('search_text', search);
  if (tag) query.set('requiredtags', tag);
  if (sort === 'trend') query.set('days', '7');

  let payload: SteamQueryResponse;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${QUERY_URL}?${query.toString()}`);
    if (response.status === 401 || response.status === 403) {
      throw new WorkshopError('Steam rejected the Web API key. An administrator can replace it.');
    }
    if (response.status === 429) {
      throw new WorkshopError('Steam is rate-limiting this panel. Try the search again shortly.');
    }
    if (!response.ok) throw new WorkshopError(`Steam did not answer the search (${response.status}).`);
    payload = (await response.json()) as SteamQueryResponse;
  } catch (error) {
    if (error instanceof WorkshopError) throw error;
    throw new WorkshopError('Steam could not be reached to search the Workshop.');
  }

  const details = payload.response?.publishedfiledetails ?? [];
  const items = details
    .filter((detail) => detail.publishedfileid && !detail.banned && (detail.result ?? 1) === 1)
    .map((detail) => {
      const id = detail.publishedfileid as string;
      // Some items carry no `preview_url` and only the previews array.
      const fallback = [...(detail.previews ?? [])]
        .sort((a, b) => (a.sortorder ?? 0) - (b.sortorder ?? 0))
        .find((preview) => isAllowedPreviewUrl(preview.url))?.url;
      const previewUrl = isAllowedPreviewUrl(detail.preview_url)
        ? detail.preview_url
        : (fallback ?? null);
      rememberPreview(id, previewUrl);

      return {
        publishedFileId: id,
        title: detail.title?.slice(0, 200) || `Workshop item ${id}`,
        description: (detail.short_description ?? detail.file_description ?? '').slice(0, 400),
        hasPreview: previewUrl !== null,
        sizeBytes: toNumber(detail.file_size),
        tags: (detail.tags ?? [])
          .map((tagEntry) => tagEntry.display_name ?? tagEntry.tag ?? '')
          .filter(Boolean)
          .slice(0, 8),
        subscriptions: toNumber(detail.lifetime_subscriptions ?? detail.subscriptions),
        favourites: toNumber(detail.favorited),
        votesUp: toNumber(detail.vote_data?.votes_up),
        votesDown: toNumber(detail.vote_data?.votes_down),
        updatedAt: detail.time_updated ? new Date(detail.time_updated * 1000) : null,
      } satisfies WorkshopBrowseItem;
    });

  const result: WorkshopBrowseResult = { items, total: toNumber(payload.response?.total) };
  searchCache.set(cacheKey, { result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next();
    if (oldest.done) break;
    searchCache.delete(oldest.value);
  }
  return result;
}

/** The Steam page the panel's "Browse" button opens for a game. */
export function workshopBrowseUrl(workshop: GameServerWorkshop): string {
  return workshop.browseUrl ?? `https://steamcommunity.com/app/${workshop.appId}/workshop/`;
}

/** Where this server keeps its own copy of a downloaded item. */
export function workshopItemDirectory(installPath: string, appId: number, publishedFileId: string): string {
  return path.join(installPath, 'steamapps', 'workshop', 'content', String(appId), publishedFileId);
}

async function isDirectory(target: string): Promise<boolean> {
  return await fs.stat(target).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/**
 * The folders inside an item that are individual mods.
 *
 * Workshop items for most games wrap their mods in a `mods` folder so one
 * upload can carry several; items that do not are a single mod in their own
 * right. Handling both here keeps that shape out of the catalog.
 */
export async function modFolders(itemDir: string): Promise<string[]> {
  const wrapper = path.join(itemDir, 'mods');
  if (!(await isDirectory(wrapper))) return [itemDir];

  const children = await fs.readdir(wrapper, { withFileTypes: true });
  const folders = children.filter((child) => child.isDirectory()).map((child) => path.join(wrapper, child.name));
  return folders.length > 0 ? folders : [itemDir];
}

/** Reads `key=value` out of a mod's manifest, wherever in the folder it sits. */
async function readManifestId(folder: string, file: string, key: string, depth = 0): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === file.toLowerCase()) {
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'im').exec(text);
      if (match?.[1]) found.push(match[1]);
    } else if (entry.isDirectory() && depth < MAX_MANIFEST_DEPTH) {
      found.push(...(await readManifestId(full, file, key, depth + 1)));
    }
  }
  return found;
}

/** Every mod id a downloaded item declares, in the order they were found. */
export async function collectModIds(itemDir: string, workshop: GameServerWorkshop): Promise<string[]> {
  const ids: string[] = [];
  for (const folder of await modFolders(itemDir)) {
    ids.push(...(await readManifestId(folder, workshop.modManifestFile, workshop.modManifestKey)));
  }
  return [...new Set(ids)];
}

/**
 * Copies an item's mod folders into the place the game looks for them.
 *
 * Games that read mods straight out of the Steam download need nothing here;
 * the ones that do not would otherwise require the customer to move files by
 * hand, which is the job the panel exists to remove.
 */
export async function copyModFolders(
  itemDir: string,
  dataPath: string,
  workshop: GameServerWorkshop,
): Promise<string[]> {
  if (!workshop.modsDirectory) return [];

  const root = resolveSeedPath(dataPath, workshop.modsDirectory);
  await fs.mkdir(root, { recursive: true });

  const copied: string[] = [];
  for (const folder of await modFolders(itemDir)) {
    const destination = path.join(root, path.basename(folder));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(folder, destination, { recursive: true });
    copied.push(path.basename(folder));
  }
  return copied;
}

/** Removes the folders a previously installed item put in the mods directory. */
export async function removeModFolders(
  dataPath: string,
  workshop: GameServerWorkshop,
  folderNames: readonly string[],
): Promise<void> {
  if (!workshop.modsDirectory || folderNames.length === 0) return;
  const root = resolveSeedPath(dataPath, workshop.modsDirectory);
  for (const name of folderNames) {
    // A manifest value is contributed content, so it is treated as untrusted
    // until it has been reduced to a single path segment under the root.
    const leaf = path.basename(name);
    if (leaf === '' || leaf === '.' || leaf === '..') continue;
    await fs.rm(path.join(root, leaf), { recursive: true, force: true });
  }
}

export interface WorkshopConfigUpdate {
  /** Published file ids, in the order the customer added them. */
  itemIds: readonly string[];
  /** Mod ids the downloads declared. */
  modIds: readonly string[];
}

/**
 * Rewrites the game's mod list after an add or a remove.
 *
 * Only the two declared keys are touched, and only when the catalog names
 * them: every other line of a settings file someone has spent an evening
 * tuning is left exactly as it was.
 */
export async function writeWorkshopConfig(
  entry: GameServerCatalogEntry,
  server: { slug: string; dataPath: string },
  update: WorkshopConfigUpdate,
): Promise<string | null> {
  const config = entry.workshop?.config;
  if (!config) return null;
  if (!config.itemsKey && !config.modsKey) return null;

  const target = resolveSeedPath(server.dataPath, config.path.replaceAll('{slug}', server.slug));
  const existing = await fs.readFile(target, 'utf8').catch(() => null);
  if (existing === null) return null;

  const newline = config.eol === 'crlf' ? '\r\n' : '\n';
  let text = existing.split(/\r?\n/).join('\n');
  if (config.itemsKey) text = setFlatProperty(text, config.itemsKey, update.itemIds.join(config.separator));
  if (config.modsKey) text = setFlatProperty(text, config.modsKey, update.modIds.join(config.separator));

  await fs.writeFile(target, `${text.split('\n').join(newline)}${newline}`, 'utf8');
  return target;
}

export interface WorkshopDownloadOptions {
  steamcmdPath: string;
  installPath: string;
  appId: number;
  publishedFileId: string;
  anonymous: boolean;
  credentials: { username: string; password: string } | null;
  onOutput?: (line: string) => void;
  run?: typeof runCommand;
}

/** Parses SteamCMD's own report of where it put the item. */
function downloadedPath(output: string): string | null {
  const match = /Downloaded item \d+ to "([^"]+)"/i.exec(output);
  return match?.[1] ?? null;
}

async function runWorkshopDownload(
  options: WorkshopDownloadOptions,
  login: readonly string[],
  redact: (text: string) => string,
): Promise<{ ok: boolean; output: string }> {
  const result = await (options.run ?? runCommand)({
    exe: options.steamcmdPath,
    cwd: path.dirname(options.steamcmdPath),
    args: [
      '+force_install_dir', options.installPath,
      ...login,
      '+workshop_download_item', String(options.appId), options.publishedFileId,
      '+quit',
    ],
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onOutput: (line) => {
      if (line.trim()) options.onOutput?.(redact(line));
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return { ok: result.exitCode === 0 && /Success\. Downloaded item/i.test(output), output };
}

/**
 * Downloads one item and returns the folder it ended up in.
 *
 * SteamCMD does not consistently honour `force_install_dir` for Workshop
 * content, so where the bytes landed is read from its own output first and
 * only guessed at afterwards. Items that land in SteamCMD's shared cache are
 * moved into the server's own tree, because a cache entry two servers share is
 * one that removing a mod from either would break.
 */
export async function downloadWorkshopItem(options: WorkshopDownloadOptions): Promise<string> {
  const attempts: Array<readonly string[]> = [];
  if (options.anonymous) attempts.push(['+login', 'anonymous']);
  if (options.credentials) {
    attempts.push(['+login', options.credentials.username, options.credentials.password]);
  }
  if (attempts.length === 0) {
    throw new WorkshopError(
      'This game\'s Workshop needs a Steam account. An administrator can add one, ' +
        'and it is used by the server only — nobody has to sign in here.',
    );
  }

  /*
   * A customer follows this download in a job log, and the account doing the
   * signing in belongs to whoever runs the panel. Redaction happens here, at
   * the one place SteamCMD's output is produced, rather than being left as
   * something each caller has to remember.
   */
  const redact = createSteamRedactor(options.credentials);

  let lastOutput = '';
  for (const [index, login] of attempts.entries()) {
    const attempt = await runWorkshopDownload(options, login, redact);
    lastOutput = attempt.output;
    if (attempt.ok) {
      const reported = downloadedPath(attempt.output);
      const destination = workshopItemDirectory(options.installPath, options.appId, options.publishedFileId);

      if (reported && path.resolve(reported) !== path.resolve(destination) && (await isDirectory(reported))) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rm(destination, { recursive: true, force: true });
        await fs.cp(reported, destination, { recursive: true });
        await fs.rm(reported, { recursive: true, force: true });
      }

      if (!(await isDirectory(destination))) {
        throw new WorkshopError('SteamCMD reported success but the item files were not found.');
      }
      return destination;
    }

    const isLast = index === attempts.length - 1;
    if (!isLast) options.onOutput?.('Anonymous download was refused; retrying with the server\'s own Steam account.');
  }

  if (/Timeout downloading item|Failure/i.test(lastOutput) && !options.credentials) {
    throw new WorkshopError(
      'Steam refused an anonymous Workshop download for this item. An administrator can add the ' +
        'server Steam account so the panel can fetch it.',
    );
  }
  const detail = redact(lastOutput.trim()).split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  throw new WorkshopError(`SteamCMD could not download that Workshop item.${detail ? ` ${detail}` : ''}`);
}
