import { describe, expect, test } from 'bun:test';
import { programVocabularySafeDiffSchema } from '@jooevents/contracts';
import type { ProgramVocabularyDraftView } from './view-models/program-vocabulary';
import type { EventProgramPort } from './event-program/port';
import {
	configuredEventProgramFixture,
	freshEventProgramFixture
} from './event-program/fixtures';
import { createLiveEventProgramPort } from './event-program/live';
import { createSampleEventProgramPort } from './event-program/sample';
import { createChangesetReviewLivePort } from './changesets/live';
import type { ChangesetReviewPort } from './changesets/port';
import {
	createProgramVocabularySettingsAdapter,
	presentProgramRoomCapacity,
	presentProgramVocabularyUsage,
	ProgramVocabularySettingsAdapterError
} from './program-vocabulary-settings-adapter';

function sampleComposition() {
	return createSampleEventProgramPort({ fixture: configuredEventProgramFixture });
}

function withProgramDraft(
	base: EventProgramPort,
	draft: EventProgramPort['vocabulary']['draft']
): EventProgramPort {
	return Object.freeze({
		...base,
		vocabulary: Object.freeze({ read: base.vocabulary.read, draft })
	});
}

function withChangesetCalls(
	base: ChangesetReviewPort,
	overrides: Partial<Pick<ChangesetReviewPort, 'readDiff' | 'propose' | 'commit'>>
): ChangesetReviewPort {
	return Object.freeze({ ...base, ...overrides });
}

describe('Program Vocabulary Settings presentation seam', () => {
	test('names only canonical current references and historical pins', () => {
		expect(presentProgramVocabularyUsage({ currentReferences: 0, historicalPins: 0 }))
			.toEqual({ kind: 'unused', label: 'Not used yet' });
		expect(presentProgramVocabularyUsage({ currentReferences: 2, historicalPins: 1 }))
			.toEqual({
				kind: 'references',
				currentReferences: 2,
				historicalPins: 1,
				label: '2 current references · 1 historical pin'
			});
		const presentation = presentProgramVocabularyUsage({
			currentReferences: 4,
			historicalPins: 7
		});
		expect(presentation).not.toHaveProperty('submissions');
		expect(presentation).not.toHaveProperty('sessions');
		expect(presentation).not.toHaveProperty('placements');
	});

	test('keeps unknown room capacity distinct from zero seats', () => {
		expect(presentProgramRoomCapacity(null)).toEqual({
			kind: 'unknown', label: 'Capacity not set'
		});
		expect(presentProgramRoomCapacity(1)).toEqual({
			kind: 'known', seats: 1, label: '1 seat'
		});
		expect(presentProgramRoomCapacity(80)).toEqual({
			kind: 'known', seats: 80, label: '80 seats'
		});
	});
});

