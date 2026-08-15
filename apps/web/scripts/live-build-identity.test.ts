import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	LIVE_BUILD_IDENTITY_FILENAME,
	liveBuildIdentitySchema
} from '@jooevents/contracts/live-build-identity';
import {
	proveAndWriteLiveBuildIdentity,
	type ApplicationRouteManifestEntry,
	type ClientBuildManifestEntry,
} from './live-build-identity';

let buildDirectory = '';

const clientManifest: Readonly<Record<string, ClientBuildManifestEntry>> = {
	'generated/nodes/0.js': {
		file: '_app/immutable/nodes/0.root.js',
		imports: ['shared.js']
	},
	'generated/nodes/1.js': {
		file: '_app/immutable/nodes/1.error.js'
	},
	'generated/nodes/2.js': {
		file: '_app/immutable/nodes/2.entry-layout.js'
	},
	'generated/nodes/3.js': {
		file: '_app/immutable/nodes/3.live.js',
		css: ['_app/immutable/assets/operator.css'],
		assets: ['_app/immutable/assets/wordmark.png']
	},
	'generated/nodes/4.js': {
		file: '_app/immutable/nodes/4.entry.js'
	},
	'generated/nodes/5.js': {
		file: '_app/immutable/nodes/5.participant-layout.js'
	},
	'generated/nodes/6.js': {
		file: '_app/immutable/nodes/6.public-layout.js'
	},
	'generated/nodes/8.js': {
		file: '_app/immutable/nodes/8.sign-in.js'
	},
	'generated/nodes/9.js': {
		file: '_app/immutable/nodes/9.page.js',
		imports: ['shared.js']
	},
	'generated/nodes/10.js': {
		file: '_app/immutable/nodes/10.portal.js',
		imports: ['shared.js']
	},
	'generated/nodes/11.js': {
		file: '_app/immutable/nodes/11.public.js',
		imports: ['shared.js']
	},
	'start.js': {
		file: '_app/immutable/entry/start.runtime.js',
		imports: ['shared.js']
	},
	'app.js': {
		file: '_app/immutable/entry/app.runtime.js',
		imports: ['shared.js'],
		dynamicImports: ['generated/nodes/24.js']
	},
	'generated/nodes/24.js': {
		file: '_app/immutable/nodes/24.sample.js'
	},
	'shared.js': {
		file: '_app/immutable/chunks/shared.js'
	}
};

const routes: readonly ApplicationRouteManifestEntry[] = [
	{ id: '/(entry)', page: { layouts: [0, 2], errors: [1, null], leaf: 4 } },
	{ id: '/(entry)/sign-in', page: { layouts: [0, 2], errors: [1, null], leaf: 8 } },
	{ id: '/(operator)/app', page: { layouts: [0, 3], errors: [1, null], leaf: 9 } },
	{ id: '/(participant)/portal', page: { layouts: [0, 5], errors: [1, null], leaf: 10 } },
	{ id: '/(public)/s/[kind]', page: { layouts: [0, 6], errors: [1, null], leaf: 11 } }
];

function write(relativePath: string, contents = relativePath): void {
	const path = join(buildDirectory, relativePath);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, contents);
}

function createFixture(): void {
	write('index.html', `
		<link href="/_app/immutable/entry/start.runtime.js" rel="modulepreload">
		<link href="/_app/immutable/entry/app.runtime.js" rel="modulepreload">
		<link href="/bowlboy.ico" rel="icon">
	`);
	write('app.html', '<link href="./_app/immutable/entry/start.runtime.js" rel="modulepreload">');
	write('sign-in.html', '<link href="./_app/immutable/assets/operator.css" rel="stylesheet">');
	write('portal.html', '<link href="./_app/immutable/entry/start.runtime.js" rel="modulepreload">');
	write('app/schedule.html', '<link href="../_app/immutable/assets/operator.css" rel="stylesheet">');
	write('bowlboy.ico');
	write('_app/version.json', '{"version":"fixture"}');
	write('embed/v1/joo-embed.js', '(function(){})();');
	for (const entry of Object.values(clientManifest)) {
		write(entry.file);
		for (const path of [...(entry.css ?? []), ...(entry.assets ?? [])]) write(path);
	}
	write('_app/immutable/nodes/24.sample.js', 'Mid-flight');
}

