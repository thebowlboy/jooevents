import type {
	SchedulePlacementDraftData,
	SchedulePlacementOccurrenceDto,
	SchedulePlacementPlanDto,
	SchedulePlacementSnapshotDto
} from '@jooevents/contracts/schedule-placement';
import type {
	SchedulePlacementCommittedView,
	SchedulePlacementDraftView,
	SchedulePlacementOccurrenceView,
	SchedulePlacementPlanInputView,
	SchedulePlacementPlanView,
	SchedulePlacementScopeView,
	SchedulePlacementSnapshotView,
	SchedulePlacementUtcOnlyTimeBasisView
} from '../view-models/schedule-placement';

const UTC_ONLY_TIME_BASIS: SchedulePlacementUtcOnlyTimeBasisView = Object.freeze({
	kind: 'utc_instants_only',
	eventTimezone: null,
	localCalendarReady: false
});

function mapScope(scope: SchedulePlacementSnapshotDto['scope']): SchedulePlacementScopeView {
	return Object.freeze({ workspaceId: scope.workspaceId, eventId: scope.eventId });
}

export function mapSchedulePlacementOccurrence(
	occurrence: SchedulePlacementOccurrenceDto
): SchedulePlacementOccurrenceView {
	return Object.freeze({
		id: occurrence.id,
		sessionId: occurrence.sessionId,
		roomId: occurrence.roomId,
		startAtUtc: occurrence.startAt,
		endAtUtc: occurrence.endAt,
		version: occurrence.version
	});
}

export function mapSchedulePlacementSnapshot(
	snapshot: SchedulePlacementSnapshotDto
): SchedulePlacementSnapshotView {
	return Object.freeze({
		schemaVersion: 1,
		scope: mapScope(snapshot.scope),
		scheduleVersion: snapshot.scheduleVersion,
		timeBasis: UTC_ONLY_TIME_BASIS,
		occurrences: Object.freeze(snapshot.occurrences.map(mapSchedulePlacementOccurrence))
	});
}

function mapPlanInput(input: SchedulePlacementPlanDto['input']): SchedulePlacementPlanInputView {
	const scope = mapScope(input.scope);
	if (input.action === 'place') {
		return Object.freeze({
			action: input.action,
			scope,
			expectedScheduleVersion: input.expectedScheduleVersion,
			occurrenceId: input.occurrenceId,
			sessionId: input.sessionId,
			roomId: input.roomId,
			startAtUtc: input.startAt,
			endAtUtc: input.endAt
		});
	}
	if (input.action === 'move') {
		return Object.freeze({
			action: input.action,
			scope,
			expectedScheduleVersion: input.expectedScheduleVersion,
			occurrenceId: input.occurrenceId,
			expectedOccurrenceVersion: input.expectedOccurrenceVersion,
			roomId: input.roomId,
			startAtUtc: input.startAt,
			endAtUtc: input.endAt
		});
	}
	return Object.freeze({
		action: input.action,
		scope,
		expectedScheduleVersion: input.expectedScheduleVersion,
		occurrenceId: input.occurrenceId,
		expectedOccurrenceVersion: input.expectedOccurrenceVersion
	});
}

export function mapSchedulePlacementPlan(plan: SchedulePlacementPlanDto): SchedulePlacementPlanView {
	return Object.freeze({
		action: plan.input.action,
		input: mapPlanInput(plan.input),
		before: plan.before ? mapSchedulePlacementOccurrence(plan.before) : null,
		after: plan.after ? mapSchedulePlacementOccurrence(plan.after) : null,
		scheduleVersion: Object.freeze({ ...plan.scheduleVersion }),
		roomQueryGuard: Object.freeze({ ...plan.roomQueryGuard }),
		timeBasis: UTC_ONLY_TIME_BASIS
	});
}

export function mapSchedulePlacementDraft(
	draft: SchedulePlacementDraftData
): SchedulePlacementDraftView {
	return Object.freeze({
		schemaVersion: 1,
		action: draft.action,
		selector: Object.freeze({
			changesetId: draft.changesetId,
			revisionId: draft.revision.id,
			revisionDigest: draft.revision.digestSha256
		}),
		headVersion: draft.headVersion,
		status: draft.status,
		revisionNumber: draft.revision.number,
		riskTier: draft.riskTier,
		approval: Object.freeze({
			requirement: draft.approvalPolicy.requirement,
			policy: Object.freeze({ ...draft.approvalPolicy.reference }),
			policyDigestSha256: draft.approvalPolicy.definitionDigestSha256
		}),
		safeDiff: mapSchedulePlacementPlan(draft.safeDiff)
	});
}

export function mapSchedulePlacementCommit(input: {
	readonly draft: SchedulePlacementDraftData;
	readonly proposedHeadVersion: number;
	readonly committedHeadVersion: number;
}): SchedulePlacementCommittedView {
	const draft = mapSchedulePlacementDraft(input.draft);
	const occurrence = draft.safeDiff.after;
	if (occurrence === null) {
		throw new TypeError('Schedule placement commit has no placed occurrence.');
	}
	return Object.freeze({
		action: draft.action,
		selector: draft.selector,
		changesetHead: Object.freeze({
			proposedVersion: input.proposedHeadVersion,
			committedVersion: input.committedHeadVersion
		}),
		scheduleVersion: draft.safeDiff.scheduleVersion.after,
		occurrence,
		safeDiff: draft.safeDiff
	});
}
