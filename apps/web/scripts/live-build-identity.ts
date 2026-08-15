import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
	LIVE_BUILD_IDENTITY_FILENAME,
	LIVE_BUILD_IDENTITY_SCOPE,
	liveBuildIdentityBodySchema,
	liveBuildIdentityDigestPayload,
	liveBuildIdentityFileSchema,
	liveBuildIdentitySchema,
	type LiveBuildIdentity
} from '@jooevents/contracts/live-build-identity';

const forbiddenSampleEvidence = [
	'Mid-flight',
	'Decision crunch',
	'All clear',
	'je-scenario',
	'Nothing is a real event',
	'Every count, row, and name in this workspace comes from that scenario.'
] as const;

export interface ClientBuildManifestEntry {
	readonly file: string;
	readonly imports?: readonly string[];
	readonly dynamicImports?: readonly string[];
	readonly css?: readonly string[];
	readonly assets?: readonly string[];
}

export interface ApplicationRouteManifestEntry {
	readonly id: string;
	readonly page?: {
		readonly layouts: readonly (number | null)[];
		readonly errors?: readonly (number | null)[];
		readonly leaf: number;
	};
}

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function staysInside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function exactBuildRoot(buildDirectory: string): string {
	const requested = resolve(buildDirectory);
	const stat = lstatSync(requested);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(requested) !== requested) {
		throw new TypeError('Live build root must be a direct canonical directory.');
	}
	return requested;
}

function buildFilePath(root: string, value: string): string {
	const relativePath = liveBuildIdentityFileSchema.shape.path.parse(value);
	const path = resolve(root, ...relativePath.split('/'));
	if (!staysInside(root, path)) throw new TypeError(`Live build file escapes its root: ${relativePath}`);
	return path;
}

function readDirectBuildFile(root: string, relativePath: string): Buffer {
	const path = buildFilePath(root, relativePath);
	let cursor = root;
	for (const segment of relativePath.split('/')) {
		cursor = join(cursor, segment);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new TypeError(`Live build file path contains a symlink: ${relativePath}`);
		if (cursor === path) {
			if (!stat.isFile() || stat.nlink !== 1 || realpathSync(cursor) !== cursor) {
				throw new TypeError(`Live build dependency is not a direct file: ${relativePath}`);
			}
		} else if (!stat.isDirectory()) {
			throw new TypeError(`Live build dependency parent is not a directory: ${relativePath}`);
		}
	}
	return readFileSync(path);
}

