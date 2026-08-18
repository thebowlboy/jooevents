import { describe, expect, test } from 'bun:test';
import { templateKind, templateKinds } from './template-kinds';
import type { MessageTemplate, TemplateBlock } from './types';

/**
 * The kinds a hand-made template starts from, and what minting one produces.
 * The load-bearing claim is that a kind is data: adding one must not require a
 * change anywhere else, so everything asserted here is asserted over the whole
 * registry rather than over Announcement by name.
 */

/** Every `{{token}}` a template's subject and blocks actually use. */
function tokensUsed(subject: string, blocks: TemplateBlock[]): Set<string> {
	const texts = [subject];
	for (const block of blocks) {
		if (block.type === 'heading' || block.type === 'paragraph') texts.push(block.text);
		if (block.type === 'details') {
			for (const row of block.rows) texts.push(row.label, row.value);
		}
	}
	const found = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(/\{\{([^}]+)\}\}/g)) found.add(match[1]!.trim());
	}
	return found;
}

describe('the kind registry', () => {
	test('offers Announcement first, as the one a person is meant to reach for', () => {
		expect(templateKinds[0]!.id).toBe('announcement');
		expect(templateKinds.map((kind) => kind.id)).toEqual(['announcement', 'blank']);
	});

	test('every kind can be looked up by its id, and an unknown one resolves to nothing', () => {
		for (const kind of templateKinds) expect(templateKind(kind.id)).toBe(kind);
		expect(templateKind('reminder')).toBeUndefined();
	});

	test('every kind carries the words a card needs to be chosen by', () => {
		for (const kind of templateKinds) {
			expect(kind.label.length).toBeGreaterThan(0);
			expect(kind.description.length).toBeGreaterThan(0);
			expect(kind.purpose.length).toBeGreaterThan(0);
		}
	});

	// A token with nothing behind it renders as its own braces to the recipient.
	test('every token a kind writes is declared in its own merge fields', () => {
		for (const kind of templateKinds) {
			const declared = new Set(kind.mergeFields.map((field) => field.key));
			for (const token of tokensUsed(kind.subject, kind.blocks)) {
				expect(declared).toContain(token);
			}
		}
	});

	test('the announcement scaffold is a starter-shaped email', () => {
		const announcement = templateKind('announcement')!;
		expect(announcement.blocks.map((block) => block.type)).toEqual([
			'heading',
			'paragraph',
			'paragraph',
			'button',
			'divider'
		]);
		// A symbolic product reference, never a raw URL.
		const button = announcement.blocks.find((block) => block.type === 'button');
		expect(button).toEqual({ type: 'button', label: 'Read more', href: 'event.schedule' });
	});

	// Placeholder copy is text that can still be sent, so it must not address
	// the operator about the editor they are standing in.
	test('the scaffold never speaks to the person editing it', () => {
		for (const kind of templateKinds) {
			for (const token of tokensUsed('', kind.blocks)) expect(token).not.toContain('click');
			const prose = kind.blocks
				.filter((block) => block.type === 'heading' || block.type === 'paragraph')
				.map((block) => (block as { text: string }).text)
				.join(' ');
			expect(prose.toLowerCase()).not.toContain('click any text');
		}
	});

	test('blank is genuinely blank: a subject to write and no scaffold to delete', () => {
		const blank = templateKind('blank')!;
		expect(blank.blocks).toEqual([]);
		expect(blank.subject).toBe('');
	});
});

