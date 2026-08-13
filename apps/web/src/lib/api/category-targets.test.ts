import { describe, expect, test } from 'bun:test';
import { deriveProgramTrackAccent } from '@jooevents/contracts';
import {
	categoryTargetChoices,
	categoryTargetLabel,
	targetForCategoryChoice
} from './category-targets';
import type { ProgramVocabularySnapshotView } from './view-models/program-vocabulary';

const trackAId = '018f7d5a-4b3c-7abc-8def-0123456789a1';
const trackBId = '018f7d5a-4b3c-7abc-8def-0123456789b2';
const retiredTrackId = '018f7d5a-4b3c-7abc-8def-0123456789c3';

function item(kind: 'track', id: string, name: string, status: 'active' | 'retired'): ProgramVocabularySnapshotView['tracks'][number];
function item(kind: 'format', id: string, name: string, status: 'active' | 'retired'): ProgramVocabularySnapshotView['formats'][number];
function item(
	kind: 'track' | 'format',
	id: string,
	name: string,
	status: 'active' | 'retired'
): ProgramVocabularySnapshotView['tracks'][number] | ProgramVocabularySnapshotView['formats'][number] {
	const common = {
		kind,
		id,
		name,
		status,
		version: 1,
		usage: { currentReferences: 0, historicalPins: 0 },
		deleteAvailability: { kind: 'available' as const }
	};
	return kind === 'track'
		? { ...common, kind, accent: deriveProgramTrackAccent(id) }
		: { ...common, kind };
}

const snapshot: ProgramVocabularySnapshotView = {
	schemaVersion: 1,
	scope: {
		workspaceId: '550e8400-e29b-41d4-a716-446655440000',
		eventId: '018f7d5a-4b3c-7abc-8def-0123456789ab'
	},
	setVersion: 7,
	rooms: [],
	tracks: [
		item('track', trackAId, 'Track A', 'active'),
		item('track', trackBId, 'Track B', 'active'),
		item('track', retiredTrackId, 'Legacy systems', 'retired')
	],
	formats: [item('format', '018f7d5a-4b3c-7abc-8def-0123456789d4', 'Workshop', 'active')]
};

describe('category target presentation', () => {
	test('resolves a Track B reference to Track B rather than the first matching kind', () => {
		expect(categoryTargetLabel({
			kind: 'category',
			categoryKind: 'track',
			categoryId: trackBId
		}, { kind: 'ready', snapshot })).toBe('Track · Track B');
	});

	test('keeps retired names visible and states a missing reference without exposing its id', () => {
		expect(categoryTargetLabel({
			kind: 'category',
			categoryKind: 'track',
			categoryId: retiredTrackId
		}, { kind: 'ready', snapshot })).toBe('Track · Legacy systems (retired)');

		const missingId = '018f7d5a-4b3c-7abc-8def-0123456789e5';
		const label = categoryTargetLabel({
			kind: 'category',
			categoryKind: 'track',
			categoryId: missingId
		}, { kind: 'ready', snapshot });
		expect(label).toBe('Track no longer available');
		expect(label).not.toContain(missingId);
	});

	test('offers only active entries and returns the exact typed target selected', () => {
		const choices = categoryTargetChoices(snapshot);
		expect(choices.map(({ kind, name }) => ({ kind, name }))).toEqual([
			{ kind: 'general_pool', name: 'General pool' },
			{ kind: 'track', name: 'Track A' },
			{ kind: 'track', name: 'Track B' },
			{ kind: 'format', name: 'Workshop' }
		]);
		expect(targetForCategoryChoice(choices, `track:${trackBId}`)).toEqual({
			kind: 'category',
			category: { kind: 'track', id: trackBId }
		});
		expect(targetForCategoryChoice(choices, `track:${retiredTrackId}`)).toBeNull();
	});
});
