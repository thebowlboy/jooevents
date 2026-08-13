import { describe, expect, test } from 'bun:test';
import { mapCurrentEvent } from '../mappers/event';
import { mapProgramVocabularySnapshot } from '../mappers/program-vocabulary';
import { createLiveEventProgramPort } from './live';
import {
	configuredEventProgramFixture,
	freshEventProgramFixture
} from './fixtures';
import { createSampleEventProgramPort } from './sample';

const generatedIds = [
	'018f7d5a-4b3c-7abc-8def-0123456789b4',
	'018f7d5a-4b3c-7abc-8def-0123456789b5',
	'018f7d5a-4b3c-7abc-8def-0123456789b6',
	'018f7d5a-4b3c-7abc-8def-0123456789b7',
	'018f7d5a-4b3c-7abc-8def-0123456789b8'
] as const;
const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';

function ids() {
	let index = 0;
	return () => generatedIds[index++] ?? generatedIds.at(-1)!;
}

describe('Event and Program Vocabulary aggregate ports', () => {
	test('maps canonical sample fixtures through the same view boundary and labels the source', async () => {
		const sample = createSampleEventProgramPort({
			fixture: configuredEventProgramFixture,
			createId: ids(),
			createCorrelationId: () => correlationId
		});
		expect(sample.port.source).toEqual({
			kind: 'sample', label: 'Configured event sample', resettable: true
		});

		const event = await sample.port.event.read();
		expect(event).toEqual({
			kind: 'success',
			data: mapCurrentEvent(configuredEventProgramFixture.currentEvent),
			correlationId
		});
		const vocabulary = await sample.port.vocabulary.read();
		if (!configuredEventProgramFixture.vocabulary) throw new TypeError('expected_vocabulary_fixture');
		expect(vocabulary).toEqual({
			kind: 'success',
			data: mapProgramVocabularySnapshot(configuredEventProgramFixture.vocabulary),
			correlationId
		});
	});

	test('keeps the sample first-run path resettable and idempotent', async () => {
		const sample = createSampleEventProgramPort({
			fixture: freshEventProgramFixture,
			createId: ids(),
			createCorrelationId: () => correlationId
		});
		expect(await sample.port.event.read()).toMatchObject({
			kind: 'success', data: { kind: 'no_event', eventSetVersion: 1 }
		});
		const input = {
			expectedEventSetVersion: 1,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20'
		};
		const first = await sample.port.event.create(input, { idempotencyKey: 'sample-event-create' });
		const replay = await sample.port.event.create(input, { idempotencyKey: 'sample-event-create' });
		expect(replay).toEqual(first);
		expect(first).toMatchObject({
			kind: 'success',
			receipt: { operationName: 'changeset.commit', operationVersion: 1 }
		});
		expect(await sample.port.event.read()).toMatchObject({
			kind: 'success', data: { kind: 'current_event', eventSetVersion: 2 }
		});
		expect(await sample.port.vocabulary.read()).toMatchObject({
			kind: 'success', data: { setVersion: 1, rooms: [], tracks: [], formats: [] }
		});

		sample.reset();
		expect(await sample.port.event.read()).toMatchObject({
			kind: 'success', data: { kind: 'no_event', eventSetVersion: 1 }
		});
		expect(await sample.port.vocabulary.read()).toMatchObject({
			kind: 'outcome', outcome: { kind: 'program_vocabulary.event_required' }
		});
	});

	test('returns sample vocabulary drafts as inert changesets without mutating effective state', async () => {
		const sample = createSampleEventProgramPort({
			fixture: configuredEventProgramFixture,
			createId: ids(),
			createCorrelationId: () => correlationId
		});
		const before = await sample.port.vocabulary.read();
		const drafted = await sample.port.vocabulary.draft({
			action: 'create',
			input: { kind: 'track', expectedSetVersion: 4, name: 'Platform engineering' }
		}, { idempotencyKey: 'sample-track-draft' });
		expect(drafted).toMatchObject({
			kind: 'success',
			data: { status: 'draft', change: { action: 'create', after: { name: 'Platform engineering' } } }
		});
		const after = await sample.port.vocabulary.read();
		expect(after).toEqual(before);
	});

	test('never substitutes sample data when a live manifest is unavailable', async () => {
		let requested = false;
		const live = createLiveEventProgramPort({
			manifest: {},
			eventRequest: {
				read: async () => {
					requested = true;
					throw new TypeError('should_not_request');
				},
				draft: async () => {
					requested = true;
					throw new TypeError('should_not_request');
				},
				changeset: async () => {
					requested = true;
					throw new TypeError('should_not_request');
				}
			},
			programVocabularyRequest: {
				read: async () => {
					requested = true;
					throw new TypeError('should_not_request');
				},
				draft: async () => {
					requested = true;
					throw new TypeError('should_not_request');
				}
			}
		});
		expect(live.source).toEqual({ kind: 'live' });
		expect(await live.event.read()).toEqual({
			kind: 'unavailable', reason: 'invalid_operation_manifest'
		});
		expect(await live.vocabulary.read()).toEqual({
			kind: 'unavailable', reason: 'invalid_operation_manifest'
		});
		expect(requested).toBe(false);
	});
});