describe('minting a template from a kind', () => {
	type Api = typeof import('./workspace').api;

	// The sample store is module state and other suites add to it, so each case
	// mints into its own instance.
	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?template-kinds=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	test('an announcement arrives with its scaffold, its purpose, and a first revision of its own', async () => {
		const api = await freshApi();
		const made = await api.templates.create({ name: 'Venue change', kind: 'announcement' });

		expect(made.name).toBe('Venue change');
		expect(made.key).toBe('custom-venue-change');
		expect(made.purpose).toBe('Announcements and general updates.');
		expect(made.subject).toBe('News from {{event.name}}');
		expect(made.blocks.map((block) => block.type)).toEqual([
			'heading',
			'paragraph',
			'paragraph',
			'button',
			'divider'
		]);
		// Attributed to the operator exactly as an inline edit attributes them,
		// so the history reads from its first line.
		expect(made.revision).toBe(1);
		expect(made.revisions).toEqual([
			{ number: 1, at: 'Just now', by: 'you', note: 'Created — Announcement' }
		]);
		// No automatic flow sends it, and naming one would claim a wiring that
		// does not exist.
		expect(made.usedBy).toEqual([]);
	});

	test('the new template is in the one store both surfaces read', async () => {
		const api = await freshApi();
		const before = (await api.templates.list()).messages.length;
		const made = await api.templates.create({ name: 'Venue change', kind: 'announcement' });

		const listed = (await api.templates.list()).messages;
		expect(listed).toHaveLength(before + 1);
		expect(listed.some((entry) => entry.id === made.id)).toBe(true);
		// And addressable on its own, which is what the Templates page opens.
		expect(await api.templates.get(made.id)).toEqual(made as never);
	});

	test('a blank template is subject-only, with nothing scaffolded to delete', async () => {
		const api = await freshApi();
		const made = await api.templates.create({ name: 'Quick note', kind: 'blank' });
		expect(made.blocks).toEqual([]);
		expect(made.subject).toBe('');
		expect(made.revisions[0]!.note).toBe('Created — Blank');
	});

	test('two templates may share a name; their keys may not', async () => {
		const api = await freshApi();
		const first = await api.templates.create({ name: 'Venue change', kind: 'announcement' });
		const second = await api.templates.create({ name: 'Venue change', kind: 'announcement' });
		const third = await api.templates.create({ name: 'Venue change', kind: 'blank' });

		expect(first.key).toBe('custom-venue-change');
		expect(second.key).toBe('custom-venue-change-2');
		expect(third.key).toBe('custom-venue-change-3');
		expect(new Set([first.id, second.id, third.id]).size).toBe(3);
	});

	test('a name that slugs to nothing still gets a usable key', async () => {
		const api = await freshApi();
		const made = await api.templates.create({ name: '!!!', kind: 'blank' });
		expect(made.key).toBe('custom-template');
	});

	// The scaffold is copied, not shared: editing one template must not rewrite
	// the kind every later template is minted from.
	test('each minting gets its own blocks', async () => {
		const api = await freshApi();
		const first = await api.templates.create({ name: 'One', kind: 'announcement' });
		const second = await api.templates.create({ name: 'Two', kind: 'announcement' });
		expect(first.blocks).not.toBe(second.blocks);

		const heading = first.blocks[0] as { text: string };
		heading.text = 'Rewritten';
		const third = await api.templates.create({ name: 'Three', kind: 'announcement' });
		expect((third.blocks[0] as { text: string }).text).toBe('Your headline goes here');
	});

	/**
	 * What the composer does after Create: it selects the new template, and
	 * `pickTemplate` seeds the subject from it. The seeding rule is the
	 * composer's, but the value it seeds from is this.
	 */
	test('the minted subject is what the composer seeds its subject line from', async () => {
		const api = await freshApi();
		const made = await api.templates.create({ name: 'Venue change', kind: 'announcement' });
		const listed = (await api.templates.list()).messages.find((entry) => entry.id === made.id);
		expect(listed?.subject).toBe('News from {{event.name}}');
	});

	test('an edit made from the composer lands as the next revision of the same template', async () => {
		const api = await freshApi();
		const made = await api.templates.create({ name: 'Venue change', kind: 'announcement' });
		const next: MessageTemplate = structuredClone(made);
		(next.blocks[0] as { text: string }).text = 'We have moved rooms';

		const outcome = await api.templates.commitInline(made.id, next, 'Edited heading');
		expect(outcome.ok).toBe(true);

		const stored = (await api.templates.get(made.id)) as MessageTemplate;
		expect((stored.blocks[0] as { text: string }).text).toBe('We have moved rooms');
		expect(stored.revision).toBe(2);
		expect(stored.revisions.at(-1)).toEqual({
			number: 2,
			at: 'Just now',
			by: 'you',
			note: 'Edited heading'
		});
	});
});
