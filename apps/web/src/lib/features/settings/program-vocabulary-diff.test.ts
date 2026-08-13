import { describe, expect, test } from 'bun:test';
import type { ProgramVocabularySafeDiff } from '@jooevents/contracts';
import { programVocabularyDiffRows } from './program-vocabulary-diff';

const track = {
	kind: 'track' as const,
	id: '0198f0f6-193d-7000-8000-000000000001',
	name: 'Platform',
	accent: 'sea' as const,
	status: 'active' as const,
	version: 2
};

describe('programVocabularyDiffRows', () => {
	test('describes an edit without hiding an unchanged item count', () => {
		const diff: ProgramVocabularySafeDiff = {
			action: 'edit',
			before: track,
			after: { ...track, name: 'Platform Engineering', version: 3 }
		};
		expect(programVocabularyDiffRows(diff)).toEqual([
			{ key: 'item:name', label: 'Track name', before: 'Platform', after: 'Platform Engineering' },
			{ key: 'item:version', label: 'Version', before: '2', after: '3' }
		]);
	});

	test('names merge destination, repoints, and preserved history', () => {
		const diff: ProgramVocabularySafeDiff = {
			action: 'merge',
			sourceBefore: track,
			sourceAfter: { ...track, status: 'retired', version: 3 },
			target: { ...track, id: '0198f0f6-193d-7000-8000-000000000002', name: 'Architecture', accent: 'neutral', version: 5 },
			liveRepoints: 4,
			historicalPinsPreserved: 7
		};
		const rows = programVocabularyDiffRows(diff);
		expect(rows).toContainEqual({ key: 'destination', label: 'Merge destination', before: 'Platform', after: 'Architecture' });
		expect(rows).toContainEqual({ key: 'repoints', label: 'Current references repointed', before: '0', after: '4' });
		expect(rows).toContainEqual({ key: 'history', label: 'Historical pins preserved', before: '0', after: '7' });
	});

	test('makes delete eligibility evidence visible in the review', () => {
		const diff: ProgramVocabularySafeDiff = {
			action: 'delete',
			before: track,
			after: null,
			usage: { current: 0, historicalPins: 0 }
		};
		const rows = programVocabularyDiffRows(diff);
		expect(rows).toContainEqual({ key: 'item:presence', label: 'Track', before: 'Present', after: 'Not present' });
		expect(rows).toContainEqual({ key: 'usage:current', label: 'Current references', before: '0', after: '0' });
	});
});
