import {
	deriveProgramTrackAccent,
	currentEventProjectionSchema,
	programVocabularySnapshotSchema,
	type ProgramVocabularyDeleteEligibilityDto,
	type ProgramVocabularySnapshotDto
} from '@jooevents/contracts';
import { createContext } from 'svelte';
import {
	createSampleEventProgramPort,
	type ResettableEventProgramSampleComposition
} from '../event-program/sample';
import type { EventProgramSampleFixture } from '../event-program/fixtures';
import { intakeFormsFixtureIds } from '../fixtures/intake-forms';
import { createIntakeFormsSamplePort, type IntakeFormsSamplePort } from '../sample/intake-forms';
import {
	createSampleIntakeSubmissionsPort,
	type ResettableSampleIntakeSubmissionsPort
} from '../sample/intake-submissions';
import type { WorkspaceDataset } from '../sample/dataset';
import type { OrganizerSubmissionsPort } from '../view-models/intake-submissions';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

interface ScenarioProjection {
	readonly fixture: EventProgramSampleFixture;
	readonly submissionsDataset: Pick<
		WorkspaceDataset,
		'key' | 'name' | 'description' | 'tracks' | 'formats' | 'submissions'
	>;
}

function eligibility(current: number): ProgramVocabularyDeleteEligibilityDto {
	return current === 0
		? { kind: 'eligible' }
		: { kind: 'blocked', currentReferences: current, historicalPins: 0 };
}

/**
 * Projects the selected broad demo scenario into canonical browser contracts.
 * The deterministic IDs are shared with the submissions projection, so category
 * labels resolve without allowing legacy sample identifiers into live-shaped data.
 */
export function projectSampleScenario(dataset: WorkspaceDataset): ScenarioProjection {
	if (!dataset.summary.event || !dataset.settings) {
		return {
			fixture: {
				key: 'fresh',
				label: dataset.name,
				currentEvent: currentEventProjectionSchema.parse({
					schemaVersion: 1,
					kind: 'no_event',
					eventSetVersion: 1
				}),
				vocabulary: null
			},
			submissionsDataset: {
				key: dataset.key,
				name: dataset.name,
				description: dataset.description,
				tracks: [],
				formats: [],
				submissions: []
			}
		};
	}

	const trackIds = new Map(dataset.tracks.map((track, index) => [
		track.id,
		index === 0 ? intakeFormsFixtureIds.track : id(1_000 + index)
	]));
	const formatIds = new Map(dataset.formats.map((format, index) => [format.id, id(2_000 + index)]));
	const roomIds = new Map(dataset.schedule.rooms.map((room, index) => [room.id, id(3_000 + index)]));
	const currentTrackReferences = (trackId: string) =>
		dataset.submissions.filter((submission) => submission.trackId === trackId).length
		+ dataset.schedule.sessions.filter((session) => session.trackId === trackId).length;
	const currentFormatReferences = (formatId: string) =>
		dataset.submissions.filter((submission) => submission.formatId === formatId).length
		+ dataset.schedule.sessions.filter((session) => session.formatId === formatId).length;
	const currentRoomReferences = (roomId: string) =>
		dataset.schedule.placements.filter((placement) => placement.roomId === roomId).length;

	const vocabulary: ProgramVocabularySnapshotDto = programVocabularySnapshotSchema.parse({
		schemaVersion: 1,
		scope: {
			workspaceId: intakeFormsFixtureIds.workspace,
			eventId: intakeFormsFixtureIds.event
		},
		setVersion: 1,
		rooms: dataset.schedule.rooms.map((room) => {
			const current = currentRoomReferences(room.id);
			return {
				kind: 'room' as const,
				id: roomIds.get(room.id),
				name: room.name,
				status: room.status ?? 'active',
				version: 1,
				capacity: room.capacity,
				usage: { current, historicalPins: 0 },
				deleteEligibility: eligibility(current)
			};
		}).sort((left, right) => left.id!.localeCompare(right.id!)),
		tracks: dataset.tracks.map((track) => {
			const current = currentTrackReferences(track.id);
			const trackId = trackIds.get(track.id)!;
			return {
				kind: 'track' as const,
				id: trackId,
				name: track.name,
				accent: deriveProgramTrackAccent(trackId),
				status: track.status ?? 'active',
				version: 1,
				usage: { current, historicalPins: 0 },
				deleteEligibility: eligibility(current)
			};
		}).sort((left, right) => left.id!.localeCompare(right.id!)),
		formats: dataset.formats.map((format) => {
			const current = currentFormatReferences(format.id);
			return {
				kind: 'format' as const,
				id: formatIds.get(format.id),
				name: format.name,
				status: format.status ?? 'active',
				version: 1,
				usage: { current, historicalPins: 0 },
				deleteEligibility: eligibility(current)
			};
		}).sort((left, right) => left.id!.localeCompare(right.id!))
	});
	const startDate = dataset.settings.startDate ?? '2027-01-01';
	const endDate = dataset.settings.endDate ?? startDate;

	return {
		fixture: {
			key: 'configured',
			label: dataset.name,
			currentEvent: currentEventProjectionSchema.parse({
				schemaVersion: 1,
				kind: 'current_event',
				eventSetVersion: 1,
				event: {
					id: intakeFormsFixtureIds.event,
					name: dataset.settings.name,
					timezone: dataset.settings.timezone,
					startDate,
					endDate,
					version: 1
				}
			}),
			vocabulary
		},
		submissionsDataset: {
			key: dataset.key,
			name: dataset.name,
			description: dataset.description,
			tracks: dataset.tracks.map((track) => ({ ...track, id: trackIds.get(track.id)! })),
			formats: dataset.formats.map((format) => ({ ...format, id: formatIds.get(format.id)! })),
			submissions: dataset.submissions.map((submission) => ({
				...submission,
				trackId: trackIds.get(submission.trackId) ?? submission.trackId,
				formatId: formatIds.get(submission.formatId) ?? submission.formatId
			}))
		}
	};
}

export interface SampleWorkspacePorts {
	readonly scenario: Pick<WorkspaceDataset, 'key' | 'name' | 'description'>;
	readonly eventProgram: ResettableEventProgramSampleComposition['port'];
	readonly forms: IntakeFormsSamplePort;
	readonly submissions: OrganizerSubmissionsPort;
	reset(): void;
}

export function createSampleWorkspacePorts(dataset: WorkspaceDataset): SampleWorkspacePorts {
	const projection = projectSampleScenario(dataset);
	const eventProgram = createSampleEventProgramPort({ fixture: projection.fixture });
	const forms = createIntakeFormsSamplePort();
	const submissions: ResettableSampleIntakeSubmissionsPort = createSampleIntakeSubmissionsPort({
		dataset: projection.submissionsDataset,
		contactCapability: { kind: 'available' }
	});
	return Object.freeze({
		scenario: Object.freeze({ key: dataset.key, name: dataset.name, description: dataset.description }),
		eventProgram: eventProgram.port,
		forms,
		submissions,
		reset() {
			eventProgram.reset();
			forms.reset();
			submissions.reset();
		}
	});
}

export const [useSampleWorkspacePorts, setSampleWorkspacePorts] =
	createContext<SampleWorkspacePorts>();
