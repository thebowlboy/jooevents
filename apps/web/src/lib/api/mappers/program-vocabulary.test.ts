import { describe, expect, test } from 'bun:test';
import {
	programVocabularyDraftDataSchema,
	programVocabularySnapshotSchema
} from '@jooevents/contracts';
import { mapProgramVocabularyDraft, mapProgramVocabularySnapshot } from './program-vocabulary';

const snapshot = programVocabularySnapshotSchema.parse({
	schemaVersion: 1,
	scope: {
		workspaceId: '550e8400-e29b-41d4-a716-446655440000',
		eventId: '018f7d5a-4b3c-7abc-8def-0123456789ab'
	},
	setVersion: 12,
	rooms: [
		{
			kind: 'room',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b0',
			name: 'Capacity unknown',
			status: 'active',
			version: 3,
			capacity: null,
			usage: { current: 0, historicalPins: 4 },
			deleteEligibility: { kind: 'blocked', currentReferences: 0, historicalPins: 4 }
		},
		{
			kind: 'room',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b1',
			name: 'Main hall',
			status: 'retired',
			version: 7,
			capacity: 320,
			usage: { current: 5, historicalPins: 9 },
			deleteEligibility: { kind: 'blocked', currentReferences: 5, historicalPins: 9 }
		}
	],
	tracks: [
		{
			kind: 'track',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b2',
			name: 'Applied AI',
			accent: 'sea',
			status: 'retired',
			version: 2,
			usage: { current: 8, historicalPins: 13 },
			deleteEligibility: { kind: 'blocked', currentReferences: 8, historicalPins: 13 }
		}
	],
	formats: [
		{
			kind: 'format',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b3',
			name: 'Workshop',
			status: 'active',
			version: 1,
			usage: { current: 0, historicalPins: 0 },
			deleteEligibility: { kind: 'eligible' }
		}
	]
});

describe('Program Vocabulary canonical-to-view mapping', () => {
	test('preserves scope, versions, lifecycle, canonical usage, and nullable capacity', () => {
		const view = mapProgramVocabularySnapshot(snapshot);

		expect(view).toEqual({
			schemaVersion: 1,
			scope: snapshot.scope,
			setVersion: 12,
			rooms: [
				{
					kind: 'room',
					id: snapshot.rooms[0]?.id,
					name: 'Capacity unknown',
					status: 'active',
					version: 3,
					capacity: null,
					usage: { currentReferences: 0, historicalPins: 4 },
					deleteAvailability: {
						kind: 'unavailable',
						currentReferences: 0,
						historicalPins: 4
					}
				},
				{
					kind: 'room',
					id: snapshot.rooms[1]?.id,
					name: 'Main hall',
					status: 'retired',
					version: 7,
					capacity: 320,
					usage: { currentReferences: 5, historicalPins: 9 },
					deleteAvailability: {
						kind: 'unavailable',
						currentReferences: 5,
						historicalPins: 9
					}
				}
			],
			tracks: [
				{
					kind: 'track',
					id: snapshot.tracks[0]?.id,
					name: 'Applied AI',
					accent: 'sea',
					status: 'retired',
					version: 2,
					usage: { currentReferences: 8, historicalPins: 13 },
					deleteAvailability: {
						kind: 'unavailable',
						currentReferences: 8,
						historicalPins: 13
					}
				}
			],
			formats: [
				{
					kind: 'format',
					id: snapshot.formats[0]?.id,
					name: 'Workshop',
					status: 'active',
					version: 1,
					usage: { currentReferences: 0, historicalPins: 0 },
					deleteAvailability: { kind: 'available' }
				}
			]
		});
	});

	test('does not invent the legacy sample vocabulary fields or alias canonical objects', () => {
		const view = mapProgramVocabularySnapshot(snapshot);
		const track = view.tracks[0];
		if (!track) throw new TypeError('expected_track');

		expect(Object.keys(track).sort()).toEqual([
			'accent',
			'deleteAvailability',
			'id',
			'kind',
			'name',
			'status',
			'usage',
			'version'
		]);
		expect(Object.keys(track.usage).sort()).toEqual(['currentReferences', 'historicalPins']);
		expect(track.accent).toBe('sea');
		expect('submissions' in track.usage).toBe(false);
		expect('sessions' in track.usage).toBe(false);
		expect('placements' in track.usage).toBe(false);
		expect(view.scope).not.toBe(snapshot.scope);
		expect(view.rooms).not.toBe(snapshot.rooms);
		expect(view.rooms[0]).not.toBe(snapshot.rooms[0]);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.rooms)).toBe(true);
		expect(Object.isFrozen(view.rooms[0])).toBe(true);
	});

	test('projects an inert draft receipt without implying an effective vocabulary mutation', () => {
		const draft = programVocabularyDraftDataSchema.parse({
			schemaVersion: 1,
			action: 'create',
			changesetId: '018f7d5a-4b3c-7abc-8def-0123456789b4',
			headVersion: 1,
			status: 'draft',
			revision: {
				id: '018f7d5a-4b3c-7abc-8def-0123456789b5',
				number: 1,
				digestSha256: 'a'.repeat(64)
			},
			riskTier: 'low',
			approvalPolicy: {
				reference: { key: 'approval.program_vocabulary.default', version: 1 },
				definitionDigestSha256: 'b'.repeat(64),
				requirement: 'none'
			},
			safeDiff: {
				action: 'create',
				before: null,
				after: {
					kind: 'room',
					id: '018f7d5a-4b3c-7abc-8def-0123456789b6',
					name: 'Breakout room',
					status: 'active',
					capacity: null,
					version: 1
				}
			}
		});

		const view = mapProgramVocabularyDraft(draft);
		expect(view).toEqual({
			schemaVersion: 1,
			changesetId: draft.changesetId,
			headVersion: 1,
			status: 'draft',
			revision: draft.revision,
			riskTier: 'low',
			approvalPolicy: {
				key: 'approval.program_vocabulary.default',
				version: 1,
				definitionDigestSha256: 'b'.repeat(64),
				requirement: 'none'
			},
			change: {
				action: 'create',
				before: null,
				after: {
					kind: 'room',
					id: '018f7d5a-4b3c-7abc-8def-0123456789b6',
					name: 'Breakout room',
					status: 'active',
					capacity: null,
					version: 1
				}
			}
		});
		expect('setVersion' in view).toBe(false);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.change)).toBe(true);
	});
});
