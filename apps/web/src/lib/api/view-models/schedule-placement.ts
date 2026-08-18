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

export interface ScheduleBreakHeadView {
	readonly id: string;
	readonly label: string;
	readonly dayKey: string;
	readonly roomId: string;
	readonly startMin: number;
	readonly endMin: number;
	readonly status: 'active' | 'removed';
	readonly version: number;
}

export interface SchedulePlacementSnapshotView {
	readonly schemaVersion: 1;
	readonly scope: SchedulePlacementScopeView;
	readonly scheduleVersion: number;
	readonly timeBasis: SchedulePlacementUtcOnlyTimeBasisView;
	readonly occurrences: readonly SchedulePlacementOccurrenceView[];
	readonly breaks: readonly ScheduleBreakHeadView[];
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

export interface ScheduleOccurrencePlacementCommittedView {
	readonly action: 'place' | 'move' | 'unplace';
	readonly scheduleVersion: number;
	readonly occurrence: SchedulePlacementOccurrenceView | null;
}

export interface ScheduleBreakCommittedView {
	readonly action: 'break_add' | 'break_remove' | 'break_restore';
	readonly scheduleVersion: number;
	readonly breaks: readonly ScheduleBreakHeadView[];
}

export type SchedulePlacementCommittedView =
	| ScheduleOccurrencePlacementCommittedView
	| ScheduleBreakCommittedView;
