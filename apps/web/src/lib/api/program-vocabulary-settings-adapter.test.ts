import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredEventProgramFixture } from './event-program/fixtures';
import type { EventProgramPort } from './event-program/port';
import { createSampleEventProgramPort } from './event-program/sample';
import { createProgramVocabularySettingsAdapter, presentProgramRoomCapacity,
	presentProgramVocabularyUsage } from './program-vocabulary-settings-adapter';

function sampleComposition() {
	return createSampleEventProgramPort({ fixture: configuredEventProgramFixture });
}
function withVocabulary(base: EventProgramPort,
	overrides: Partial<EventProgramPort['vocabulary']>): EventProgramPort {
	return Object.freeze({ ...base, vocabulary: Object.freeze({ ...base.vocabulary, ...overrides }) });
}

describe('Program Vocabulary Settings presentation seam', () => {
	test('keeps canonical usage names and nullable capacity', () => {
		expect(presentProgramVocabularyUsage({ currentReferences: 0, historicalPins: 0 }))
			.toEqual({ kind: 'unused', label: 'Not used yet' });
		expect(presentProgramVocabularyUsage({ currentReferences: 2, historicalPins: 1 }))
			.toMatchObject({ label: '2 current references · 1 historical pin' });
		expect(presentProgramRoomCapacity(null)).toEqual({ kind: 'unknown', label: 'Capacity not set' });
		expect(presentProgramRoomCapacity(80)).toEqual({ kind: 'known', seats: 80, label: '80 seats' });
	});
});

describe('source-neutral direct Program Vocabulary Settings adapter', () => {
	test('uses one unchanged key for an ordinary direct action and no review calls', async () => {
		const sample = sampleComposition();
		const keys: string[] = [];
		const program = withVocabulary(sample.port, {
			async create(input, options) {
				keys.push(options.idempotencyKey);
				return sample.port.vocabulary.create(input, options);
			}
		});
		const adapter = createProgramVocabularySettingsAdapter({ program,
			newIdempotencyKey: () => 'settings-create-attempt-0001' });
		const result = await adapter.apply({ action: 'create', kind: 'room', name: 'Capacity pending', capacity: null });
		expect(result).toMatchObject({ kind: 'success', data: { action: 'create',
			change: { action: 'create', after: { name: 'Capacity pending', capacity: null } },
			correction: { kind: 'forward_change_required', action: 'create' } },
			receipt: { operationName: 'program_vocabulary.create' } });
		expect(keys).toEqual(['settings-create-attempt-0001']);
	});

	test('keeps the visible owner review and corrected ordinary action copy', () => {
		const features = join(import.meta.dir, '..', 'features', 'settings');
		const panel = readFileSync(join(features, 'ProgramVocabularyPanel.svelte'), 'utf8');
		const livePage = readFileSync(join(features, 'ProgramVocabularyLivePage.svelte'), 'utf8');
		expect(panel).toContain('Add, edit, retire, restore, and delete apply immediately. A merge shows the affected references before anything changes.');
		for (const label of ['>Add</Button>', '>Save</Button>', '>Retire</Button>', '>Restore</Button>',
			'>Delete</Button>', '>Review merge</Button>']) expect(panel).toContain(label);
		expect(livePage).toContain('Review the affected references below. Nothing has changed yet.');
		expect(livePage).toContain('>Merge categories</Button>');
		expect(livePage).toContain('>Cancel</Button>');
		expect(livePage).not.toContain('ChangesetReview');
	});

	test('preserves forward lifecycle correction through retire and restore', async () => {
		const sample = sampleComposition();
		const adapter = createProgramVocabularySettingsAdapter({ program: sample.port });
		const room = await adapter.addRoom('Forward room', 42);
		expect(await adapter.retireRoom(room.id)).toMatchObject({ ok: true, mutation: { data: {
			change: { action: 'retire', after: { status: 'retired' } },
			correction: { kind: 'forward_lifecycle', command: { action: 'restore', id: room.id } }
		} } });
		expect(await adapter.restoreRoom(room.id)).toMatchObject({ ok: true, mutation: { data: {
			change: { action: 'restore', after: { status: 'active' } },
			correction: { kind: 'forward_lifecycle', command: { action: 'retire', id: room.id } }
		} } });
	});

	test('keeps deletion-reference refusal copy on the direct delete outcome', async () => {
		const sample = sampleComposition();
		const adapter = createProgramVocabularySettingsAdapter({ program: sample.port });
		const blocked = (await adapter.rooms()).find((room) => room.name === 'Main hall');
		if (!blocked) throw new TypeError('blocked_room_missing');
		expect(await adapter.removeRoom(blocked.id)).toMatchObject({ ok: false,
			reason: 'This entry still has current references or historical pins. Retire or merge it instead.',
			failure: { kind: 'outcome', outcome: { kind: 'program_vocabulary.delete_referenced' } } });
	});

	test('prepares and publishes merge in two presses with separate stable keys', async () => {
		const sample = sampleComposition();
		const calls: { stage: string; key: string }[] = [];
		const program = withVocabulary(sample.port, {
			async draftMerge(input, options) {
				calls.push({ stage: 'draft', key: options.idempotencyKey });
				return sample.port.vocabulary.draftMerge(input, options);
			},
			async publishMerge(input, options) {
				calls.push({ stage: 'publish', key: options.idempotencyKey });
				return sample.port.vocabulary.publishMerge(input, options);
			}
		});
		const keys = ['settings-merge-draft-0001', 'settings-merge-publish-0001'];
		const adapter = createProgramVocabularySettingsAdapter({ program,
			newIdempotencyKey: () => keys.shift() ?? 'unexpected-key' });
		const rooms = await adapter.rooms();
		const source = rooms.find((room) => room.name === 'Workshop room');
		const target = rooms.find((room) => room.name === 'Main hall');
		if (!source || !target) throw new TypeError('merge_fixture_missing');
		const prepared = await adapter.mergeRoom(source.id, target.id);
		if (prepared.kind !== 'confirmation_required') throw new TypeError('merge_confirmation_expected');
		expect(prepared.data.action).toBe('merge');
		expect(prepared.data.change).toMatchObject({ action: 'merge',
			liveRepoints: source.usage.currentReferences });
		expect(typeof prepared.data.selector.draftId).toBe('string');
		expect(typeof prepared.data.selector.revisionId).toBe('string');
		expect(prepared.data.selector.revisionDigestSha256).toHaveLength(64);
		expect(await adapter.publishMerge(prepared.data)).toMatchObject({ kind: 'success',
			data: { action: 'merge', change: { sourceAfter: { status: 'retired' } } },
			receipt: { operationName: 'program_vocabulary.merge' } });
		expect(calls).toEqual([
			{ stage: 'draft', key: 'settings-merge-draft-0001' },
			{ stage: 'publish', key: 'settings-merge-publish-0001' }
		]);
	});
});
