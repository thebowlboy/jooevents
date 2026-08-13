import {
	currentEventProjectionSchema,
	deriveProgramTrackAccent,
	programVocabularySnapshotSchema,
	type CurrentEventProjection,
	type ProgramVocabularySnapshotDto
} from '@jooevents/contracts';

export interface EventProgramSampleFixture {
	readonly key: 'fresh' | 'configured';
	readonly label: string;
	readonly currentEvent: CurrentEventProjection;
	readonly vocabulary: ProgramVocabularySnapshotDto | null;
}

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789ab';

export const freshEventProgramFixture: EventProgramSampleFixture = Object.freeze({
	key: 'fresh',
	label: 'Fresh workspace sample',
	currentEvent: currentEventProjectionSchema.parse({
		schemaVersion: 1,
		kind: 'no_event',
		eventSetVersion: 1
	}),
	vocabulary: null
});

export const configuredEventProgramFixture: EventProgramSampleFixture = Object.freeze({
	key: 'configured',
	label: 'Configured event sample',
	currentEvent: currentEventProjectionSchema.parse({
		schemaVersion: 1,
		kind: 'current_event',
		eventSetVersion: 2,
		event: {
			id: eventId,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20',
			version: 1
		}
	}),
	vocabulary: programVocabularySnapshotSchema.parse({
		schemaVersion: 1,
		scope: { workspaceId, eventId },
		setVersion: 4,
		rooms: [
			{
				kind: 'room',
				id: '018f7d5a-4b3c-7abc-8def-0123456789b0',
				name: 'Main hall',
				status: 'active',
				version: 2,
				capacity: 320,
				usage: { current: 5, historicalPins: 9 },
				deleteEligibility: { kind: 'blocked', currentReferences: 5, historicalPins: 9 }
			},
			{
				kind: 'room',
				id: '018f7d5a-4b3c-7abc-8def-0123456789b1',
				name: 'Workshop room',
				status: 'active',
				version: 1,
				capacity: null,
				usage: { current: 0, historicalPins: 0 },
				deleteEligibility: { kind: 'eligible' }
			}
		],
		tracks: [{
			kind: 'track',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b2',
			name: 'Applied AI',
			accent: deriveProgramTrackAccent('018f7d5a-4b3c-7abc-8def-0123456789b2'),
			status: 'active',
			version: 1,
			usage: { current: 8, historicalPins: 13 },
			deleteEligibility: { kind: 'blocked', currentReferences: 8, historicalPins: 13 }
		}],
		formats: [{
			kind: 'format',
			id: '018f7d5a-4b3c-7abc-8def-0123456789b3',
			name: 'Workshop',
			status: 'active',
			version: 1,
			usage: { current: 2, historicalPins: 6 },
			deleteEligibility: { kind: 'blocked', currentReferences: 2, historicalPins: 6 }
		}]
	})
});

export const eventProgramSampleFixtures = Object.freeze([
	freshEventProgramFixture,
	configuredEventProgramFixture
]);
