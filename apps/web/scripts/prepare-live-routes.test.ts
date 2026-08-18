import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLiveRoutes } from './prepare-live-routes';

let root = '';

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = '';
});

describe('live route boundary', () => {
	test('copies product routes while excluding the internal design system', () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-live-routes-')));
		const source = join(root, 'routes');
		const destination = join(root, '.live-routes');
		mkdirSync(join(source, '(operator)', 'app'), { recursive: true });
		mkdirSync(join(source, 'design-system', 'loading'), { recursive: true });
		writeFileSync(join(source, '(operator)', 'app', '+page.svelte'), '<h1>App</h1>');
		writeFileSync(join(source, 'design-system', 'loading', '+page.svelte'), '<h1>Internal</h1>');

		prepareLiveRoutes({ sourceDirectory: source, destinationDirectory: destination });

		expect(readFileSync(join(destination, '(operator)', 'app', '+page.svelte'), 'utf8'))
			.toBe('<h1>App</h1>');
		expect(existsSync(join(destination, 'design-system'))).toBe(false);
	});
});
