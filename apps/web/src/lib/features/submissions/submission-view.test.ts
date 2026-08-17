import { describe, expect, test } from 'bun:test';
import {
	NO_TRACK_SCOPE,
	TRAY_ORDER,
	awaitsNotice,
	decisionStatus,
	decisionStatusFor,
	formatLabel,
	hasNoTrack,
	isNoTrackScope,
	decisionCellFor,
	journeyOf,
	noticeAge,
	noticeStatus,
	reviewSummary,
	rowsInTrackScope,
	trackLabel,
	trackOrder,
	trackQuery,
	trayLabels,
	trayScopes
} from './submission-view';
import type { Format, Submission, Track, TrayKey } from '$lib/api/types';

const usage = { submissions: 2, sessions: 1, placements: 0 };

const tracks: Track[] = [
	{ id: 'trk-ai', name: 'Agent Systems', accent: 'lavender', status: 'active', usage },
	{ id: 'trk-web', name: 'Organizer Craft', accent: 'sea', status: 'active', usage },
	{ id: 'trk-old', name: 'Retired Track', accent: 'neutral', status: 'retired', usage }
];

const formats: Format[] = [{ id: 'fmt-talk', name: 'Talk', status: 'active', usage }];

function row(overrides: Partial<Submission> = {}): Submission {
	return {
		id: 'sub-1',
		title: 'A submission',
		abstract: '',
		speakers: [{ name: 'Ada', email: 'ada@example.com' }],
		trackId: 'trk-ai',
		formatId: 'fmt-talk',
		submittedAt: '2026-08-01T10:00:00.000Z',
		source: 'cfp',
		tray: 'inbox',
		decision: 'undecided',
		notified: false,
		signals: [],
		reviewCount: 0,
		...overrides
	};
}

describe('a vocabulary value the surface may state', () => {
	test('a known id resolves to its name', () => {
		expect(trackLabel(tracks, 'trk-ai')).toEqual({ kind: 'named', name: 'Agent Systems' });
		expect(formatLabel(formats, 'fmt-talk')).toEqual({ kind: 'named', name: 'Talk' });
	});

	// A retired track still names the submissions that carry it. Filters offer
	// what may be chosen now; naming is permanent.
	test('a retired track still names its rows', () => {
		expect(trackLabel(tracks, 'trk-old')).toEqual({ kind: 'named', name: 'Retired Track' });
	});

	// The defect this type exists for: `?? id` turned an empty track into an
	// empty capsule and an unknown one into a raw identifier. Neither is a name.
	test('an empty id is an absence, not a label', () => {
		expect(trackLabel(tracks, '')).toEqual({ kind: 'none' });
		expect(trackLabel(tracks, '   ')).toEqual({ kind: 'none' });
		expect(formatLabel(formats, '')).toEqual({ kind: 'none' });
	});

	// Before the vocabulary read lands, `tracks` is empty for every row. Saying
	// "No track" then would be a claim the surface cannot yet make.
	test('an id the vocabulary cannot name says nothing at all', () => {
		expect(trackLabel([], 'trk-ai')).toEqual({ kind: 'unresolved' });
		expect(trackLabel(tracks, 'trk-ghost')).toEqual({ kind: 'unresolved' });
	});

	test('the accent order is the event own track order', () => {
		expect(trackOrder(tracks)).toEqual(['trk-ai', 'trk-web', 'trk-old']);
	});
});

