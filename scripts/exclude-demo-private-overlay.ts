import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface DemoOverlayExclusionResult {
  readonly removed: boolean;
  readonly fileCount: number;
}

function assertOrdinaryDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`${label}_must_be_an_ordinary_directory`);
  }
}

function inspectGeneratedTree(root: string, directory: string): number {
  let fileCount = 0;
  for (const name of readdirSync(directory)) {
    const child = resolve(directory, name);
    if (child !== root && !child.startsWith(`${root}${sep}`)) {
      throw new TypeError('demo_overlay_child_escaped_target');
    }
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) {
      throw new TypeError('demo_overlay_contains_symbolic_link');
    }
    if (stat.isDirectory()) {
      fileCount += inspectGeneratedTree(root, child);
      continue;
    }
    if (!stat.isFile()) throw new TypeError('demo_overlay_contains_special_file');
    fileCount += 1;
  }
  return fileCount;
}

/**
 * Removes only the generated `/reviews` subtree from a demo build before the
 * release-bundle guard runs. The source asset tree is never changed.
 */
export function excludeDemoPrivateOverlay(buildDirectory: string): DemoOverlayExclusionResult {
  const buildRoot = resolve(buildDirectory);
  assertOrdinaryDirectory(buildRoot, 'demo_build_root');
  const target = resolve(buildRoot, 'reviews');
  if (relative(buildRoot, target) !== 'reviews') {
    throw new TypeError('demo_overlay_target_invalid');
  }
  if (!existsSync(target)) return Object.freeze({ removed: false, fileCount: 0 });

  assertOrdinaryDirectory(target, 'demo_overlay_target');
  const fileCount = inspectGeneratedTree(target, target);
  rmSync(target, { recursive: true });
  if (existsSync(target)) throw new TypeError('demo_overlay_exclusion_failed');
  return Object.freeze({ removed: true, fileCount });
}

if (import.meta.main) {
  const buildRoot = resolve(import.meta.dir, '../apps/web/build');
  const result = excludeDemoPrivateOverlay(buildRoot);
  console.log(result.removed
    ? `Excluded ${result.fileCount} generated review artifact(s) from the demo build.`
    : 'Demo build contained no generated review overlay.');
}
