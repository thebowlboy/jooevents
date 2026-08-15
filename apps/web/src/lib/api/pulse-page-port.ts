import type { DecisionState, EventInfo } from './types';

/**
 * The Pulse page: descriptive metrics with a heartbeat. Everything served
 * here is a projection of state that already exists — event-stamped facts
 * bucketed by week (flows), and current heads (stocks). The page never
 * renders a pace verdict; progress-against-the-clock belongs to the
 * Overview's pipeline lanes, and duplicating it here would give one fact two
 * competing presentations.
 */

export type PulsePageSource =
	| {
			readonly kind: 'sample';
			readonly scenario: {
				readonly key: string;
				readonly name: string;
				readonly description: string;
			};
	  }
	| { readonly kind: 'live' };

/** One event-local week's worth of a flow, as the arrivals engine buckets it. */
export interface PulseWeek {
	/** The event-local Monday this week begins on, as an instant. */
	readonly startsAt: string;
	readonly count: number;
}

export type PulseSeriesKey = 'proposals' | 'reviews' | 'decisions';

/**
 * One heartbeat: a running total and its weekly movement. Flows only —
 * events that carry their own timestamps. A historical level ("pending over
 * the last month") is not reconstructible from current heads and is
 * deliberately not part of this shape.
 */
export interface PulseSeries {
	readonly key: PulseSeriesKey;
	/** What is being counted, e.g. "Proposals received". */
	readonly label: string;
	/** The all-time total, which may exceed the sum of the visible weeks. */
	readonly total: number;
	/** What the total spans, completing the label's sentence: "since the CFP opened". */
	readonly totalNote: string;
	/** The recency window the count below covers, in days. */
	readonly windowDays: number;
	/** How many landed inside that window. */
	readonly windowCount: number;
	/** Oldest first; the last entry is the week in progress. Empty iff `absence`. */
	readonly weeks: readonly PulseWeek[];
	/**
	 * Present while this flow has not begun. Absence of measurement is never
	 * rendered as a zero chart, so the panel states why it is empty and what
	 * will appear — the sentence is authored where the data is, because only
	 * the source knows the reason.
	 */
	readonly absence?: string;
}

/** One headline number in the hero band — the figures an organizer loves to see. */
export interface PulseHeroFigure {
	readonly label: string;
	readonly value: string;
}

/**
 * One week of the cumulative funnel, oldest first. All three counts share one
 * unit (proposals) and one axis: received ⊇ decided ⊇ accepted at every week,
 * each monotonically non-decreasing. A series that has not begun is absent
 * from every week rather than drawn as a zero line — absence of measurement
 * is never a flat line.
 */
export interface PulseFunnelWeek {
	readonly startsAt: string;
	readonly received: number;
	readonly decided?: number;
	readonly accepted?: number;
}

export interface PulseHero {
	/** Authored order; a figure whose flow has not begun is simply absent. */
	readonly figures: readonly PulseHeroFigure[];
	/** The story drawn: cumulative received/decided/accepted, oldest first. */
	readonly funnel?: readonly PulseFunnelWeek[];
	/** Present while nothing has arrived; replaces figures and funnel. */
	readonly absence?: string;
}

/** One decision state's share of the whole received population. */
export interface PulseDecisionRow {
	readonly state: DecisionState;
	readonly count: number;
}

export interface PulseDecisionBreakdown {
	/** Every proposal ever received — the denominator the rows sum to. */
	readonly total: number;
	/** Fixed canonical order; zero-count states are simply absent. */
	readonly rows: readonly PulseDecisionRow[];
	/**
	 * Custody said once, in words: which of the undecided sit set aside or
	 * marked as spam. Custody and decision are different axes, and mixing them
	 * into one row set would double-count.
	 */
	readonly note?: string;
	/** Present while deciding has not begun; replaces the rows. */
	readonly absence?: string;
}

/** How one track is filling: honest counts, no invented target. */
export interface PulseTrackRow {
	readonly id: string;
	readonly name: string;
	/** Roster speakers whose engagement resolves to this track. */
	readonly speakers: number;
	readonly accepted: number;
	/** Everything received for this track — volume, not a completion target. */
	readonly proposals: number;
}

export interface PulseTrackFill {
	/**
	 * In the event's own vocabulary order. Presentation may rank rows by
	 * magnitude for comparison, but track accents always resolve from this
	 * order so a track wears one colour whatever its current rank.
	 */
	readonly rows: readonly PulseTrackRow[];
	/** The roster's current head count, in a sentence: "9 speakers are on the roster." */
	readonly rosterLine?: string;
	/** Present while no proposal has been accepted; replaces the rows. */
	readonly absence?: string;
}

export interface PulsePageSummary {
	readonly event: EventInfo | null;
	readonly hero: PulseHero;
	readonly series: readonly PulseSeries[];
	readonly breakdown: PulseDecisionBreakdown;
	readonly tracks: PulseTrackFill;
}

export type PulsePageReadResult =
	| { readonly kind: 'success'; readonly data: PulsePageSummary }
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

export interface PulsePagePort {
	readonly source: PulsePageSource;
	/** Synchronous evidence used only to choose truthful first-paint geometry. */
	snapshot(): PulsePageSummary | null;
	read(options?: { readonly signal?: AbortSignal }): Promise<PulsePageReadResult>;
}
