import type {
	ProgramFormatDto,
	ProgramRoomDto,
	ProgramTrackDto,
	ProgramVocabularyDeleteEligibilityDto,
	ProgramVocabularySnapshotDto,
	ProgramVocabularyUsageDto
} from '@jooevents/contracts';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView,
	ProgramVocabularyDeleteAvailabilityView,
	ProgramVocabularySnapshotView,
	ProgramVocabularyUsageView
} from '../view-models/program-vocabulary';

type HandledSnapshotKey =
	| 'schemaVersion'
	| 'scope'
	| 'setVersion'
	| 'rooms'
	| 'tracks'
	| 'formats';
const handledSnapshotKeys: Record<
	Exclude<keyof ProgramVocabularySnapshotDto, HandledSnapshotKey>,
	never
> = {};
void handledSnapshotKeys;

function unreachable(value: never): never {
	throw new TypeError(`Unsupported Program Vocabulary contract variant: ${JSON.stringify(value)}`);
}

function mapUsage(usage: ProgramVocabularyUsageDto): ProgramVocabularyUsageView {
	return Object.freeze({
		currentReferences: usage.current,
		historicalPins: usage.historicalPins
	});
}

function mapDeleteAvailability(
	eligibility: ProgramVocabularyDeleteEligibilityDto
): ProgramVocabularyDeleteAvailabilityView {
	switch (eligibility.kind) {
		case 'eligible':
			return Object.freeze({ kind: 'available' });
		case 'blocked':
			return Object.freeze({
				kind: 'unavailable',
				currentReferences: eligibility.currentReferences,
				historicalPins: eligibility.historicalPins
			});
		default:
			return unreachable(eligibility);
	}
}

function mapCommon(item: ProgramRoomDto | ProgramTrackDto | ProgramFormatDto) {
	return {
		id: item.id,
		name: item.name,
		status: item.status,
		version: item.version,
		usage: mapUsage(item.usage),
		deleteAvailability: mapDeleteAvailability(item.deleteEligibility)
	} as const;
}

function mapRoom(room: ProgramRoomDto): ProgramRoomView {
	return Object.freeze({
		kind: 'room',
		...mapCommon(room),
		capacity: room.capacity
	});
}

function mapTrack(track: ProgramTrackDto): ProgramTrackView {
	return Object.freeze({ kind: 'track', ...mapCommon(track), accent: track.accent });
}

function mapFormat(format: ProgramFormatDto): ProgramFormatView {
	return Object.freeze({ kind: 'format', ...mapCommon(format) });
}

export function mapProgramVocabularySnapshot(
	snapshot: ProgramVocabularySnapshotDto
): ProgramVocabularySnapshotView {
	return Object.freeze({
		schemaVersion: snapshot.schemaVersion,
		scope: Object.freeze({ ...snapshot.scope }),
		setVersion: snapshot.setVersion,
		rooms: Object.freeze(snapshot.rooms.map(mapRoom)),
		tracks: Object.freeze(snapshot.tracks.map(mapTrack)),
		formats: Object.freeze(snapshot.formats.map(mapFormat))
	});
}
