import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOfficialReleaseCache,
  listOfficialReleases,
  parseOfficialReleases,
} from '../src/components/panel-releases.js';

afterEach(() => {
  clearOfficialReleaseCache();
  vi.restoreAllMocks();
});

describe('official WinPanel releases', () => {
  it('keeps published releases and only accepts the official x64 installer', () => {
    const sha256 = 'A'.repeat(64).toLowerCase();
    const releases = parseOfficialReleases([
      {
        draft: false,
        tag_name: 'v1.12.0',
        name: 'Runtime logs and self-healing startup',
        html_url: 'https://github.com/decerto/winpanel/releases/tag/v1.12.0',
        published_at: '2026-08-20T12:00:00Z',
        prerelease: false,
        assets: [
          {
            name: 'WinPanel-Setup-x64.exe',
            browser_download_url:
              'https://github.com/decerto/winpanel/releases/download/v1.12.0/WinPanel-Setup-x64.exe',
            size: 42,
            digest: `sha256:${sha256.toUpperCase()}`,
          },
          {
            name: 'WinPanel-Setup-arm64.exe',
            browser_download_url:
              'https://github.com/decerto/winpanel/releases/download/v1.12.0/WinPanel-Setup-arm64.exe',
            size: 42,
            digest: null,
          },
          {
            name: 'not-official.exe',
            browser_download_url: 'https://downloads.example.test/not-official.exe',
            size: 42,
            digest: null,
          },
          {
            name: 'other-repository.exe',
            browser_download_url:
              'https://github.com/another-owner/another-repository/releases/download/v1.12.0/other-repository.exe',
            size: 42,
            digest: null,
          },
        ],
      },
      {
        draft: true,
        tag_name: 'v1.13.0',
        name: 'Draft',
        html_url: 'https://github.com/decerto/winpanel/releases/tag/v1.13.0',
        prerelease: false,
        assets: [],
      },
      {
        draft: false,
        tag_name: 'v1.11.0',
        name: 'Older release',
        html_url: 'https://github.com/decerto/winpanel/releases/tag/v1.11.0',
        published_at: '2026-07-20T12:00:00Z',
        prerelease: true,
        assets: [],
      },
    ]);

    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      tagName: 'v1.12.0',
      isPrerelease: false,
      installer: {
        url: 'https://github.com/decerto/winpanel/releases/download/v1.12.0/WinPanel-Setup-x64.exe',
        sizeBytes: 42,
        sha256,
      },
    });
    expect(releases.at(1)?.installer).toBeNull();
  });

  it('caches GitHub metadata while Settings is being revisited', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/decerto/winpanel/releases?per_page=100',
      );
      expect(init?.headers).toEqual({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'WinPanel',
      });
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await listOfficialReleases();
    const second = await listOfficialReleases();

    expect(first).toEqual({
      repositoryUrl: 'https://github.com/decerto/winpanel/releases',
      releases: [],
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});