import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const featureRoot = join(import.meta.dir, '..', '..', 'features');
const tunedFeatureDirectories = [
	'communications',
	'decisions',
	'embeds',
	'forms',
	'review',
	'reviewers',
	'schedule',
	'settings',
	'speakers',
	'submissions',
	'tasks',
	'templates'
] as const;
const tunedStandaloneFiles = [
	join(featureRoot, 'workspace', 'components', 'OverviewDashboard.svelte')
] as const;

function sourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:svelte|ts)$/.test(entry.name) ? [path] : [];
	});
}

describe('tuned operator page port boundary', () => {
	test('keeps the monolithic sample gateway in composition, not presentation components', () => {
		const files = [
			...tunedFeatureDirectories.flatMap((directory) =>
				sourceFiles(join(featureRoot, directory))
			),
			...tunedStandaloneFiles
		];
		const offenders = files.filter((file) =>
			readFileSync(file, 'utf8').includes('useWorkspaceGateway')
		);

		expect(offenders).toEqual([]);
	});
});
