import type {
	ProgramFormatDto,
	ProgramRoomDto,
	ProgramTrackDto,
	ProgramVocabularyDeleteEligibilityDto,
	ProgramVocabularyDraftData,
	ProgramVocabularySafeDiff,
	ProgramVocabularySnapshotDto,
	ProgramVocabularyUsageDto
} from '@jooevents/contracts';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView,
	ProgramVocabularyDeleteAvailabilityView,
	ProgramVocabularyDiffItemView,
	ProgramVocabularyDraftChangeView,
	ProgramVocabularyDraftView,
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

type SafeDiffItem = Extract<ProgramVocabularySafeDiff, { action: 'create' }>['after'];

function mapDiffItem(item: SafeDiffItem): ProgramVocabularyDiffItemView {
	switch (item.kind) {
		case 'room':
			return Object.freeze({
				kind: item.kind,
				id: item.id,
				name: item.name,
				status: item.status,
				version: item.version,
				capacity: item.capacity
			});
		case 'track':
			return Object.freeze({
				kind: item.kind,
				id: item.id,
				name: item.name,
				accent: item.accent,
				status: item.status,
				version: item.version
			});
		case 'format':
			return Object.freeze({
				kind: item.kind,
				id: item.id,
				name: item.name,
				status: item.status,
				version: item.version
			});
		default:
			return unreachable(item);
	}
}

function mapDraftChange(diff: ProgramVocabularySafeDiff): ProgramVocabularyDraftChangeView {
	switch (diff.action) {
		case 'create':
			return Object.freeze({ action: diff.action, before: null, after: mapDiffItem(diff.after) });
		case 'edit':
		case 'retire':
		case 'restore':
			return Object.freeze({
				action: diff.action,
				before: mapDiffItem(diff.before),
				after: mapDiffItem(diff.after)
			});
		case 'delete':
			return Object.freeze({
				action: diff.action,
				before: mapDiffItem(diff.before),
				after: null,
				usage: mapUsage(diff.usage)
			});
		case 'merge':
			return Object.freeze({
				action: diff.action,
				sourceBefore: mapDiffItem(diff.sourceBefore),
				sourceAfter: mapDiffItem(diff.sourceAfter),
				target: mapDiffItem(diff.target),
				liveRepoints: diff.liveRepoints,
				historicalPinsPreserved: diff.historicalPinsPreserved
			});
		case 'merge_compensation':
			throw new TypeError('A draft result cannot contain a merge compensation diff.');
		default:
			return unreachable(diff);
	}
}

export function mapProgramVocabularyDraft(draft: ProgramVocabularyDraftData): ProgramVocabularyDraftView {
	if (draft.safeDiff.action !== draft.action) {
		throw new TypeError('Program Vocabulary draft action does not match its safe diff.');
	}
	return Object.freeze({
		schemaVersion: draft.schemaVersion,
		changesetId: draft.changesetId,
		headVersion: draft.headVersion,
		status: draft.status,
		revision: Object.freeze({ ...draft.revision }),
		riskTier: draft.riskTier,
		approvalPolicy: Object.freeze({
			key: draft.approvalPolicy.reference.key,
			version: draft.approvalPolicy.reference.version,
			definitionDigestSha256: draft.approvalPolicy.definitionDigestSha256,
			requirement: draft.approvalPolicy.requirement
		}),
		change: mapDraftChange(draft.safeDiff)
	});
}
