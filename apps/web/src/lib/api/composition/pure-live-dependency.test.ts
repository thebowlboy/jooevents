import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

const entries = [
	join(import.meta.dir, 'pure-live-unavailable.ts'),
	join(import.meta.dir, 'operator-workspace-root.live.svelte'),
	join(import.meta.dir, 'operator-page.live.svelte'),
	join(import.meta.dir, 'participant-portal-root.live.svelte'),
	join(import.meta.dir, 'public-surface-root.live.svelte'),
	join(import.meta.dir, 'public-surface-page.live.svelte'),
	join(import.meta.dir, 'entry-deps.live.ts')
];
const sourceLib = resolve(import.meta.dir, '../..');

function importSpecifiers(source: string): string[] {
	const found = new Set<string>();
	const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^'\"]*?\sfrom\s+)?['\"]([^'\"]+)['\"]/g;
	const dynamicImport = /\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g;
	for (const pattern of [staticImport, dynamicImport]) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) found.add(match[1]);
		}
	}
	return [...found];
}

function localBase(from: string, specifier: string): string | null {
	if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
	if (specifier.startsWith('$lib/')) return resolve(sourceLib, specifier.slice('$lib/'.length));
	return null;
}

function resolveLocalModule(from: string, specifier: string): string | null {
	const base = localBase(from, specifier);
	if (!base) return null;
	const candidates = existsSync(base) && statSync(base).isFile()
		? [base, ...(base.endsWith('.svelte') ? [`${base}.ts`] : [])]
		: [
				`${base}.ts`,
				`${base}.svelte`,
				`${base}.js`,
				join(base, 'index.ts'),
				join(base, 'index.svelte'),
				join(base, 'index.js')
			];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

describe('pure-live source dependency boundary', () => {
	test('cannot reach sample modules or the legacy sample-backed workspace singleton', () => {
		const pending = [...entries];
		const visited = new Set<string>();
		const unresolved: string[] = [];
		const forbidden: string[] = [];

		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			const source = readFileSync(current, 'utf8');

			for (const specifier of importSpecifiers(source)) {
				const target = resolveLocalModule(current, specifier);
				if (!target) {
					if (localBase(current, specifier)) {
						unresolved.push(`${normalize(current)} -> ${specifier}`);
					}
					continue;
				}

				const normalizedTarget = normalize(target);
				if (
					normalizedTarget.includes(`${join('api', 'sample')}/`) ||
					normalizedTarget.includes(`${join('api', 'portal', 'sample')}/`) ||
					normalizedTarget.endsWith(join('api', 'workspace.ts')) ||
					normalizedTarget.endsWith(join('api', 'composition', 'entry-deps.ts'))
				) {
					forbidden.push(`${normalize(current)} -> ${specifier} -> ${normalizedTarget}`);
				}
				pending.push(target);
			}
		}

		expect(unresolved).toEqual([]);
		expect(forbidden).toEqual([]);
		for (const entry of entries) {
			expect([...visited].map((path) => normalize(path))).toContain(normalize(entry));
		}
		expect([...visited].some((path) => path.endsWith('capabilities.ts'))).toBe(true);
	});
});
