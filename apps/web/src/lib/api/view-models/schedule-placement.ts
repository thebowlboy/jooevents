export interface SchedulePlacementScopeView {
	readonly workspaceId: string;
	readonly eventId: string;
}

/**
 * Placement contracts currently carry canonical UTC instants but no Event timezone.
 * The tuned calendar must not render event-local geometry until that evidence joins.
 */
export interface SchedulePlacementUtcOnlyTimeBasisView {
	readonly kind: 'utc_instants_only';
	readonly eventTimezone: null;
	readonly localCalendarReady: false;
}

export interface SchedulePlacementOccurrenceView {
	readonly id: string;
	readonly sessionId: string;
	readonly roomId: string;
	readonly startAtUtc: string;
	readonly endAtUtc: string;
	readonly version: number;
}

export interface SchedulePlacementSnapshotView {
	readonly schemaVersion: 1;
	readonly scope: SchedulePlacementScopeView;
	readonly scheduleVersion: number;
	readonly timeBasis: SchedulePlacementUtcOnlyTimeBasisView;
	readonly occurrences: readonly SchedulePlacementOccurrenceView[];
}

export type SchedulePlacementPlanInputView =
	| {
			readonly action: 'place';
			readonly scope: SchedulePlacementScopeView;
			readonly expectedScheduleVersion: number;
			readonly occurrenceId: string;
			readonly sessionId: string;
			readonly roomId: string;
			readonly startAtUtc: string;
			readonly endAtUtc: string;
	  }
	| {
			readonly action: 'move';
			readonly scope: SchedulePlacementScopeView;
			readonly expectedScheduleVersion: number;
			readonly occurrenceId: string;
			readonly expectedOccurrenceVersion: number;
			readonly roomId: string;
			readonly startAtUtc: string;
			readonly endAtUtc: string;
	  }
	| {
			readonly action: 'unplace';
			readonly scope: SchedulePlacementScopeView;
			readonly expectedScheduleVersion: number;
			readonly occurrenceId: string;
			readonly expectedOccurrenceVersion: number;
	  };

export interface SchedulePlacementPlanView {
	readonly action: 'place' | 'move' | 'unplace';
	readonly input: SchedulePlacementPlanInputView;
	readonly before: SchedulePlacementOccurrenceView | null;
	readonly after: SchedulePlacementOccurrenceView | null;
	readonly scheduleVersion: {
		readonly before: number;
		readonly after: number;
	};
	readonly roomQueryGuard: {
		readonly id: string;
		readonly version: number;
		readonly digestSha256: string;
	};
	readonly timeBasis: SchedulePlacementUtcOnlyTimeBasisView;
}

export interface SchedulePlacementDraftView {
	readonly schemaVersion: 1;
	readonly action: 'place' | 'move';
	readonly selector: {
		readonly changesetId: string;
		readonly revisionId: string;
		readonly revisionDigest: string;
	};
	readonly headVersion: number;
	readonly status: 'draft';
	readonly revisionNumber: number;
	readonly riskTier: 'normal';
	readonly approval: {
		readonly requirement: 'none';
		readonly policy: { readonly key: string; readonly version: number };
		readonly policyDigestSha256: string;
	};
	readonly safeDiff: SchedulePlacementPlanView;
}

export interface SchedulePlacementCommittedView {
	readonly action: 'place' | 'move';
	readonly selector: SchedulePlacementDraftView['selector'];
	readonly changesetHead: {
		readonly proposedVersion: number;
		readonly committedVersion: number;
	};
	readonly scheduleVersion: number;
	readonly occurrence: SchedulePlacementOccurrenceView;
	readonly safeDiff: SchedulePlacementPlanView;
}
