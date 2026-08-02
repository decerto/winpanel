import { describe, expect, it } from 'vitest';
import { validateRelativePath } from '../src/paths.js';

/**
 * Adversarial suite for the syntactic path layer.
 *
 * These are the string-level attacks. The agent's realpath containment check
 * is tested separately; both layers must hold independently.
 */
describe('validateRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    for (const input of ['', 'index.js', 'src/app.ts', 'a/b/c/d.txt', 'my folder/file.md']) {
      expect(validateRelativePath(input).ok, input).toBe(true);
    }
  });

  it('normalises backslashes and collapses redundant separators', () => {
    const result = validateRelativePath('src\\\\components//Button.vue');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('src/components/Button.vue');
  });

  it('rejects parent traversal in every form', () => {
    for (const input of ['..', '../etc', 'a/../../b', 'a\\..\\..\\b', 'foo/..']) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects absolute paths, drive letters and UNC paths', () => {
    for (const input of [
      '/etc/passwd',
      '\\Windows\\System32',
      'C:/Windows',
      'c:\\Windows',
      '//server/share',
      '\\\\server\\share',
    ]) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects null bytes', () => {
    expect(validateRelativePath('file.txt\u0000.jpg').ok).toBe(false);
  });

  it('rejects alternate data streams', () => {
    // `file.txt:hidden` writes a stream most tooling never shows.
    for (const input of ['file.txt:hidden', 'a/b.txt:$DATA', 'x:stream']) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects Windows reserved device names', () => {
    for (const input of ['CON', 'con', 'nul.txt', 'a/PRN', 'COM1', 'lpt9.log', 'AUX']) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects trailing dots and spaces', () => {
    // Windows silently strips these, so `evil.exe.` lands as `evil.exe`.
    for (const input of ['evil.exe.', 'evil.exe ', 'a/b. ', 'folder./file']) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects characters Windows forbids', () => {
    for (const input of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(validateRelativePath(input).ok, input).toBe(false);
    }
  });

  it('rejects "." segments so paths have exactly one representation', () => {
    expect(validateRelativePath('./file').ok).toBe(false);
    expect(validateRelativePath('a/./b').ok).toBe(false);
  });

  it('always reports a plain-English reason when rejecting', () => {
    const result = validateRelativePath('../secrets');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(10);
      expect(result.reason).toMatch(/[.!]$/);
    }
  });
});
