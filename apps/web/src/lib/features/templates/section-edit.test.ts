import { describe, expect, test } from 'bun:test';
import {
	insertedUnitPath,
	resolveUnit,
	sectionEditNote,
	withInsertedBlock,
	withRemovedBlock
} from './inline-edit';
import { sectionKind, sectionKinds } from '$lib/api/template-kinds';
import type { MessageTemplate, TemplateBlock } from '$lib/api/types';

/**
 * Adding and removing sections. A section is one typed object and a document is
 * the list, so these two builders are the whole structural vocabulary — which
 * is why every case here also checks that the paths the renderer addresses
 * blocks by still resolve afterwards.
 */

function doc(blocks: TemplateBlock[] = []): MessageTemplate {
	return {
		id: 'tpl-1',
		key: 'test',
		name: 'Test',
		purpose: 'Testing.',
		subject: 'Subject',
		blocks,
		mergeFields: [
			{ key: 'speaker.name', label: 'Speaker name', sample: 'Ada' },
			{ key: 'event.name', label: 'Event name', sample: 'Event' }
		],
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

const para = (text: string): TemplateBlock => ({ type: 'paragraph', text });

describe('inserting a section', () => {
	test('every offered kind can be added at the start, the middle, and the end', () => {
		const base = doc([para('one'), para('two')]);
		for (const entry of sectionKinds) {
			for (const at of [0, 1, 2]) {
				const next = withInsertedBlock(base, at, entry.kind);
				expect(next.blocks).toHaveLength(3);
				expect(next.blocks[at]!.type).toBe(entry.kind);
				// A builder never mutates: the base is still the base.
				expect(base.blocks).toHaveLength(2);
			}
		}
	});

	test('an index past either end lands at the nearest one rather than refusing', () => {
		const base = doc([para('one')]);
		expect(withInsertedBlock(base, -4, 'heading').blocks[0]!.type).toBe('heading');
		expect(withInsertedBlock(base, 99, 'heading').blocks[1]!.type).toBe('heading');
	});

	test('adds to an empty document, which is where a blank start begins', () => {
		const next = withInsertedBlock(doc(), 0, 'paragraph');
		expect(next.blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	// A hint pointing at a token this document has no field for would render as
	// its own braces, so a section may be added anywhere without dragging one in.
	test('keeps only the token hints the target document actually declares', () => {
		const next = withInsertedBlock(doc(), 0, 'paragraph');
		const block = next.blocks[0] as { suggestedVars?: string[] };
		expect(block.suggestedVars).toEqual(['speaker.name', 'event.name']);

		const bare = { ...doc(), mergeFields: [] };
		const added = withInsertedBlock(bare, 0, 'paragraph').blocks[0] as {
			suggestedVars?: string[];
		};
		expect(added.suggestedVars).toBeUndefined();
	});

	test('each insertion is its own object, not a shared seed', () => {
		let next = withInsertedBlock(doc(), 0, 'heading');
		next = withInsertedBlock(next, 1, 'heading');
		(next.blocks[0] as { text: string }).text = 'Rewritten';
		expect((next.blocks[1] as { text: string }).text).toBe('Your headline goes here');
	});

	test('an unknown kind changes nothing', () => {
		const base = doc([para('one')]);
		expect(withInsertedBlock(base, 0, 'image' as never)).toBe(base);
	});
});

describe('removing a section', () => {
	test('takes out exactly the named one', () => {
		const base = doc([para('one'), para('two'), para('three')]);
		const next = withRemovedBlock(base, 1);
		expect(next.blocks.map((block) => (block as { text: string }).text)).toEqual(['one', 'three']);
		expect(base.blocks).toHaveLength(3);
	});

	// An empty document is an honest state the editor renders its add control
	// over — never a refusal to remove the last thing.
	test('the last section may go, leaving an empty document', () => {
		expect(withRemovedBlock(doc([para('only')]), 0).blocks).toEqual([]);
	});

	test('an index naming no block changes nothing', () => {
		const base = doc([para('one')]);
		expect(withRemovedBlock(base, 5)).toBe(base);
		expect(withRemovedBlock(base, -1)).toBe(base);
	});
});

/**
 * `data-edit` paths address blocks by index, so both builders shift the paths of
 * everything after the change. Nothing stores a path across the write: the
 * renderer re-derives every path from the fresh document, and the editor
 * re-resolves against it — these cases pin that the fresh document is the one
 * that answers.
 */
describe('paths after a structural change', () => {
	test('an insert shifts the blocks after it, and every path still resolves', () => {
		const base = doc([para('one'), para('two')]);
		const next = withInsertedBlock(base, 0, 'heading');

		// What was blocks.0 is now blocks.1, read from the fresh document.
		expect(resolveUnit(next, 'blocks.1.text')).toMatchObject({ noun: 'paragraph', value: 'one' });
		expect(resolveUnit(next, 'blocks.2.text')).toMatchObject({ value: 'two' });
		expect(resolveUnit(next, 'blocks.0.text')).toMatchObject({ noun: 'heading' });
		// And nothing addresses past the end.
		expect(resolveUnit(next, 'blocks.3.text')).toBeNull();
	});

	test('a remove closes the gap, and the stale tail path stops resolving', () => {
		const base = doc([para('one'), para('two'), para('three')]);
		const next = withRemovedBlock(base, 0);
		expect(resolveUnit(next, 'blocks.0.text')).toMatchObject({ value: 'two' });
		expect(resolveUnit(next, 'blocks.1.text')).toMatchObject({ value: 'three' });
		// The index the document no longer has resolves to nothing rather than
		// to somebody else's words.
		expect(resolveUnit(next, 'blocks.2.text')).toBeNull();
	});

	test('the path an insert opens is the new section’s own first unit', () => {
		for (const entry of sectionKinds) {
			const next = withInsertedBlock(doc([para('one')]), 1, entry.kind);
			const path = insertedUnitPath(entry.kind, 1);
			if (entry.kind === 'divider') {
				// A divider has no words, so nothing opens.
				expect(path).toBeNull();
				continue;
			}
			expect(path).not.toBeNull();
			expect(resolveUnit(next, path!)).not.toBeNull();
		}
	});
});

describe('the receipt a structural change earns', () => {
	test('names the kind, in the same vocabulary as an edit', () => {
		expect(sectionEditNote('add', 'paragraph')).toBe('Added a paragraph');
		expect(sectionEditNote('remove', 'button')).toBe('Removed the button');
		expect(sectionEditNote('add', 'details')).toBe('Added a details list');
	});
});

/**
 * The scaffold voice: a seed says what belongs in its place, and never speaks to
 * the person editing it — placeholder copy that survives to send is copy a
 * recipient reads.
 */
describe('the section seeds', () => {
	function prose(block: TemplateBlock): string {
		if (block.type === 'heading' || block.type === 'paragraph') return block.text;
		if (block.type === 'details') {
			return block.rows.map((row) => `${row.label} ${row.value}`).join(' ');
		}
		if (block.type === 'button') return block.label;
		return '';
	}

	test('never address the editor or the act of editing', () => {
		for (const entry of sectionKinds) {
			const words = prose(entry.seed()).toLowerCase();
			for (const forbidden of ['click', 'press', 'tap', 'edit ', 'this field', 'placeholder']) {
				expect(words).not.toContain(forbidden);
			}
		}
	});

	test('write no merge token of their own', () => {
		// Seeds carry hints, not tokens: a literal token would render as braces
		// in any document that does not declare it.
		for (const entry of sectionKinds) {
			expect(prose(entry.seed())).not.toContain('{{');
		}
	});

	test('are all reachable by name from the registry', () => {
		expect(sectionKinds.map((entry) => entry.kind)).toEqual([
			'heading',
			'paragraph',
			'details',
			'button',
			'divider'
		]);
		for (const entry of sectionKinds) {
			expect(sectionKind(entry.kind)).toBe(entry);
			expect(entry.label.length).toBeGreaterThan(0);
		}
		expect(sectionKind('image')).toBeUndefined();
	});
});
