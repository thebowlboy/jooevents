import { describe, expect, test } from 'bun:test';
import { createSampleTemplatesPagePort } from './templates-page-port.sample';
import { createSampleCommunicationsPagePort } from './communications-page-port.sample';
import { createLiveTemplatesPagePort } from './templates-page-port.live';
import { templateKinds } from './template-kinds';
import type { TemplatesPagePort } from './templates-page-port';

/**
 * Creating a template is now offered from two doors — the composer's picker and
 * the Templates library — and both mint through one capability. What is pinned
 * here is that the two doors agree, that every offered kind works through
 * either, and that a composition which cannot create says so by not serving the
 * member rather than by failing when pressed.
 */

describe('the create capability', () => {
	type Api = typeof import('./workspace').api;

	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?create-door=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	test('every offered kind mints through the library door', async () => {
		const api = await freshApi();
		const port = createSampleTemplatesPagePort(api);
		expect(port.templates.create).toBeDefined();

		for (const kind of templateKinds) {
			const made = await port.templates.create!({ name: `A ${kind.label}`, kind: kind.id });
			expect(made.name).toBe(`A ${kind.label}`);
			expect(made.purpose).toBe(kind.purpose);
			expect(made.subject).toBe(kind.subject);
			expect(made.blocks.map((block) => block.type)).toEqual(
				kind.blocks.map((block) => block.type)
			);
			// Minted into the one store both doors read.
			const listed = (await port.templates.list()).messages;
			expect(listed.some((entry) => entry.id === made.id)).toBe(true);
		}
	});

	test('the composer door mints the same records as the library door', async () => {
		const api = await freshApi();
		const library = createSampleTemplatesPagePort(api);
		const composer = createSampleCommunicationsPagePort(api);

		const fromLibrary = await library.templates.create!({ name: 'One', kind: 'announcement' });
		const fromComposer = await composer.templates.create({ name: 'Two', kind: 'announcement' });

		// Same shape, same scaffold, same first-revision attribution — one
		// vocabulary however it was reached.
		expect(fromComposer.blocks.map((block) => block.type)).toEqual(
			fromLibrary.blocks.map((block) => block.type)
		);
		expect(fromComposer.revisions).toEqual(fromLibrary.revisions);
		expect(fromComposer.purpose).toBe(fromLibrary.purpose);

		// And both are in the one store, which is what lets the composer's picker
		// list what the library page created.
		const listed = (await library.templates.list()).messages.map((entry) => entry.id);
		expect(listed).toContain(fromLibrary.id);
		expect(listed).toContain(fromComposer.id);
	});

	// A create-then-edit door needs the minted record's own id to select it, so
	// the mint has to answer with the record rather than with success.
	test('the mint answers with the record the door then opens', async () => {
		const api = await freshApi();
		const port = createSampleTemplatesPagePort(api);
		const made = await port.templates.create!({ name: 'Venue change', kind: 'announcement' });
		expect(made.id.length).toBeGreaterThan(0);
		const opened = (await port.templates.list()).messages.find((entry) => entry.id === made.id);
		expect(opened?.subject).toBe('News from {{event.name}}');
	});
});

/**
 * The live lane compiles against the widened port without implementing the new
 * member — which is the whole point of it being optional. The surface reads the
 * absence and renders its refusal in place of the door.
 */
describe('a composition that cannot create', () => {
	test('the live templates port satisfies the port without serving create', () => {
		const port: TemplatesPagePort = createLiveTemplatesPagePort({
			templates: { source: { kind: 'live' } },
			publication: undefined
		} as never);
		expect(port.templates.list).toBeDefined();
		// Absent, not throwing: the surface asks the shape, never a pressed control.
		expect(port.templates.create).toBeUndefined();
	});
});