function removePriorIdentity(root: string): void {
	const markerPath = join(root, LIVE_BUILD_IDENTITY_FILENAME);
	try {
		unlinkSync(markerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

function isLiveApplicationRoute(route: ApplicationRouteManifestEntry): boolean {
	return route.id.startsWith('/(entry)')
		|| route.id.startsWith('/(operator)')
		|| route.id.startsWith('/(participant)')
		|| route.id.startsWith('/(public)');
}

function routeHtmlPath(route: ApplicationRouteManifestEntry): string | undefined {
	if (!isLiveApplicationRoute(route) || route.id.includes('[')) return undefined;
	const path = route.id.replace(/^\/\((?:entry|operator|participant|public)\)(?:\/|$)/, '');
	return path.length === 0 ? 'index.html' : `${path}.html`;
}

function collectApplicationHtml(
	root: string,
	routes: readonly ApplicationRouteManifestEntry[]
): readonly string[] {
	const html = new Set<string>();
	for (const route of routes) {
		const path = routeHtmlPath(route);
		if (!path) continue;
		// A route may deliberately opt out of prerendering (for example a
		// client-visible redirect) and is then served by the verified SPA
		// fallback. Its route node still enters the dependency closure below;
		// only an emitted route document can enter the HTML set.
		if (!existsSync(buildFilePath(root, path))) continue;
		readDirectBuildFile(root, path);
		html.add(path);
	}
	if (!html.has('index.html') || !html.has('app.html') || !html.has('sign-in.html')) {
		throw new TypeError('Live build is missing its entry or operator shell.');
	}
	return [...html].sort();
}

function localResourceReference(relativeHtmlPath: string, value: string): string | undefined {
	const base = new URL(relativeHtmlPath, 'https://build.invalid/');
	const parsed = new URL(value, base);
	if (parsed.origin !== base.origin || parsed.pathname === '/') return undefined;
	let pathname: string;
	try {
		pathname = decodeURIComponent(parsed.pathname);
	} catch {
		throw new TypeError(`Live application HTML contains an invalid resource path: ${value}`);
	}
	return liveBuildIdentityFileSchema.shape.path.parse(pathname.slice(1));
}

function htmlResourceReferences(relativeHtmlPath: string, bytes: Buffer): readonly string[] {
	const references = new Set<string>();
	const html = bytes.toString('utf8');
	for (const tag of html.matchAll(/<(?:link|script|img|source)\b[^>]*>/gi)) {
		for (const attribute of tag[0].matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
			const value = attribute[1];
			if (!value || value.startsWith('data:')) continue;
			const local = localResourceReference(relativeHtmlPath, value);
			if (local) references.add(local);
		}
	}
	return [...references].sort();
}

function assertApplicationRouteNodeIds(routes: readonly ApplicationRouteManifestEntry[]): ReadonlySet<number> {
	const applicationRoutes = routes.filter(isLiveApplicationRoute);
	if (applicationRoutes.length === 0) throw new TypeError('Live build has no application routes to verify.');
	const nodeIds = new Set<number>();
	for (const route of applicationRoutes) {
		if (!route.page || !Number.isSafeInteger(route.page.leaf) || route.page.leaf < 0) {
			throw new TypeError(`Application route is missing its page binding: ${route.id}`);
		}
		for (const nodeId of [...route.page.layouts, ...(route.page.errors ?? [])]) {
			if (nodeId === null || nodeId === undefined) continue;
			if (!Number.isSafeInteger(nodeId) || nodeId < 0) {
				throw new TypeError(`Application route has an invalid layout or error binding: ${route.id}`);
			}
			nodeIds.add(nodeId);
		}
		nodeIds.add(route.page.leaf);
	}
	return nodeIds;
}

export function collectLiveApplicationDependencyClosure(input: {
	readonly buildDirectory: string;
	readonly clientManifest: Readonly<Record<string, ClientBuildManifestEntry>>;
	readonly routes: readonly ApplicationRouteManifestEntry[];
}): readonly string[] {
	const root = exactBuildRoot(input.buildDirectory);
	const paths = new Set<string>();
	const manifestKeysByNodeId = new Map<number, string>();
	const manifestKeysByFile = new Map<string, string[]>();

	for (const [key, entry] of Object.entries(input.clientManifest)) {
		const nodeMatch = key.match(/\/nodes\/(\d+)\.js$/);
		if (nodeMatch) manifestKeysByNodeId.set(Number(nodeMatch[1]), key);
		const file = liveBuildIdentityFileSchema.shape.path.parse(entry.file);
		const owners = manifestKeysByFile.get(file) ?? [];
		owners.push(key);
		manifestKeysByFile.set(file, owners);
	}

	const pendingManifestKeys: string[] = [];
	for (const nodeId of assertApplicationRouteNodeIds(input.routes)) {
		const key = manifestKeysByNodeId.get(nodeId);
		if (!key) throw new TypeError(`Live build is missing application node ${nodeId}.`);
		pendingManifestKeys.push(key);
	}

	for (const htmlPath of collectApplicationHtml(root, input.routes)) {
		const htmlBytes = readDirectBuildFile(root, htmlPath);
		paths.add(htmlPath);
		for (const resourcePath of htmlResourceReferences(htmlPath, htmlBytes)) {
			readDirectBuildFile(root, resourcePath);
			paths.add(resourcePath);
			for (const key of manifestKeysByFile.get(resourcePath) ?? []) pendingManifestKeys.push(key);
		}
	}

	if (existsSync(join(root, '_app/version.json'))) paths.add('_app/version.json');
	// The embed loader is a served runtime requirement, referenced only by
	// snippets pasted on other people's sites — no application HTML imports
	// it, so the reference walk cannot discover it.
	if (existsSync(join(root, 'embed/v1/joo-embed.js'))) paths.add('embed/v1/joo-embed.js');

	const visitedManifestKeys = new Set<string>();
	while (pendingManifestKeys.length > 0) {
		const key = pendingManifestKeys.pop();
		if (!key || visitedManifestKeys.has(key)) continue;
		visitedManifestKeys.add(key);
		const entry = input.clientManifest[key];
		if (!entry) throw new TypeError(`Live build manifest has an unresolved import: ${key}`);
		for (const path of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
			paths.add(liveBuildIdentityFileSchema.shape.path.parse(path));
		}
		const dynamicImports = /^_app\/immutable\/entry\/app\.[A-Za-z0-9_-]+\.js$/.test(entry.file)
			? []
			: entry.dynamicImports ?? [];
		for (const importedKey of [...(entry.imports ?? []), ...dynamicImports]) {
			if (!input.clientManifest[importedKey]) {
				throw new TypeError(`Live build manifest has an unresolved import: ${importedKey}`);
			}
			pendingManifestKeys.push(importedKey);
		}
	}

	const closure = [...paths].sort();
	for (const path of closure) readDirectBuildFile(root, path);
	return Object.freeze(closure);
}

export function createLiveBuildIdentity(input: {
	readonly buildDirectory: string;
	readonly files: readonly string[];
}): LiveBuildIdentity {
	const root = exactBuildRoot(input.buildDirectory);
	const files = [...input.files].sort().map((path) => {
		const bytes = readDirectBuildFile(root, path);
		if (['.html', '.js', '.json'].includes(extname(path))) {
			const contents = bytes.toString('utf8');
			const found = forbiddenSampleEvidence.find((value) => contents.includes(value));
			if (found) throw new TypeError(`Live application dependency contains sample scenario evidence: ${found}`);
		}
		return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
	});
	const markerDescriptor = liveBuildIdentityFileSchema.parse({
		path: LIVE_BUILD_IDENTITY_FILENAME,
		bytes: 0,
		sha256: sha256('')
	});
	if (files.some((file) => file.path === markerDescriptor.path)) {
		throw new TypeError('The live build identity cannot include itself.');
	}
	const body = liveBuildIdentityBodySchema.parse({
		formatVersion: 1,
		kind: 'live',
		scope: LIVE_BUILD_IDENTITY_SCOPE,
		files
	});
	return liveBuildIdentitySchema.parse({
		...body,
		digestSha256: sha256(liveBuildIdentityDigestPayload(body))
	});
}

export function proveAndWriteLiveBuildIdentity(input: {
	readonly buildDirectory: string;
	readonly clientManifest: Readonly<Record<string, ClientBuildManifestEntry>>;
	readonly routes: readonly ApplicationRouteManifestEntry[];
}): LiveBuildIdentity {
	const root = exactBuildRoot(input.buildDirectory);
	removePriorIdentity(root);
	const files = collectLiveApplicationDependencyClosure(input);
	const identity = createLiveBuildIdentity({ buildDirectory: root, files });
	writeFileSync(
		join(root, LIVE_BUILD_IDENTITY_FILENAME),
		`${JSON.stringify(identity)}\n`,
		{ encoding: 'utf8', flag: 'wx', mode: 0o644 }
	);
	return identity;
}
