import { startOfZonedWeek } from '@jooevents/contracts';
import type { WorkspaceSummary } from '../types';
import type {
	PulseDecisionBreakdown,
	PulseFunnelWeek,
	PulseHero,
	PulseHeroFigure,
	PulsePageSummary,
	PulseSeries,
	PulseSeriesKey,
	PulseTrackFill,
	PulseWeek
} from '../pulse-page-port';

/**
 * The Pulse page's per-scenario stories. Weekly shapes are authored as counts
 * per weeks-ago and pinned to real event-local Mondays at read time, so the
 * charts hold on any day the workspace is opened — the same reason deadlines
 * stopped being authored as rendered strings.
 *
 * Each story must stay coherent with its scenario's other counters: the
 * breakdown sums to the decision denominator the Overview already states
 * ("6 of 14"), track proposals sum to the received total, and the recent
 * window equals the last two visible weeks. The port test enforces this.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;

interface SeriesStory {
	readonly total: number;
	readonly totalNote: string;
	/** Oldest first, one entry per week. Absent iff `absence` carries the reason. */
	readonly weekly?: readonly number[];
	readonly absence?: string;
}

interface PulseStory {
	readonly proposals: SeriesStory;
	readonly reviews: SeriesStory;
	readonly decisions: SeriesStory;
	/** The roster head count, as the hero band states it. */
	readonly speakers?: number;
	/**
	 * Accepted decisions per week, aligned with `decisions.weekly` and summing
	 * to the breakdown's accepted count — the funnel's innermost line.
	 */
	readonly acceptedWeekly?: readonly number[];
	/** Present while nothing has arrived; replaces the hero's figures and funnel. */
	readonly heroAbsence?: string;
	readonly breakdown: Omit<PulseDecisionBreakdown, 'rows'> & {
		readonly rows?: PulseDecisionBreakdown['rows'];
	};
	readonly tracks: PulseTrackFill;
}

const SERIES_LABEL: Readonly<Record<PulseSeriesKey, string>> = Object.freeze({
	proposals: 'Proposals received',
	reviews: 'Reviews committed',
	decisions: 'Decisions made'
});

/** A workspace whose event exists but where nothing has arrived yet. */
const beforeAnythingArrives: PulseStory = {
	proposals: {
		total: 0,
		totalNote: '',
		absence: 'Arrivals chart here once a form is open.'
	},
	reviews: {
		total: 0,
		totalNote: '',
		absence: 'Reviews chart here once a round opens.'
	},
	decisions: {
		total: 0,
		totalNote: '',
		absence: 'Decisions chart here once the first one is made.'
	},
	heroAbsence: 'The story appears here as proposals arrive.',
	breakdown: {
		total: 0,
		absence: 'The spread of answers appears here once proposals arrive.'
	},
	tracks: {
		rows: [],
		absence: 'Each track fills here as proposals are accepted.'
	}
};

