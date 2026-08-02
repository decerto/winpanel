import { describe, expect, it } from 'vitest';
import { SiteManifest, parseManifest } from '../src/manifest.js';

/**
 * A manifest is read from the user's repository, so it is untrusted input.
 * These tests pin the constraints that stop a hostile or mistyped file from
 * escaping the checkout or running an arbitrary binary.
 */
describe('SiteManifest', () => {
  it('applies sensible defaults to a minimal manifest', () => {
    const manifest = parseManifest({});
    expect(manifest.runtime).toBe('node');
    expect(manifest.buildLocation).toBe('server');
    expect(manifest.app.portEnvVar).toBe('PORT');
    expect(manifest.app.healthCheckPath).toBe('/');
    expect(manifest.spaFallback).toBe(false);
    expect(manifest.steps).toEqual([]);
  });

  it('models the frontend-builds-into-backend layout', () => {
    const manifest = parseManifest({
      runtime: 'node',
      packageManager: 'pnpm',
      nodeVersion: '22',
      steps: [
        { name: 'Install frontend packages', cwd: 'frontend', command: 'pnpm', args: ['install'] },
        { name: 'Build the frontend', cwd: 'frontend', command: 'pnpm', args: ['run', 'build'] },
        {
          name: 'Install backend packages',
          cwd: 'backend',
          command: 'pnpm',
          args: ['install', '--prod'],
        },
      ],
      app: { cwd: 'backend', entry: 'server.js', healthCheckPath: '/healthz' },
      spaFallback: false,
    });

    expect(manifest.app.cwd).toBe('backend');
    expect(manifest.steps).toHaveLength(3);
    expect(manifest.steps[0]?.cwd).toBe('frontend');
    // The backend serves the built frontend itself, so Caddy must not also
    // add an index.html fallback.
    expect(manifest.spaFallback).toBe(false);
  });

  it('rejects a step command that is not on the allowlist', () => {
    const result = SiteManifest.safeParse({
      steps: [{ name: 'evil', command: 'powershell', args: ['-c', 'whoami'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a step that tries to escape the checkout', () => {
    for (const cwd of ['../..', 'C:/Windows', '/etc', '..\\..\\Windows']) {
      const result = SiteManifest.safeParse({
        steps: [{ name: 'x', cwd, command: 'npm', args: ['install'] }],
      });
      expect(result.success, cwd).toBe(false);
    }
  });

  it('rejects an app working directory outside the checkout', () => {
    const result = SiteManifest.safeParse({ app: { cwd: '../../Windows/System32' } });
    expect(result.success).toBe(false);
  });

  it('rejects an entry path that escapes the app folder', () => {
    const result = SiteManifest.safeParse({ app: { entry: '../../../evil.js' } });
    expect(result.success).toBe(false);
  });

  it('requires the port variable to look like an environment variable', () => {
    expect(SiteManifest.safeParse({ app: { portEnvVar: 'NITRO_PORT' } }).success).toBe(true);
    expect(SiteManifest.safeParse({ app: { portEnvVar: 'lowercase' } }).success).toBe(false);
    expect(SiteManifest.safeParse({ app: { portEnvVar: 'BAD-NAME' } }).success).toBe(false);
  });

  it('requires the health check path to be a path', () => {
    expect(SiteManifest.safeParse({ app: { healthCheckPath: '/up' } }).success).toBe(true);
    expect(
      SiteManifest.safeParse({ app: { healthCheckPath: 'http://evil.test/' } }).success,
    ).toBe(false);
  });

  it('caps the number of build steps', () => {
    const steps = Array.from({ length: 21 }, (_, i) => ({
      name: `step ${i}`,
      command: 'npm' as const,
      args: ['run', 'build'],
    }));
    expect(SiteManifest.safeParse({ steps }).success).toBe(false);
  });
});
