import type { MutationOutcome, PipelineStage, WorkspaceSummary } from './types';

export type OverviewPageSource =
	| {
			readonly kind: 'sample';
			readonly scenario: {
				readonly key: string;
				readonly name: string;
				readonly description: string;
			};
	  }
	| { readonly kind: 'live' };

export type OverviewSectionAvailability =
	| { readonly kind: 'available' }
	/**
	 * The prerequisite this region runs on is *provably* unmet on this event —
	 * a fact about the event, not an absence of wiring. `condition` is the one
	 * sentence naming what turns it on, and it may only be claimed where the
	 * projection can prove the prerequisite unmet.
	 */
	| { readonly kind: 'locked'; readonly condition: string }
	/** No measurement exists, or the projection declines to answer. */
	| { readonly kind: 'unavailable'; readonly message: string };

export interface OverviewPipelineStage extends Omit<PipelineStage, 'state'> {
	/**
	 * Only meaningful while `availability.kind === 'available'`. Locked and
	 * unavailable lanes carry `'unavailable'` as the no-health-claim value, so
	 * every consumer must branch on `availability` before reading `state`.
	 */
	readonly state: PipelineStage['state'] | 'unavailable';
	/**
	 * An unavailable lane preserves orientation without claiming that an area
	 * capability is evidence of event-stage progress; a locked lane states the
	 * event fact that has not happened yet.
	 */
	readonly availability: OverviewSectionAvailability;
}

export interface OverviewPageSummary extends Omit<WorkspaceSummary, 'pipeline'> {
	readonly pipeline: readonly OverviewPipelineStage[];
	readonly sections: {
		readonly attention: OverviewSectionAvailability;
		readonly pipeline: OverviewSectionAvailability;
		readonly deadlines: OverviewSectionAvailability;
		readonly activity: OverviewSectionAvailability;
		readonly trays: OverviewSectionAvailability;
	};
}

export type OverviewPageReadResult =
	| { readonly kind: 'success'; readonly data: OverviewPageSummary }
	| {
			readonly kind: 'unavailable';
			readonly message: string;
			readonly correlationId?: string;
	  }
	| {
			readonly kind: 'transport_error';
			readonly retryable: boolean;
			readonly correlationId?: string;
	  };

export interface OverviewCreateEventInput {
	readonly name: string;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string;
	readonly idempotencyKey: string;
}

export interface OverviewPagePort {
	readonly source: OverviewPageSource;
	/** Synchronous evidence used only to choose truthful first-paint geometry. */
	snapshot(): OverviewPageSummary | null;
	read(options?: { readonly signal?: AbortSignal }): Promise<OverviewPageReadResult>;
	createEvent(input: OverviewCreateEventInput): Promise<MutationOutcome>;
}

export const overviewAvailable = Object.freeze({ kind: 'available' as const });