const stories: Readonly<Record<string, PulseStory>> = Object.freeze({
	flight: {
		proposals: {
			total: 14,
			totalNote: 'since the CFP opened',
			weekly: [0, 0, 0, 0, 1, 2, 2, 3, 2, 2, 1, 1]
		},
		reviews: {
			total: 224,
			totalNote: 'in round 1',
			weekly: [0, 0, 0, 0, 0, 0, 0, 12, 35, 58, 63, 56]
		},
		decisions: {
			total: 6,
			totalNote: 'of 14 proposals',
			weekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 1]
		},
		speakers: 9,
		acceptedWeekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1],
		breakdown: {
			total: 14,
			rows: [
				{ state: 'accepted', count: 4 },
				{ state: 'waitlisted', count: 1 },
				{ state: 'declined', count: 1 },
				{ state: 'undecided', count: 8 }
			],
			note: 'Of the 8 waiting: 5 are in the inbox, 2 are set aside, 1 was marked as spam.'
		},
		tracks: {
			rows: [
				{ id: 'trk-web', name: 'Agents & Tools', speakers: 4, accepted: 2, proposals: 6 },
				{ id: 'trk-ai', name: 'Evals & Reliability', speakers: 3, accepted: 1, proposals: 4 },
				{ id: 'trk-infra', name: 'Models & Infrastructure', speakers: 2, accepted: 1, proposals: 4 }
			],
			rosterLine: '9 speakers are on the roster.'
		}
	},
	opening: {
		proposals: {
			total: 9,
			totalNote: 'since the CFP opened',
			weekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]
		},
		reviews: {
			total: 0,
			totalNote: '',
			absence: 'Reviews chart here once a round opens.'
		},
		decisions: {
			total: 0,
			totalNote: '',
			absence: 'Decisions chart here once the first one is made.'
		},
		speakers: 2,
		breakdown: {
			total: 9,
			absence: 'All 9 proposals are waiting for your answer.'
		},
		tracks: {
			rows: [],
			rosterLine: '2 speakers are on the roster; both invitations are outstanding.',
			absence: 'Each track fills here as proposals are accepted.'
		}
	},
	crunch: {
		proposals: {
			total: 16,
			totalNote: 'while the CFP was open',
			weekly: [1, 2, 3, 2, 3, 2, 2, 1, 0, 0, 0, 0]
		},
		reviews: {
			total: 983,
			totalNote: 'across both rounds',
			weekly: [0, 0, 0, 20, 45, 60, 75, 80, 85, 70, 90, 58]
		},
		decisions: {
			total: 6,
			totalNote: 'of 16 proposals',
			weekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]
		},
		speakers: 12,
		acceptedWeekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2],
		breakdown: {
			total: 16,
			rows: [
				{ state: 'accepted', count: 4 },
				{ state: 'declined', count: 2 },
				{ state: 'undecided', count: 10 }
			],
			note: 'Of the 10 waiting: 8 are in the inbox, 1 is set aside, 1 was marked as spam.'
		},
		tracks: {
			rows: [
				{ id: 'trk-web', name: 'Agents & Tools', speakers: 5, accepted: 2, proposals: 7 },
				{ id: 'trk-ai', name: 'Evals & Reliability', speakers: 4, accepted: 1, proposals: 5 },
				{ id: 'trk-infra', name: 'Models & Infrastructure', speakers: 3, accepted: 1, proposals: 4 }
			],
			rosterLine: '12 speakers are on the roster.'
		}
	},
	quiet: {
		proposals: {
			total: 10,
			totalNote: 'while the CFP was open',
			weekly: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
		},
		reviews: {
			total: 536,
			totalNote: 'across both rounds',
			weekly: [15, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]
		},
		decisions: {
			total: 10,
			totalNote: 'of 10 proposals',
			weekly: [0, 4, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]
		},
		speakers: 10,
		acceptedWeekly: [0, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		breakdown: {
			total: 10,
			rows: [
				{ state: 'accepted', count: 5 },
				{ state: 'waitlisted', count: 1 },
				{ state: 'declined', count: 4 }
			],
			note: 'Everyone has been told their result.'
		},
		tracks: {
			rows: [
				{ id: 'trk-web', name: 'Agents & Tools', speakers: 4, accepted: 2, proposals: 4 },
				{ id: 'trk-ai', name: 'Evals & Reliability', speakers: 3, accepted: 2, proposals: 3 },
				{ id: 'trk-infra', name: 'Models & Infrastructure', speakers: 3, accepted: 1, proposals: 3 }
			],
			rosterLine: '10 speakers are on the roster.'
		}
	}
});

/** The story behind a scenario key; created-event workspaces fall back to the
    before-anything state, which is also the honest answer for keys this module
    has never heard of. */
export function pulseStoryFor(scenarioKey: string): PulseStory {
	return stories[scenarioKey] ?? beforeAnythingArrives;
}

/**
 * Real event-local Mondays for the last `weeks` weeks, oldest first. Probing
 * from each Monday's noon keeps the step safe across daylight-saving
 * boundaries, where a flat 7 × 24 h stride can land a day off.
 */
function weekStarts(now: number, timezone: string, weeks: number): string[] {
	const current = startOfZonedWeek(now, timezone);
	if (current === null) return [];
	const out: string[] = [];
	for (let back = weeks - 1; back >= 0; back -= 1) {
		const probe = current - back * 7 * DAY_MS + 12 * 3_600_000;
		const start = startOfZonedWeek(probe, timezone) ?? probe - 12 * 3_600_000;
		out.push(new Date(start).toISOString());
	}
	return out;
}

/**
 * A weekly flow as a cumulative line: the window's weeks climb from whatever
 * had already accumulated before the window (`total − windowSum`), so the last
 * point always equals the all-time total.
 */
function cumulative(weekly: readonly number[], total: number): number[] {
	const windowSum = weekly.reduce((sum, count) => sum + count, 0);
	let running = total - windowSum;
	return weekly.map((count) => (running += count));
}

