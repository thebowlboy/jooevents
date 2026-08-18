import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const LIVE_ROUTES_DIRECTORY = '.live-routes';
const EXCLUDED_TOP_LEVEL_ROUTES = new Set(['design-system']);

function directDirectory(path: string, label: string): string {
	const resolved = resolve(path);
	const stat = lstatSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resolved) !== resolved) {
		throw new TypeError(`${label} must be a direct canonical directory.`);
	}
	return resolved;
}

function copyTree(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true, mode: 0o755 });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isSymbolicLink()) {
			throw new TypeError(`Live route source contains a symbolic link: ${sourcePath}`);
		}
		if (entry.isDirectory()) {
			copyTree(sourcePath, destinationPath);
			continue;
		}
		if (!entry.isFile()) {
			throw new TypeError(`Live route source contains a non-file entry: ${sourcePath}`);
		}
		copyFileSync(sourcePath, destinationPath, 0);
	}
}

/**
 * Creates the router input for a production build. Internal workbench routes
 * never enter SvelteKit's manifest or compiled chunks; this is stronger than
 * deleting emitted files after the client router has learned their addresses.
 */
export function prepareLiveRoutes(input: {
	readonly sourceDirectory: string;
	readonly destinationDirectory: string;
}): void {
	const source = directDirectory(input.sourceDirectory, 'Live route source');
	const destination = resolve(input.destinationDirectory);
	if (basename(destination) !== LIVE_ROUTES_DIRECTORY || destination === source) {
		throw new TypeError('Live route destination must be the dedicated .live-routes directory.');
	}
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: false, mode: 0o755 });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (EXCLUDED_TOP_LEVEL_ROUTES.has(entry.name)) continue;
		if (entry.isSymbolicLink()) {
			throw new TypeError(`Live route source contains a symbolic link: ${join(source, entry.name)}`);
		}
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
		else if (entry.isFile()) copyFileSync(sourcePath, destinationPath, 0);
		else throw new TypeError(`Live route source contains a non-file entry: ${sourcePath}`);
	}
}

if (import.meta.main) {
	prepareLiveRoutes({
		sourceDirectory: join(import.meta.dir, '..', 'src', 'routes'),
		destinationDirectory: join(import.meta.dir, '..', 'src', LIVE_ROUTES_DIRECTORY)
	});
}
