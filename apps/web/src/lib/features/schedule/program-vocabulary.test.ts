import { describe, expect, test } from 'bun:test';
import { mapProgramVocabularySnapshot } from '$lib/api/mappers/program-vocabulary';
import { configuredEventProgramFixture } from '$lib/api/event-program/fixtures';
import { buildScheduleVocabulary } from './program-vocabulary';

describe('Schedule Program Vocabulary projection', () => {
	test('offers only active items for new choices while resolving historical retired ids', () => {
		if (!configuredEventProgramFixture.vocabulary) throw new TypeError('expected_vocabulary_fixture');
		const source = mapProgramVocabularySnapshot(configuredEventProgramFixture.vocabulary);
		const retiredTrack = {
			...source.tracks[0]!,
			id: '018f7d5a-4b3c-7abc-8def-0123456789b9',
			name: 'Legacy track',
			status: 'retired' as const
		};
		const vocabulary = buildScheduleVocabulary({
			...source,
			tracks: [...source.tracks, retiredTrack]
		});

		expect(vocabulary.tracks.filter((option) => option.selectable).map((option) => option.label))
			.toEqual(['Applied AI']);
		expect(vocabulary.resolve('track', retiredTrack.id)).toEqual({
			id: retiredTrack.id,
			label: 'Legacy track',
			status: 'retired',
			selectable: false
		});
		expect(vocabulary.rooms[0]).toMatchObject({ label: 'Main hall', capacity: 320 });
	});
});