function buildHero(story: PulseStory, timezone: string, now: number): PulseHero {
	if (story.heroAbsence !== undefined) {
		return Object.freeze({ figures: Object.freeze([]), absence: story.heroAbsence });
	}
	const accepted = story.breakdown.rows?.find((row) => row.state === 'accepted')?.count ?? 0;

	// A figure whose flow has not begun is absent, not zero: the hero states
	// what the event has, never what it might one day measure.
	const figures: PulseHeroFigure[] = [
		{ label: 'Proposals', value: String(story.proposals.total) }
	];
	if (story.reviews.absence === undefined) {
		figures.push({ label: 'Reviews', value: String(story.reviews.total) });
	}
	if (story.decisions.absence === undefined) {
		figures.push({ label: 'Decided', value: String(story.decisions.total) });
		figures.push({ label: 'Accepted', value: String(accepted) });
	}
	if (story.speakers !== undefined) {
		figures.push({ label: 'Speakers', value: String(story.speakers) });
	}

	let funnel: readonly PulseFunnelWeek[] | undefined;
	if (story.proposals.weekly) {
		const starts = weekStarts(now, timezone, story.proposals.weekly.length);
		const received = cumulative(story.proposals.weekly, story.proposals.total);
		const decided =
			story.decisions.absence === undefined && story.decisions.weekly
				? cumulative(story.decisions.weekly, story.decisions.total)
				: null;
		const acceptedLine =
			decided && story.acceptedWeekly ? cumulative(story.acceptedWeekly, accepted) : null;
		funnel = Object.freeze(
			story.proposals.weekly.map((_, index) =>
				Object.freeze({
					startsAt: starts[index] ?? new Date(now).toISOString(),
					received: received[index]!,
					...(decided ? { decided: decided[index]! } : {}),
					...(acceptedLine ? { accepted: acceptedLine[index]! } : {})
				})
			)
		);
	}
	return Object.freeze({
		figures: Object.freeze(figures),
		...(funnel ? { funnel } : {})
	});
}

function buildSeries(input: {
	readonly key: PulseSeriesKey;
	readonly story: SeriesStory;
	readonly timezone: string;
	readonly now: number;
}): PulseSeries {
	const label = SERIES_LABEL[input.key];
	if (input.story.absence !== undefined || !input.story.weekly) {
		return Object.freeze({
			key: input.key,
			label,
			total: input.story.total,
			totalNote: input.story.totalNote,
			windowDays: WINDOW_DAYS,
			windowCount: 0,
			weeks: Object.freeze([]),
			absence:
				input.story.absence ?? 'Nothing has been recorded here yet.'
		});
	}
	const starts = weekStarts(input.now, input.timezone, input.story.weekly.length);
	const weeks: readonly PulseWeek[] = Object.freeze(
		input.story.weekly.map((count, index) =>
			Object.freeze({ startsAt: starts[index] ?? new Date(input.now).toISOString(), count })
		)
	);
	// The mock's window is the last two buckets — roughly the last fourteen
	// days. The live derivation computes the real window from fact timestamps.
	const windowCount = input.story.weekly.slice(-2).reduce((sum, count) => sum + count, 0);
	return Object.freeze({
		key: input.key,
		label,
		total: input.story.total,
		totalNote: input.story.totalNote,
		windowDays: WINDOW_DAYS,
		windowCount,
		weeks
	});
}

/** The Pulse summary for the active scenario. Event identity comes from the
    workspace summary, so the page can never claim an event the shell denies. */
export function samplePulseSummary(input: {
	readonly scenarioKey: string;
	readonly summary: WorkspaceSummary;
	readonly now: number;
}): PulsePageSummary {
	const event = input.summary.event;
	if (!event) {
		return Object.freeze({
			event: null,
			hero: Object.freeze({ figures: Object.freeze([]) }),
			series: Object.freeze([]),
			breakdown: Object.freeze({ total: 0, rows: Object.freeze([]) }),
			tracks: Object.freeze({ rows: Object.freeze([]) })
		});
	}
	const story = pulseStoryFor(input.scenarioKey);
	const timezone = event.timezone;
	return Object.freeze({
		event,
		hero: buildHero(story, timezone, input.now),
		series: Object.freeze(
			(['proposals', 'reviews', 'decisions'] as const).map((key) =>
				buildSeries({ key, story: story[key], timezone, now: input.now })
			)
		),
		breakdown: Object.freeze({
			total: story.breakdown.total,
			rows: Object.freeze(story.breakdown.rows ?? []),
			...(story.breakdown.note !== undefined ? { note: story.breakdown.note } : {}),
			...(story.breakdown.absence !== undefined ? { absence: story.breakdown.absence } : {})
		}),
		tracks: Object.freeze({
			rows: Object.freeze(story.tracks.rows),
			...(story.tracks.rosterLine !== undefined ? { rosterLine: story.tracks.rosterLine } : {}),
			...(story.tracks.absence !== undefined ? { absence: story.tracks.absence } : {})
		})
	});
}