beforeEach(() => {
	buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-live-build-proof-test-')));
	createFixture();
});

afterEach(() => {
	if (buildDirectory) rmSync(buildDirectory, { recursive: true });
	buildDirectory = '';
});

describe('live application build identity producer', () => {
	test('writes one deterministic identity over the exact verified dependency closure', () => {
		const first = proveAndWriteLiveBuildIdentity({ buildDirectory, clientManifest, routes });
		const firstBytes = readFileSync(join(buildDirectory, LIVE_BUILD_IDENTITY_FILENAME), 'utf8');
		const second = proveAndWriteLiveBuildIdentity({ buildDirectory, clientManifest, routes });
		const secondBytes = readFileSync(join(buildDirectory, LIVE_BUILD_IDENTITY_FILENAME), 'utf8');

		expect(liveBuildIdentitySchema.parse(JSON.parse(firstBytes))).toEqual(first);
		expect(second).toEqual(first);
		expect(secondBytes).toBe(firstBytes);
		expect(first.files.map((file) => file.path)).toEqual([
			'_app/immutable/assets/operator.css',
			'_app/immutable/assets/wordmark.png',
			'_app/immutable/chunks/shared.js',
			'_app/immutable/entry/app.runtime.js',
			'_app/immutable/entry/start.runtime.js',
			'_app/immutable/nodes/0.root.js',
			'_app/immutable/nodes/1.error.js',
			'_app/immutable/nodes/10.portal.js',
			'_app/immutable/nodes/11.public.js',
			'_app/immutable/nodes/2.entry-layout.js',
			'_app/immutable/nodes/3.live.js',
			'_app/immutable/nodes/4.entry.js',
			'_app/immutable/nodes/5.participant-layout.js',
			'_app/immutable/nodes/6.public-layout.js',
			'_app/immutable/nodes/8.sign-in.js',
			'_app/immutable/nodes/9.page.js',
			'_app/version.json',
			'app.html',
			'bowlboy.ico',
			'embed/v1/joo-embed.js',
			'index.html',
			'portal.html',
			'sign-in.html'
		]);
	});

	test('covers a non-prerendered exact route through its node and verified SPA fallback', () => {
		const withRedirect = [
			...routes,
			{ id: '/(operator)/app/settings', page: { layouts: [0, 3], errors: [1, null], leaf: 9 } }
		] satisfies readonly ApplicationRouteManifestEntry[];
		const identity = proveAndWriteLiveBuildIdentity({
			buildDirectory,
			clientManifest,
			routes: withRedirect
		});
		expect(identity.files.some((file) => file.path === 'app/settings.html')).toBe(false);
		expect(identity.files.some((file) => file.path === '_app/immutable/nodes/9.page.js')).toBe(true);
	});

	test('leaves no identity when sample evidence or a missing closure file fails proof', () => {
		write('_app/immutable/nodes/9.page.js', 'Mid-flight');
		expect(() => proveAndWriteLiveBuildIdentity({ buildDirectory, clientManifest, routes }))
			.toThrow('sample scenario evidence');
		expect(() => readFileSync(join(buildDirectory, LIVE_BUILD_IDENTITY_FILENAME))).toThrow();

		write('_app/immutable/nodes/9.page.js', 'live');
		rmSync(join(buildDirectory, '_app/immutable/chunks/shared.js'));
		expect(() => proveAndWriteLiveBuildIdentity({ buildDirectory, clientManifest, routes }))
			.toThrow();
		expect(() => readFileSync(join(buildDirectory, LIVE_BUILD_IDENTITY_FILENAME))).toThrow();
	});
});
