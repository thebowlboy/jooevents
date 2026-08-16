import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeDemoPrivateOverlay } from './exclude-demo-private-overlay';

const temporaryDirectories: string[] = [];

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-demo-overlay-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('demo private-overlay exclusion', () => {
  test('removes only the generated review subtree', () => {
    const build = fixture();
    mkdirSync(join(build, 'reviews', 'nested'), { recursive: true });
    writeFileSync(join(build, 'reviews', 'one.html'), 'private');
    writeFileSync(join(build, 'reviews', 'nested', 'two.json'), 'private');
    writeFileSync(join(build, 'index.html'), 'public');

    expect(excludeDemoPrivateOverlay(build)).toEqual({ removed: true, fileCount: 2 });
    expect(existsSync(join(build, 'reviews'))).toBe(false);
    expect(existsSync(join(build, 'index.html'))).toBe(true);
  });

  test('is a no-op when the build has no review subtree', () => {
    const build = fixture();
    expect(excludeDemoPrivateOverlay(build)).toEqual({ removed: false, fileCount: 0 });
  });

  test('refuses links instead of traversing them', () => {
    const build = fixture();
    const outside = fixture();
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(build, 'reviews'));

    expect(() => excludeDemoPrivateOverlay(build))
      .toThrow('demo_overlay_target_must_be_an_ordinary_directory');
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});
