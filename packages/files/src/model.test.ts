import { describe, expect, test } from 'bun:test';
import {
  FilesValidationError,
  isAllowedFileContentType,
  isImageFileContentType,
  parseFileAsset,
  sanitizeDisplayFilename
} from './model';
import { fixtureAsset } from './test-fixtures';

describe('files model', () => {
  test('closes the D3 content-type allowlist and refuses video and active types', () => {
    expect(isAllowedFileContentType('application/pdf')).toBe(true);
    expect(isAllowedFileContentType('image/png')).toBe(true);
    expect(isAllowedFileContentType('image/jpeg')).toBe(true);
    expect(isAllowedFileContentType('image/webp')).toBe(true);
    expect(isAllowedFileContentType(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )).toBe(true);
    expect(isAllowedFileContentType('application/vnd.apple.keynote')).toBe(true);
    expect(isAllowedFileContentType('application/zip')).toBe(true);

    expect(isAllowedFileContentType('video/mp4')).toBe(false);
    expect(isAllowedFileContentType('text/html')).toBe(false);
    expect(isAllowedFileContentType('image/svg+xml')).toBe(false);
    expect(isAllowedFileContentType('application/javascript')).toBe(false);
    expect(isAllowedFileContentType('application/octet-stream')).toBe(false);
  });

  test('image classification covers exactly the re-encoded members', () => {
    expect(isImageFileContentType('image/png')).toBe(true);
    expect(isImageFileContentType('image/jpeg')).toBe(true);
    expect(isImageFileContentType('image/webp')).toBe(true);
    expect(isImageFileContentType('application/pdf')).toBe(false);
    expect(isImageFileContentType('image/svg+xml')).toBe(false);
  });

  test('sanitizes display filenames without ever selecting a path', () => {
    expect(sanitizeDisplayFilename('deck.pdf')).toBe('deck.pdf');
    expect(sanitizeDisplayFilename('My Talk (final).pdf')).toBe('My Talk (final).pdf');
    expect(sanitizeDisplayFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeDisplayFilename('..\\..\\windows\\evil.exe')).toBe('evil.exe');
    expect(() => sanitizeDisplayFilename('..')).toThrow(FilesValidationError);
    expect(() => sanitizeDisplayFilename('....')).toThrow(FilesValidationError);
    expect(sanitizeDisplayFilename("a\u0000b\u0001c.pdf")).toBe("abc.pdf");
    expect(sanitizeDisplayFilename('  spaced  name.pdf ')).toBe('spaced name.pdf');
    expect(sanitizeDisplayFilename('.hidden.pdf')).toBe('hidden.pdf');
    const long = `${'x'.repeat(400 - 5)}.pptx`;
    const bounded = sanitizeDisplayFilename(long);
    expect(bounded.length).toBe(200);
    expect(bounded.endsWith('.pptx')).toBe(true);
    expect(() => sanitizeDisplayFilename('')).toThrow(FilesValidationError);
    expect(() => sanitizeDisplayFilename('dir/')).toThrow(FilesValidationError);
  });

  test('asset parsing enforces lifecycle and scan coherence', () => {
    expect(() => parseFileAsset(fixtureAsset())).not.toThrow();
    expect(() => parseFileAsset(fixtureAsset({
      lifecycle: 'blocked',
      scan: { provider: 'none', verdict: 'released', checkedAt: '2026-08-15T10:00:00.000Z' }
    }))).toThrow(FilesValidationError);
    expect(() => parseFileAsset(fixtureAsset({
      lifecycle: 'available',
      scan: { provider: 'clamav', verdict: 'pending', checkedAt: null }
    }))).toThrow(FilesValidationError);
    expect(() => parseFileAsset(fixtureAsset({
      contentType: 'text/html' as never
    }))).toThrow(FilesValidationError);
  });
});