describe('source-neutral Program Vocabulary Settings adapter', () => {
	test('projects honest canonical rows without legacy usage aliases or nullable-capacity coercion', async () => {
		const sample = sampleComposition();
		const adapter = createProgramVocabularySettingsAdapter({
			program: sample.port,
			changesets: sample.changesets
		});

		const [rooms, tracks, formats] = await Promise.all([
			adapter.rooms(), adapter.tracks(), adapter.formats()
		]);
		expect(rooms.find((room) => room.name === 'Workshop room')).toMatchObject({
			capacity: null,
			usage: { currentReferences: 0, historicalPins: 0 }
		});
		expect(tracks[0]).toMatchObject({
			name: 'Applied AI',
			usage: { currentReferences: 8, historicalPins: 13 }
		});
		expect(formats[0]).toMatchObject({
			name: 'Workshop',
			usage: { currentReferences: 2, historicalPins: 6 }
		});
		expect(Object.keys(tracks[0]!.usage).sort())
			.toEqual(['currentReferences', 'historicalPins']);
	});

	test('maps every create/edit/lifecycle/delete/merge verb through guarded draft, propose, and commit', async () => {
		const sample = sampleComposition();
		const adapter = createProgramVocabularySettingsAdapter({
			program: sample.port,
			changesets: sample.changesets
		});

		const room = await adapter.addRoom('Capacity pending', null);
		expect(room).toMatchObject({
			kind: 'room', capacity: null,
			usage: { currentReferences: 0, historicalPins: 0 },
			deleteAvailability: { kind: 'available' }
		});
		expect(await adapter.editRoom(room.id, 'Studio', 42)).toMatchObject({ ok: true });
		const retiredRoom = await adapter.retireRoom(room.id);
		expect(retiredRoom).toMatchObject({
			ok: true,
			mutation: {
				data: {
					change: { action: 'retire', after: { status: 'retired' } },
					correction: {
						kind: 'forward_lifecycle',
						command: { action: 'restore', kind: 'room', id: room.id }
					}
				}
			}
		});
		expect(await adapter.restoreRoom(room.id)).toMatchObject({ ok: true });
		expect(await adapter.removeRoom(room.id)).toMatchObject({ ok: true });

		const source = await adapter.addTrack('Systems');
		const target = await adapter.addTrack('Platforms');
		expect(source.accent).toMatch(/^(lavender|sea|neutral)$/u);
		expect(await adapter.editTrack(source.id, 'Distributed systems')).toMatchObject({ ok: true });
		expect(await adapter.retireTrack(source.id)).toMatchObject({ ok: true });
		expect(await adapter.restoreTrack(source.id)).toMatchObject({ ok: true });
		expect(await adapter.mergeTrack(source.id, target.id)).toMatchObject({
			ok: true,
			mutation: {
				data: {
					change: { action: 'merge', sourceAfter: { status: 'retired' } },
					correction: { kind: 'changeset_correction_required' }
				}
			}
		});
		expect(await adapter.removeTrack(source.id)).toMatchObject({ ok: true });

		const format = await adapter.addFormat('Roundtable');
		expect(await adapter.editFormat(format.id, 'Guided roundtable')).toMatchObject({ ok: true });
		expect(await adapter.retireFormat(format.id)).toMatchObject({ ok: true });
		expect(await adapter.restoreFormat(format.id)).toMatchObject({ ok: true });
		expect(await adapter.removeFormat(format.id)).toMatchObject({ ok: true });
	});

	test('reuses one action key after a retryable interruption and derives distinct stage keys', async () => {
		const sample = sampleComposition();
		const draftKeys: string[] = [];
		const proposeKeys: string[] = [];
		const commitKeys: string[] = [];
		let interrupted = true;
		const program = withProgramDraft(sample.port, async (request, options) => {
			draftKeys.push(options.idempotencyKey);
			if (interrupted) {
				interrupted = false;
				return { kind: 'transport_error', error: { code: 'network_error', retryable: true } };
			}
			return sample.port.vocabulary.draft(request, options);
		});
		const changesets = withChangesetCalls(sample.changesets, {
			async propose(input, key, options) {
				proposeKeys.push(key);
				return sample.changesets.propose(input, key, options);
			},
			async commit(input, key, options) {
				commitKeys.push(key);
				return sample.changesets.commit(input, key, options);
			}
		});
		let generated = 0;
		const adapter = createProgramVocabularySettingsAdapter({
			program,
			changesets,
			newIdempotencyKey: () => {
				generated += 1;
				return `program-vocabulary-action-${generated}`;
			}
		});
		const command = { action: 'create', kind: 'format', name: 'Clinic' } as const;

		expect(await adapter.apply(command)).toMatchObject({
			kind: 'transport_error', error: { code: 'network_error', retryable: true }
		});
		expect(await adapter.apply(command)).toMatchObject({ kind: 'success' });
		expect(generated).toBe(1);
		expect(draftKeys).toHaveLength(2);
		expect(draftKeys[0]).toBe(draftKeys[1]);
		expect(new Set([draftKeys[1], proposeKeys[0], commitKeys[0]]).size).toBe(3);
		expect(draftKeys[1]).toContain('.draft.');
		expect(proposeKeys[0]).toContain('.propose.');
		expect(commitKeys[0]).toContain('.commit.');
	});

	test('rejects a draft whose safe diff does not bind to the guarded request', async () => {
		const sample = sampleComposition();
		let proposed = 0;
		const program = withProgramDraft(sample.port, async (request, options) => {
			const result = await sample.port.vocabulary.draft(request, options);
			if (result.kind !== 'success') return result;
			const change = result.data.change;
			if (change.action !== 'create') throw new TypeError('expected_create');
			const data: ProgramVocabularyDraftView = {
				...result.data,
				change: {
					...change,
					after: { ...change.after, name: 'Different server claim' }
				}
			};
			return { ...result, data };
		});
		const changesets = withChangesetCalls(sample.changesets, {
			async propose(input, key, options) {
				proposed += 1;
				return sample.changesets.propose(input, key, options);
			}
		});
		const adapter = createProgramVocabularySettingsAdapter({ program, changesets });

		expect(await adapter.apply({ action: 'create', kind: 'track', name: 'Security' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		expect(proposed).toBe(0);
	});

	test('rejects a proposed revision whose selector-bound operation differs from the draft', async () => {
		const sample = sampleComposition();
		let committed = 0;
		const changesets = withChangesetCalls(sample.changesets, {
			async propose(input, key, options) {
				const result = await sample.changesets.propose(input, key, options);
				if (result.kind !== 'success') return result;
				const group = result.data.groups[0];
				const operation = group?.operations[0];
				const diff = programVocabularySafeDiffSchema.safeParse(operation?.safeDiff);
				if (!group || !operation || !diff.success || diff.data.action !== 'create') {
					throw new TypeError('expected_create_proposal');
				}
				return {
					...result,
					data: {
						...result.data,
						groups: [{
							...group,
							operations: [{
								...operation,
								safeDiff: {
									...diff.data,
									after: { ...diff.data.after, name: 'Changed after review binding' }
								}
							}]
						}]
					}
				};
			},
			async commit(input, key, options) {
				committed += 1;
				return sample.changesets.commit(input, key, options);
			}
		});
		const adapter = createProgramVocabularySettingsAdapter({
			program: sample.port,
			changesets
		});

		expect(await adapter.apply({ action: 'create', kind: 'format', name: 'Office hours' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		expect(committed).toBe(0);
	});

	test('stops at an honestly distinct-human draft and keeps referenced deletion structured', async () => {
		const sample = sampleComposition();
		let proposed = 0;
		const program = withProgramDraft(sample.port, async (request, options) => {
			const result = await sample.port.vocabulary.draft(request, options);
			if (result.kind !== 'success') return result;
			return {
				...result,
				data: {
					...result.data,
					approvalPolicy: {
						...result.data.approvalPolicy,
						requirement: 'distinct_current_human' as const
					}
				}
			};
		});
		const changesets = withChangesetCalls(sample.changesets, {
			async propose(input, key, options) {
				proposed += 1;
				return sample.changesets.propose(input, key, options);
			}
		});
		const adapter = createProgramVocabularySettingsAdapter({ program, changesets });
		expect(await adapter.apply({ action: 'retire', kind: 'track', id: configuredEventProgramFixture.vocabulary!.tracks[0]!.id }))
			.toMatchObject({
				kind: 'confirmation_required',
				data: { requirement: 'distinct_current_human', change: { action: 'retire' } }
			});
		expect(proposed).toBe(0);

		const ordinary = createProgramVocabularySettingsAdapter({
			program: sample.port,
			changesets: sample.changesets
		});
		const blocked = await ordinary.removeTrack(
			configuredEventProgramFixture.vocabulary!.tracks[0]!.id
		);
		expect(blocked).toMatchObject({
			ok: false,
			failure: {
				kind: 'outcome',
				outcome: { kind: 'program_vocabulary.delete_referenced' }
			}
		});
		expect(blocked.ok ? '' : blocked.reason)
			.toContain('current references or historical pins');
	});

	test('never falls back to sample when exact live bindings are unavailable', async () => {
		let requested = false;
		const program = createLiveEventProgramPort({
			manifest: {},
			eventRequest: {
				read: async () => { requested = true; throw new TypeError('unexpected_request'); },
				draft: async () => { requested = true; throw new TypeError('unexpected_request'); },
				changeset: async () => { requested = true; throw new TypeError('unexpected_request'); }
			},
			programVocabularyRequest: {
				read: async () => { requested = true; throw new TypeError('unexpected_request'); },
				draft: async () => { requested = true; throw new TypeError('unexpected_request'); }
			}
		});
		const changesets = createChangesetReviewLivePort({
			manifest: {},
			request: async () => { requested = true; throw new TypeError('unexpected_request'); }
		});
		const adapter = createProgramVocabularySettingsAdapter({ program, changesets });

		expect(await adapter.apply({ action: 'create', kind: 'track', name: 'Live only' }))
			.toEqual({ kind: 'unavailable', operation: 'read', reason: 'invalid_operation_manifest' });
		expect(requested).toBe(false);
	});

	test('refuses mixed-source construction and exposes safe errors to direct list consumers', async () => {
		const sample = sampleComposition();
		const liveChangesets = createChangesetReviewLivePort({ manifest: {} });
		expect(() => createProgramVocabularySettingsAdapter({
			program: sample.port,
			changesets: liveChangesets
		})).toThrow('program_vocabulary_source_mismatch');

		const fresh = createSampleEventProgramPort({
			fixture: freshEventProgramFixture
		});
		const adapter = createProgramVocabularySettingsAdapter({
			program: fresh.port,
			changesets: fresh.changesets
		});
		try {
			await adapter.rooms();
			throw new TypeError('expected_list_refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(ProgramVocabularySettingsAdapterError);
			expect((error as ProgramVocabularySettingsAdapterError).code)
				.toBe('program_vocabulary.event_required');
		}
	});
});