describe('the untracked scope', () => {
	test('is a reserved id in the same control and the same address key', () => {
		expect(NO_TRACK_SCOPE).toBe('none');
		expect(isNoTrackScope('none')).toBe(true);
		expect(isNoTrackScope('trk-ai')).toBe(false);
		expect(isNoTrackScope('')).toBe(false);
	});

	// It is not a track, so it is not a track filter: the tray comes back whole
	// and the narrowing happens over rows the surface already holds.
	test('never reaches the port as a track filter', () => {
		expect(trackQuery('none')).toBeUndefined();
		expect(trackQuery('')).toBeUndefined();
		expect(trackQuery('trk-ai')).toBe('trk-ai');
	});

	test('selects exactly the rows carrying no track', () => {
		const rows = [
			row({ id: 'a', trackId: 'trk-ai' }),
			row({ id: 'b', trackId: '' }),
			row({ id: 'c', trackId: '  ' })
		];
		expect(rowsInTrackScope(rows, NO_TRACK_SCOPE).map((entry) => entry.id)).toEqual(['b', 'c']);
		expect(rowsInTrackScope(rows, '').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
		// A real track id is the port's filter, so nothing is dropped again here.
		expect(rowsInTrackScope(rows, 'trk-ai').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
	});

	test('emptiness is knowable before the vocabulary is', () => {
		expect(hasNoTrack({ trackId: '' })).toBe(true);
		expect(hasNoTrack({ trackId: 'trk-ai' })).toBe(false);
	});
});

describe('the tray scope set', () => {
	const totals: Record<TrayKey, number> = { inbox: 9, 'set-aside': 3, late: 1, spam: 4 };

	test('carries all four members, in funnel order, with their counts', () => {
		const scopes = trayScopes(totals);
		expect(scopes.map((scope) => scope.value)).toEqual([...TRAY_ORDER]);
		expect(scopes.map((scope) => scope.label)).toEqual(['Inbox', 'Set aside', 'Late', 'Spam']);
		expect(scopes.map((scope) => scope.count)).toEqual([9, 3, 1, 4]);
	});

	// A scope announcing "0" before the read lands is a claim about a population
	// nobody has counted yet.
	test('omits the count until the totals are known', () => {
		const scopes = trayScopes(null);
		expect(scopes).toHaveLength(4);
		for (const scope of scopes) expect(scope.count).toBeUndefined();
	});

	test('the label vocabulary is the one the rest of the surface quotes', () => {
		expect(trayLabels['set-aside']).toBe('Set aside');
	});
});

describe('decision states', () => {
	// One word and one keyed state per outcome; tone and glyph come from
	// `badgeFor(key)` at the render site, so two surfaces cannot disagree.
	test('every state carries a word and a shared status key', () => {
		expect(decisionStatus.undecided).toEqual({ key: 'notStarted', label: 'No decision' });
		expect(decisionStatus.accepted).toEqual({ key: 'accepted', label: 'Accepted' });
		expect(decisionStatus.waitlisted).toEqual({ key: 'waitlisted', label: 'Waitlisted' });
		expect(decisionStatus.declined).toEqual({ key: 'declined', label: 'Declined' });
		expect(decisionStatus.withdrawn).toEqual({ key: 'withdrawn', label: 'Withdrawn' });
	});

	test('actionable custody names the organizer action without inventing one elsewhere', () => {
		expect(decisionStatusFor({ decision: 'undecided', tray: 'inbox' }).label).toBe('Decision needed');
		expect(decisionStatusFor({ decision: 'undecided', tray: 'late' }).label).toBe('Decision needed');
		expect(decisionStatusFor({ decision: 'undecided', tray: 'set-aside' }).label).toBe('No decision');
		expect(decisionStatusFor({ decision: 'undecided', tray: 'spam' }).label).toBe('No decision');
	});

	test('a result owed to speakers has one compact state label', () => {
		expect(noticeStatus).toEqual({ key: 'unnotified', label: 'Result not sent' });
	});

	test('the map carries no tone and no emphasis of its own', () => {
		for (const status of Object.values(decisionStatus)) {
			expect(Object.keys(status).sort()).toEqual(['key', 'label']);
		}
	});

	// Withdrawal is the submitter's own act, so nothing is owed back to them.
	test('only an organizer decision can be waiting on its notice', () => {
		expect(awaitsNotice({ decision: 'accepted', notified: false })).toBe(true);
		expect(awaitsNotice({ decision: 'accepted', notified: true })).toBe(false);
		expect(awaitsNotice({ decision: 'undecided', notified: false })).toBe(false);
		expect(awaitsNotice({ decision: 'withdrawn', notified: false })).toBe(false);
	});
});

describe('the review standing in words', () => {
	test('states the average and the population behind it', () => {
		expect(reviewSummary({ reviewAverage: 4.75, reviewCount: 3 })).toBe(
			'4.8 average of 3 reviews'
		);
		expect(reviewSummary({ reviewAverage: 4, reviewCount: 1 })).toBe('4.0 average of 1 review');
	});

	test('separates never-reviewed from reviewed-without-an-average', () => {
		expect(reviewSummary({ reviewCount: 0 })).toBe('No reviews yet');
		expect(reviewSummary({ reviewCount: 2 })).toBe('2 reviews, no average yet');
	});
});


describe('the notice clock', () => {
	const decided = '2026-08-13T11:00:00.000Z';

	test('an unsent notice runs on the decision clock', () => {
		expect(noticeAge({ decision: 'accepted', decidedAt: decided, notified: false })).toBe(decided);
	});

	test('sent, withdrawn, or undecided rows owe nothing and run no clock', () => {
		expect(noticeAge({ decision: 'accepted', decidedAt: decided, notified: true })).toBeNull();
		expect(noticeAge({ decision: 'withdrawn', decidedAt: decided, notified: false })).toBeNull();
		expect(noticeAge({ decision: 'undecided', notified: false })).toBeNull();
	});

	test('a decided row with no recorded moment claims no age it cannot back', () => {
		expect(noticeAge({ decision: 'declined', notified: false })).toBeNull();
	});
});

describe('the decision cell against its group band', () => {
	test('inside the undecided groups the band carries the badge and the row keeps a quiet note', () => {
		const undecided = row();
		const quiet = { notice: false, absent: 'No decision yet' };
		expect(decisionCellFor(undecided, 'review')).toEqual(quiet);
		expect(decisionCellFor(undecided, 'deciding')).toEqual(quiet);
	});

	test('inside Results not sent only the verdict varies, so only the verdict renders', () => {
		const accepted = row({ decision: 'accepted', notified: false });
		expect(decisionCellFor(accepted, 'notice')).toEqual({
			status: { key: 'accepted', label: 'Accepted' },
			notice: false
		});
	});

	test('Done rows keep their verdict', () => {
		const done = row({ decision: 'declined', notified: true });
		expect(decisionCellFor(done, 'done')).toEqual({
			status: { key: 'declined', label: 'Declined' },
			notice: false
		});
	});

	test('a flat tray has no band to lean on, so rows keep the full projection', () => {
		const parked = row({ tray: 'set-aside' });
		expect(decisionCellFor(parked, 'all')).toEqual({
			status: { key: 'notStarted', label: 'No decision' },
			notice: false
		});
		const spam = row({ tray: 'spam', decision: 'accepted', notified: false });
		expect(decisionCellFor(spam, 'all')).toEqual({
			status: { key: 'accepted', label: 'Accepted' },
			notice: true
		});
	});
});

describe('the journey', () => {
	const states = (steps: ReturnType<typeof journeyOf>) => steps.map((step) => step.state);
	const notes = (steps: ReturnType<typeof journeyOf>) =>
		Object.fromEntries(steps.map((step) => [step.key, step.note]));

	test('an untouched arrival is at its first open step', () => {
		const steps = journeyOf(row(), {
			round: { open: true, reviewsPerSubmission: 3 },
			arrival: '2 h ago'
		});
		expect(states(steps)).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
		expect(notes(steps).submitted).toBe('2 h ago');
		expect(notes(steps).reviewed).toBe('0 of 3 reviews in');
	});

	test('reviews done, decision open: the ring moves to Decided', () => {
		const steps = journeyOf(row({ reviewCount: 3 }), {
			round: { open: true, reviewsPerSubmission: 3 }
		});
		expect(states(steps)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
		expect(notes(steps).decided).toBe('Waiting on a decision');
	});

	test('the tail steps state their own truth independently', () => {
		// Accepted, placed, but the result was never sent: Scheduled is done
		// while Result sent is the one current step.
		const steps = journeyOf(
			row({ decision: 'accepted', notified: false, reviewCount: 3 }),
			{ round: null, origin: { sessionId: 'ses-1', title: 'The Session', kind: 'spawn' } }
		);
		expect(states(steps)).toEqual(['done', 'done', 'done', 'current', 'done']);
		expect(notes(steps).scheduled).toBe('Became “The Session”');
	});

	test('a declined line ends at its sent result', () => {
		const steps = journeyOf(row({ decision: 'declined', notified: true, reviewCount: 2 }), {
			round: null
		});
		expect(states(steps)).toEqual(['done', 'done', 'done', 'done', 'skipped']);
		expect(notes(steps).scheduled).toBe('Not scheduled');
	});

	test('withdrawal owes nothing further', () => {
		const steps = journeyOf(row({ decision: 'withdrawn', reviewCount: 1 }), { round: null });
		expect(states(steps)).toEqual(['done', 'done', 'done', 'skipped', 'skipped']);
		expect(notes(steps).sent).toBe('Nothing owed — withdrawn by the submitter');
	});

	test('a parked row is not being decided, and the line says so', () => {
		const steps = journeyOf(row({ tray: 'spam' }), { round: null });
		expect(states(steps)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped']);
		expect(notes(steps).decided).toBe('Marked as spam — not being decided');
	});

	test('an accepted row not yet placed keeps Scheduled open, known or not', () => {
		const unknown = journeyOf(row({ decision: 'accepted', notified: true, reviewCount: 3 }), {
			round: null
		});
		const answeredNone = journeyOf(
			row({ decision: 'accepted', notified: true, reviewCount: 3 }),
			{ round: null, origin: null }
		);
		for (const steps of [unknown, answeredNone]) {
			expect(states(steps)).toEqual(['done', 'done', 'done', 'done', 'current']);
			expect(notes(steps).scheduled).toBe('Not placed yet');
		}
	});
});
