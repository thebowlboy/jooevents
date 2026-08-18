import { describe, expect, test } from 'bun:test';
import { audiencePreviewRows, unionAudienceGroups } from './audience-union';
import { templateKind } from './template-kinds';
import {
	withInsertedBlock,
	withRemovedBlock
} from '../features/templates/inline-edit';
import type { MessageTemplate, RecipientRow } from './types';

/**
 * Compose always has a content document.
 *
 * A blank start used to mint a draft with no body: the review could only
 * announce that there was no template, and there was no way to add one after
 * the fact. The one-off closes that — seeded from the registry's bare-start
 * scaffold, frozen onto the message, rendered by the same ceremony that renders
 * a stored template.
 */

/** What the composer seeds its one-off from, and freezes onto the send. */
function seedOneOff(): MessageTemplate {
	const bare = templateKind('blank')!;
	return {
		id: 'one-off',
		key: 'one-off',
		name: 'One-off message',
		purpose: bare.purpose,
		subject: bare.subject,
		blocks: structuredClone(bare.blocks),
		mergeFields: structuredClone(bare.mergeFields),
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

describe('a blank compose', () => {
	type Api = typeof import('./workspace').api;

	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?one-off=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	test('freezes its one-off onto the draft, so the review has a body to render', async () => {
		const api = await freshApi();
		const draft = await api.communications.compose({
			subject: 'Room change',
			audienceIds: ['confirmed-speakers'],
			document: seedOneOff()
		});

		// The label no longer says there is nothing here.
		expect(draft.review?.templateLabel).toBe('One-off message');
		expect(draft.templateId).toBeUndefined();
		// And the body rides along, template-shaped, for the one rendering path.
		expect(draft.document?.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
		expect(draft.document?.mergeFields.length).toBeGreaterThan(0);
	});

	test('carries the operator’s edits, not the scaffold they started from', async () => {
		const api = await freshApi();
		const edited = seedOneOff();
		(edited.blocks[0] as { text: string }).text = 'We have moved rooms';

		const draft = await api.communications.compose({
			subject: 'Room change',
			audienceIds: ['confirmed-speakers'],
			document: edited
		});
		expect((draft.document!.blocks[0] as { text: string }).text).toBe('We have moved rooms');
	});

	/**
	 * The one-off is a document, not a fixed pair of blocks: sections added in
	 * the composer land in composer state and freeze with everything else, so
	 * what the review renders is the shape the operator actually built.
	 */
	test('freezes the sections added to it, in the order they were added', async () => {
		const api = await freshApi();
		let built = seedOneOff();
		built = withInsertedBlock(built, built.blocks.length, 'button');
		built = withInsertedBlock(built, 1, 'details');

		const draft = await api.communications.compose({
			subject: 'Room change',
			audienceIds: ['confirmed-speakers'],
			document: built
		});
		expect(draft.document?.blocks.map((block) => block.type)).toEqual([
			'heading',
			'details',
			'paragraph',
			'button'
		]);
	});

	test('freezes a one-off that has been emptied down and rebuilt', async () => {
		const api = await freshApi();
		let built = seedOneOff();
		// Everything removable is removable, including the last block.
		built = withRemovedBlock(built, 0);
		built = withRemovedBlock(built, 0);
		expect(built.blocks).toEqual([]);
		built = withInsertedBlock(built, 0, 'paragraph');

		const draft = await api.communications.compose({
			subject: 'Room change',
			audienceIds: ['confirmed-speakers'],
			document: built
		});
		expect(draft.document?.blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	test('the frozen body is a copy: editing the compose afterwards cannot rewrite a sent draft', async () => {
		const api = await freshApi();
		const document = seedOneOff();
		const draft = await api.communications.compose({
			subject: 'Room change',
			audienceIds: ['confirmed-speakers'],
			document
		});
		(document.blocks[0] as { text: string }).text = 'Changed after the freeze';
		expect((draft.document!.blocks[0] as { text: string }).text).toBe('Your headline goes here');
	});

	test('a compose that named a template carries that template and no one-off', async () => {
		const api = await freshApi();
		const { messages } = await api.templates.list();
		const stored = messages[0]!;
		const draft = await api.communications.compose({
			subject: 'Travel details',
			audienceIds: ['confirmed-speakers'],
			templateId: stored.id,
			// Even if a one-off rides along, a named template wins: one body.
			document: seedOneOff()
		});
		expect(draft.templateId).toBe(stored.id);
		expect(draft.document).toBeUndefined();
		expect(draft.review?.templateLabel).toBe(`${stored.key} @ revision ${stored.revision}`);
	});
});

describe('the audience preview rows', () => {
	function person(name: string, email: string): RecipientRow {
		return { name, email, state: 'included' };
	}

	test('name the group that claimed each person first, when more than one is picked', () => {
		const union = unionAudienceGroups([
			{ label: 'Confirmed speakers', rows: [person('Ada', 'ada@x.test')] },
			{ label: 'Reviewers', rows: [person('Ada', 'ada@x.test'), person('Bo', 'bo@x.test')] }
		]);
		const rows = audiencePreviewRows(union);
		// Ada is in both; she receives the first group's copy, so that is the one
		// named — the union's own first-claim rule, stated back to the operator.
		expect(rows.map((row) => row.via)).toEqual(['Confirmed speakers', 'Reviewers']);
	});

	test('say nothing about provenance when only one group is picked', () => {
		const union = unionAudienceGroups([
			{ label: 'Reviewers', rows: [person('Ada', 'ada@x.test')] }
		]);
		// Naming it would only repeat the single chip above the list.
		expect(audiencePreviewRows(union)[0]!.via).toBeUndefined();
	});

	test('carry identity only where the resolver finds the person', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('Ada', 'ada@x.test'), person('Bo', 'bo@x.test')] }
		]);
		const rows = audiencePreviewRows(union, (row) =>
			row.email === 'ada@x.test' ? 'spk-1' : undefined
		);
		expect(rows[0]!.speakerId).toBe('spk-1');
		// Somebody the roster does not hold carries no door rather than a broken one.
		expect(rows[1]!.speakerId).toBeUndefined();
	});

	// The peek is an individual disclosure, asked for one person at a time. The
	// list itself must never become a bulk read of everybody's address.
	test('never carry an address, identified or not', () => {
		const union = unionAudienceGroups([
			{ label: 'A', rows: [person('Ada', 'ada@x.test'), person('Bo', 'bo@x.test')] }
		]);
		for (const row of audiencePreviewRows(union, () => 'spk-1')) {
			expect(Object.keys(row)).not.toContain('email');
			expect(JSON.stringify(row)).not.toContain('@');
		}
	});
});

describe('the sample composer port', () => {
	type Api = typeof import('./workspace').api;

	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?one-off-port=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	test('resolves roster identity for the rows it can, and discloses no addresses', async () => {
		const api = await freshApi();
		const preview = await api.communications.previewRecipients(['confirmed-speakers']);
		expect(preview.rows.length).toBeGreaterThan(0);
		// Confirmed speakers are on the roster, so their names open a profile.
		expect(preview.rows.some((row) => row.speakerId !== undefined)).toBe(true);
		for (const row of preview.rows) {
			expect(Object.keys(row).sort()).not.toContain('email');
		}
	});

	test('states provenance only for a combination', async () => {
		const api = await freshApi();
		const one = await api.communications.previewRecipients(['confirmed-speakers']);
		expect(one.rows.every((row) => row.via === undefined)).toBe(true);

		const both = await api.communications.previewRecipients(['confirmed-speakers', 'reviewers']);
		expect(both.rows.every((row) => row.via !== undefined)).toBe(true);
		// Everyone the first chip claimed is named under it, whichever chip also
		// holds them.
		expect(both.rows.filter((row) => row.via === 'Confirmed speakers').length).toBe(one.reach);
	});
});
