/**
 * Reviewer scope and coverage: the matching predicate, the load sums, and the
 * coverage projection. One module owns them so the roster, the coverage rows,
 * and the removal guard behind a vocabulary entry count the same way.
 */

import type {
	CoverageRow,
	Reviewer,
	ReviewPlan,
	ScopeRef,
	ScopeRefKind,
	SessionItem,
	VocabStatus
} from './types';

/** A reviewer with no scope rows is a generalist: they review everything. */
export function isGeneralist(reviewer: { scope: readonly ScopeRef[] }): boolean {
	return reviewer.scope.length === 0;
}

/**
 * Whether a submission falls inside a scope. A scope set is a union — the
 * submission is in scope when *any* ref matches — and the empty set is the
 * generalist default that matches everything.
 *
 * A session ref names the submissions whose effective target is that session.
 * The seam carries no submission→target link yet, so a session ref matches no
 * submission here; the shape is the contract, and the join arrives with the
 * real transport.
 */
export function scopeMatches(
	scope: readonly ScopeRef[],
	submission: { trackId: string; formatId: string }
): boolean {
	if (scope.length === 0) return true;
	return scope.some((ref) => {
		if (ref.kind === 'track') return submission.trackId === ref.id;
		if (ref.kind === 'format') return submission.formatId === ref.id;
		// Session target link: seam gap, see the doc comment above.
		return false;
	});
}

/**
 * Whether a scope covers one session: true when the scope holds the session
 * ref itself, a track ref matching the session's track, or a format ref
 * matching the session's format.
 *
 * The stored scope stays minimal truth — selecting a track never mints
 * per-session refs, which would go stale when the track ref is removed.
 * Implied coverage is derived here instead, so a session's reviewer count is
 * honest about track- and format-scoped reviewers while the stored set keeps
 * saying only what the organizer chose. A ref to a retired entry still covers:
 * retirement stops new offering, never existing filtering.
 */
export function sessionCoveredBy(
	scope: readonly ScopeRef[],
	session: { id: string; trackId: string; formatId: string }
): boolean {
	return scope.some(
		(ref) =>
			(ref.kind === 'session' && ref.id === session.id) ||
			(ref.kind === 'track' && ref.id === session.trackId) ||
			(ref.kind === 'format' && ref.id === session.formatId)
	);
}

/**
 * How many reviewers hold this ref in scope, any status: a reference exists
 * whether or not its holder has arrived yet, and the removal guard answers to
 * references, not to coverage.
 */
export function scopeRefCount(
	kind: ScopeRefKind,
	id: string,
	reviewers: readonly { scope: readonly ScopeRef[] }[]
): number {
	return reviewers.filter((reviewer) =>
		reviewer.scope.some((ref) => ref.kind === kind && ref.id === id)
	).length;
}

/**
 * One reviewer's load, summed across every plan whose roster names them —
 * the roster's numbers are these sums, never authored a second time. An
 * uncovered review stays inside `assigned`, so denominators do not move when
 * someone steps back.
 */
export function planLoad(
	reviewerId: string,
	plans: readonly ReviewPlan[]
): Pick<Reviewer, 'assigned' | 'done' | 'steppedBack' | 'awaitingReassignment'> {
	const load = { assigned: 0, done: 0, steppedBack: 0, awaitingReassignment: 0 };
	for (const plan of plans) {
		for (const row of plan.reviewers) {
			if (row.id !== reviewerId) continue;
			load.assigned += row.assigned;
			load.done += row.done;
			load.steppedBack += row.steppedBack;
			load.awaitingReassignment += row.awaitingReassignment;
		}
	}
	return load;
}

/** The records a coverage projection is computed from. */
export interface CoverageSource {
	tracks: readonly { id: string; name: string; status?: VocabStatus }[];
	formats: readonly { id: string; name: string; status?: VocabStatus }[];
	sessions: readonly SessionItem[];
	submissions: readonly { trackId: string; formatId: string }[];
	reviewers: readonly Pick<Reviewer, 'status' | 'scope'>[];
}

/**
 * The coverage projection: one row per active track and format, plus every
 * collecting session, plus any retired track or format still named in a
 * scope (kept rendering, flagged for re-scoping). A retired entry nobody is
 * scoped to gets no row — it is not offered, and nothing points at it.
 *
 * `reviewers` counts active reviewers covering the target — an invited
 * reviewer is on the roster but not covering anything yet — and generalists
 * are not folded in, so a zero stays answerable by the roster's generalist
 * count. Track and format rows count the reviewers holding the ref itself;
 * session rows count via `sessionCoveredBy`, so a track- or format-scoped
 * reviewer shows up on the sessions carrying that track or format. The stored
 * scope stays minimal — implied coverage is what makes these counts honest.
 * Session rows count 0 submissions until the submission→target link exists
 * (the seam gap `scopeMatches` documents).
 */
export function coverageRows(source: CoverageSource): CoverageRow[] {
	const active = source.reviewers.filter((reviewer) => reviewer.status === 'active');
	const rows: CoverageRow[] = [];
	const push = (ref: ScopeRef, label: string, retired: boolean, submissions: number) => {
		rows.push({
			ref,
			label,
			...(retired ? { retired: true } : {}),
			reviewers: active.filter((reviewer) =>
				reviewer.scope.some((entry) => entry.kind === ref.kind && entry.id === ref.id)
			).length,
			submissions
		});
	};
	for (const track of source.tracks) {
		const retired = (track.status ?? 'active') === 'retired';
		if (retired && scopeRefCount('track', track.id, source.reviewers) === 0) continue;
		push(
			{ kind: 'track', id: track.id },
			track.name,
			retired,
			source.submissions.filter((submission) => submission.trackId === track.id).length
		);
	}
	for (const format of source.formats) {
		const retired = (format.status ?? 'active') === 'retired';
		if (retired && scopeRefCount('format', format.id, source.reviewers) === 0) continue;
		push(
			{ kind: 'format', id: format.id },
			format.name,
			retired,
			source.submissions.filter((submission) => submission.formatId === format.id).length
		);
	}
	for (const session of source.sessions) {
		if (session.state !== 'collecting') continue;
		rows.push({
			ref: { kind: 'session', id: session.id },
			label: session.title,
			reviewers: active.filter((reviewer) => sessionCoveredBy(reviewer.scope, session)).length,
			submissions: 0
		});
	}
	return rows;
}

/**
 * Why an already-committed review cannot be stepped back from. Composed here
 * so the sentence a card carries before the press and the one the operation
 * refuses with are the same sentence.
 */
export function composeStepBackRefusal(title: string): string {
	return `You have already committed your review of “${title}”.`;
}
