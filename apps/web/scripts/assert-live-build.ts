import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	proveAndWriteLiveBuildIdentity,
	type ApplicationRouteManifestEntry,
	type ClientBuildManifestEntry
} from './live-build-identity';

const buildDirectory = join(import.meta.dir, '..', 'build-live');
const clientManifestPath = join(import.meta.dir, '..', '.svelte-kit', 'output', 'client', '.vite', 'manifest.json');
const routeManifestPath = join(import.meta.dir, '..', '.svelte-kit', 'output', 'server', 'manifest-full.js');
if (!existsSync(join(buildDirectory, 'index.html'))) {
	throw new TypeError('Live build is missing its application shell.');
}
if (!existsSync(clientManifestPath) || !existsSync(routeManifestPath)) {
	throw new TypeError('Live build is missing the route evidence needed to verify application isolation.');
}

const clientManifest = JSON.parse(readFileSync(clientManifestPath, 'utf8')) as Record<string, ClientBuildManifestEntry>;
const { manifest: routeManifest } = await import(pathToFileURL(routeManifestPath).href);
const routes = routeManifest._.routes as readonly ApplicationRouteManifestEntry[];
const internalRoute = routes.find((route) =>
	!route.id.startsWith('/(entry)')
	&& !route.id.startsWith('/(operator)')
	&& !route.id.startsWith('/(participant)')
	&& !route.id.startsWith('/(public)')
);
if (internalRoute) {
	throw new TypeError(`Live build contains an internal route: ${internalRoute.id}`);
}

proveAndWriteLiveBuildIdentity({
	buildDirectory,
	clientManifest,
	routes
});
