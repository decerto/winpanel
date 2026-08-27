const GITHUB_REPOSITORY_URL = 'https://github.com/decerto/winpanel';
const GITHUB_REPOSITORY_PATH = '/decerto/winpanel';
const GITHUB_RELEASES_API_URL =
  'https://api.github.com/repos/decerto/winpanel/releases?per_page=100';
const INSTALLER_ASSET_NAME = 'winpanel-setup-x64.exe';
const RELEASE_CACHE_MS = 5 * 60 * 1000;

export interface OfficialRelease {
  tagName: string;
  name: string;
  htmlUrl: string;
  publishedAt: string | null;
  isPrerelease: boolean;
  installer: {
    url: string;
    sizeBytes: number | null;
    sha256: string | null;
  } | null;
}

export interface OfficialReleases {
  repositoryUrl: string;
  releases: OfficialRelease[];
}

export class OfficialReleaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OfficialReleaseError';
  }
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null ? (value as RecordValue) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function officialUrl(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      (url.pathname === GITHUB_REPOSITORY_PATH || url.pathname.startsWith(`${GITHUB_REPOSITORY_PATH}/`))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function sha256FromDigest(value: unknown): string | null {
  const digest = asString(value)?.match(/^sha256:([a-f0-9]{64})$/i);
  return digest?.[1]?.toLowerCase() ?? null;
}

function parseAsset(value: unknown): {
  name: string;
  url: string;
  sizeBytes: number | null;
  sha256: string | null;
} | null {
  const asset = asRecord(value);
  const name = asString(asset?.name);
  const url = officialUrl(asset?.browser_download_url);
  if (!name || !url) return null;

  return {
    name,
    url,
    sizeBytes: typeof asset?.size === 'number' && Number.isFinite(asset.size) ? asset.size : null,
    sha256: sha256FromDigest(asset?.digest),
  };
}

export function parseOfficialReleases(value: unknown): OfficialRelease[] {
  if (!Array.isArray(value)) {
    throw new OfficialReleaseError('GitHub returned an unexpected release list.');
  }

  return value.flatMap((value) => {
    const release = asRecord(value);
    if (!release || release.draft === true) return [];

    const tagName = asString(release.tag_name);
    const htmlUrl = officialUrl(release.html_url);
    if (!tagName || !htmlUrl) return [];

    const assets = Array.isArray(release.assets)
      ? release.assets.map(parseAsset).filter((asset): asset is NonNullable<typeof asset> => asset !== null)
      : [];
    const installer =
      assets.find((asset) => asset.name.toLowerCase() === INSTALLER_ASSET_NAME) ?? null;

    return [
      {
        tagName,
        name: asString(release.name) ?? tagName,
        htmlUrl,
        publishedAt: asString(release.published_at),
        isPrerelease: release.prerelease === true,
        installer: installer
          ? {
              url: installer.url,
              sizeBytes: installer.sizeBytes,
              sha256: installer.sha256,
            }
          : null,
      },
    ];
  });
}

let cached: { expiresAt: number; result: OfficialReleases } | null = null;
let pending: Promise<OfficialReleases> | null = null;

export function clearOfficialReleaseCache(): void {
  cached = null;
}

async function fetchOfficialReleases(): Promise<OfficialReleases> {
  let response: Response;
  try {
    response = await fetch(GITHUB_RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'WinPanel',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new OfficialReleaseError(
      'Could not reach GitHub to check for WinPanel releases.',
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new OfficialReleaseError(
      response.status === 403
        ? 'GitHub is temporarily rate-limiting release checks. Try again in a few minutes.'
        : `GitHub could not provide the WinPanel releases (HTTP ${response.status}).`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new OfficialReleaseError('GitHub returned an unreadable release list.', { cause: error });
  }

  return {
    repositoryUrl: `${GITHUB_REPOSITORY_URL}/releases`,
    releases: parseOfficialReleases(body),
  };
}

export async function listOfficialReleases(): Promise<OfficialReleases> {
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (pending) return pending;

  pending = fetchOfficialReleases()
    .then((result) => {
      cached = { expiresAt: Date.now() + RELEASE_CACHE_MS, result };
      return result;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}