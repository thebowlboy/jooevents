import { workspaceTeamCanonicalEmailSchema, type StructuredOutcome } from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import { mapLiveReviewPlans } from './review-page-port.live';
import type { ReviewerRosterCorePort } from './reviewer-roster-core-port';
import { coverageRows, isGeneralist, planLoad } from './reviewers';
import type { ReviewersPagePort } from './reviewers-page-port';
import type {
	WorkspaceTeamSettingsMutationResult,
	WorkspaceTeamSettingsPort
} from './workspace-team-settings-adapter';
import type {
	Format,
	MutationOutcome,
	Reviewer,
	ReviewerCoverage,
	ReviewerInviteLine,
	ScheduleState,
	ScopeRef,
	Track
} from './types';
import type { ProgramFormatView, ProgramTrackView } from './view-models/program-vocabulary';
import type { ReviewerRosterMemberView } from './view-models/reviewer-roster';
import type { WorkspaceTeamMemberView } from './view-models/workspace-team';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined.
 */
export type ReviewersPageLiveUnmountedCapability =
	| 'reviewer_scope_targets'
	| 'reviewer_coverage'
	| 'reviewer_reminders';

type AdapterFailure = Readonly<{ code: string; reason: string; retryable?: boolean }>;

/**
 * Safe, reviewed-copy failure at the tuned Reviewers boundary.
 *
 * `retryable` is declared, not inferred. A surface reads it to decide whether to
 * offer a retry, and an unmounted capability must answer `false`: retrying a
 * capability this composition does not implement can never succeed, and a
 * "Try again" beside it would state the absence as a transient wait. Anything
 * that does not declare itself stays retryable, so an unclassified defect never
 * freezes a surface behind a terminal claim nobody made.
 */
export class ReviewersPageLiveError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'ReviewersPageLiveError';
		this.code = failure.code;
		this.retryable = failure.retryable !== false;
	}
}

const UNMOUNTED_COPY: Readonly<Record<ReviewersPageLiveUnmountedCapability, string>> =
	Object.freeze({
		reviewer_scope_targets:
			'Session scope targets are not available in this live workspace yet.',
		reviewer_coverage:
			'Review coverage is not available in this live workspace yet.',
		reviewer_reminders:
			'Reviewer reminders are not available in this live workspace yet.'
	});

/**
 * A load-count refusal, not an unmounted capability: the Review snapshot read
 * is mounted and succeeded, but the server states it served a single
 * reviewer's projection, so whole-roster sums cannot be derived from it.
 */
const LOAD_POPULATION_PARTIAL: AdapterFailure = Object.freeze({
	code: 'review_load_population_partial',
	reason:
		'Reviewer load counts are not available in this live workspace: '
		+ 'the review snapshot was served for a single reviewer, not the whole roster.'
});

function unmounted(capability: ReviewersPageLiveUnmountedCapability): ReviewersPageLiveError {
	// Permanent for this composition: there is nothing to retry into.
	return new ReviewersPageLiveError({
		code: capability,
		reason: UNMOUNTED_COPY[capability],
		retryable: false
	});
}

function refusal(capability: ReviewersPageLiveUnmountedCapability): MutationOutcome {
	return { ok: false, reason: UNMOUNTED_COPY[capability] };
}

function outcomeCopy(outcome: StructuredOutcome, subject: string): string {
	if (outcome.class === 'access_denied') {
		return `You no longer have permission to read the ${subject}.`;
	}
	if (outcome.class === 'stale_revision' || outcome.class === 'conflict') {
		return `The ${subject} changed while you were working. Reload and try again.`;
	}
	return `This ${subject} request could not be completed.`;
}

type ReadFailure =
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

function readFailure(result: ReadFailure, subject: string): AdapterFailure {
	if (result.kind === 'unavailable') {
		// Not bound in this composition: retrying reaches the same absence.
		return {
			code: result.reason,
			reason: `The ${subject} is not available in this live workspace.`,
			retryable: false
		};
	}
	if (result.kind === 'transport_error') {
		// The transport already classified itself; carry that verdict rather
		// than re-deciding it here.
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`,
			retryable: result.error.retryable
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject) };
}

function changeFailure(
	result: Exclude<Awaited<ReturnType<ReviewerRosterCorePort['change']>>, { readonly kind: 'success' }>,
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: `The ${subject} is not available in this live workspace.`, retryable: false };
	}
	if (result.kind === 'transport_error') {
		return { code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} change could not reach JooEvents. Try again.`
				: `This ${subject} change is not valid.`,
			retryable: result.error.retryable };
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject) };
}

function liveTrack(track: ProgramTrackView): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

function liveFormat(format: ProgramFormatView): Format {
	return {
		id: format.id,
		name: format.name,
		status: format.status,
		usage: { ...format.usage }
	};
}

function teamSubjectKey(member: WorkspaceTeamMemberView): string {
	return member.subject.kind === 'member'
		? `workspace_membership:${member.subject.membershipId}`
		: `access_reservation:${member.subject.reservationId}`;
}

function rosterSubjectKey(member: ReviewerRosterMemberView): string | undefined {
	const subject = member.authority.currentSubject;
	return subject ? `${subject.kind}:${subject.id}` : undefined;
}

function present(value: string | null | undefined): string | undefined {
	return value && value.trim().length > 0 ? value : undefined;
}

function normalizeEmail(email: string): string | null {
	const normalized = email.trim().normalize('NFKC').toLocaleLowerCase('en-US');
	return workspaceTeamCanonicalEmailSchema.safeParse(normalized).success ? normalized : null;
}

function teamInviteFailure(result: Exclude<
	WorkspaceTeamSettingsMutationResult,
	{ readonly kind: 'success' }
>): string {
	if (result.kind === 'refused') return result.reason;
	if (result.kind === 'prepare_read_failed') {
		return readFailure(result.result, 'workspace team').reason;
	}
	if (result.kind === 'committed_refresh_failed') {
		return 'Workspace access was reserved, but reviewer registration is waiting for a team refresh. Reload and try again.';
	}
	if (result.kind === 'committed_projection_mismatch') {
		return 'Workspace access was reserved, but the reviewer reservation could not be verified. Reload and try again.';
	}
	return readFailure(result, 'workspace invitation').reason;
}

function rosterAccessSubjectKey(member: ReviewerRosterMemberView): string {
	return `${member.accessSubject.kind}:${member.accessSubject.id}`;
}

function teamRosterSubject(member: WorkspaceTeamMemberView) {
	return member.subject.kind === 'member'
		? { kind: 'workspace_membership' as const, id: member.subject.membershipId, version: member.subject.version }
		: { kind: 'access_reservation' as const, id: member.subject.reservationId, version: member.subject.version };
}

/**
 * Live tuned Reviewers page port over the deliberately partial canonical
 * mount: the access-subject-keyed Reviewer Roster snapshot, the
 * organizer-served Review snapshot's whole-population per-plan loads, and the
 * live Program Vocabulary. Everything else surfaces the port's typed refusal
 * or its typed absence — never fabricated zeros, never silent no-ops.
 *
 * `review` is required because the tuned rows print load numbers (assigned,
 * done, stepped back, awaiting reassignment) as positive counted facts, and
 * the roster snapshot deliberately carries none of them. The one recorded
 * counting module (`planLoad` in ./reviewers) sums them across every
 * non-discarded plan the Review snapshot serves, and that sum is a
 * whole-population fact only when the server states the organizer projection
 * (`viewer.kind === 'organizer'`): a reviewer-served snapshot filters each
 * hidden-identity round's rows down to the viewer's own, without disclosing
 * which rounds were filtered, so completeness cannot be re-derived here. A
 * roster member named in no served plan therefore carries true zeros only
 * under the organizer view, and both an unavailable Review read and a
 * reviewer-scoped one are a failed roster load, never a zeroed one.
 *
 * The canonical roster keys people by access subject and discloses no email
 * address. The organizer-authorized Workspace Team projection owns that
 * contact data, so this adapter joins the two projections by the roster's
 * current membership/reservation subject — never by email. A missing join
 * keeps email absent rather than inventing an empty-string value. Identity is
 * load-bearing: a row with neither a Team name nor a roster-disclosed name is
 * refused instead of gaining an invented label. Revoked members are the tuned
 * roster's removed records ("removal takes the record off the roster") and
 * are omitted.
 *
 * The `coverage` projection is served only as its provably empty population:
 * the frozen contract reads `coverage: []` as the positive claim that no
 * active track, format, or collecting-session target exists — the tuned
 * panel renders that claim as prose — so an empty list may not stand in for
 * "not composed". When the live vocabulary, the roster's scopes, or the
 * composed schedule prove any target exists, the read refuses instead: a
 * CoverageRow cannot exist without its required `submissions` count, the
 * submission → scope-target join has no live owner, and emitting rows with
 * `submissions: 0` would be exactly the fabricated zero this boundary
 * forbids. Rows return when the canonical join owner lands.
 */
export function createLiveReviewersPagePort(input: {
	readonly roster: ReviewerRosterCorePort;
	readonly review: ReviewCorePort;
	readonly team: Pick<WorkspaceTeamSettingsPort, 'source' | 'members' | 'invite'>;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'>;
	/**
	 * The one schedule read the tuned page performs, delegated to the live
	 * Schedule page port when its owners are composed, and the coverage
	 * emptiness proof's session population. This port never rebuilds a
	 * ScheduleState of its own — a zeroed state would claim no sessions
	 * exist — so with no delegate the read refuses and coverage cannot be
	 * proven empty either.
	 */
	readonly schedule?: { state(): Promise<ScheduleState> };
	readonly now?: () => number;
	readonly newAttemptKey?: () => string;
	readonly newReviewerId?: () => string;
}): ReviewersPagePort {
	if (
		input.roster.source.kind !== 'live'
		|| input.review.source.kind !== 'live'
		|| input.team.source.kind !== 'live'
		|| input.vocabulary.source.kind !== 'live'
	) {
		throw new TypeError('live_reviewer_roster_source_required');
	}
	const now = input.now ?? Date.now;
	const newAttemptKey = input.newAttemptKey ?? (() => crypto.randomUUID());
	const newReviewerId = input.newReviewerId ?? (() => crypto.randomUUID());

	async function currentRoster() {
		const result = await input.roster.readSnapshot();
		if (result.kind !== 'success') throw new ReviewersPageLiveError(readFailure(result, 'reviewer roster'));
		return result.data;
	}

	async function changeReviewer(
		action: 'set_scope' | 'revoke' | 'restore',
		reviewerId: string,
		reviews?: ScopeRef[]
	): Promise<void> {
		const roster = await currentRoster();
		const reviewer = roster.reviewers.find((candidate) => candidate.reviewerId === reviewerId);
		if (!reviewer) throw new ReviewersPageLiveError({ code: 'reviewer_missing',
			reason: 'This reviewer is not on the current roster.' });
		if (action === 'restore' && reviewer.status !== 'revoked') {
			throw new ReviewersPageLiveError({ code: 'reviewer_not_revoked',
				reason: 'Only a revoked reviewer can be restored.' });
		}
		if (action !== 'restore' && reviewer.status === 'revoked') {
			throw new ReviewersPageLiveError({ code: 'reviewer_revoked',
				reason: 'Restore this reviewer before changing the active roster.' });
		}
		const guard = { reviewerId, expectedReviewerVersion: reviewer.recordVersion,
			expectedRosterVersion: roster.rosterVersion,
			expectedRosterDigestSha256: roster.rosterDigestSha256 };
		const result = action === 'set_scope'
			? await input.roster.change({ action, ...guard, reviews: reviews ?? [] }, newAttemptKey())
			: action === 'revoke'
				? await input.roster.change({ action, ...guard }, newAttemptKey())
				: await input.roster.change({ action, ...guard }, newAttemptKey());
		if (result.kind !== 'success') throw new ReviewersPageLiveError(changeFailure(result, 'reviewer roster'));
		if (result.data.action !== action || result.data.reviewer.reviewerId !== reviewerId) {
			throw new ReviewersPageLiveError({ code: 'invalid_contract',
				reason: 'This reviewer roster request could not be completed.' });
		}
	}

	/**
	 * `coverage: []` only as a proven claim. The proof reuses the one recorded
	 * coverage projection (`coverageRows` in ./reviewers) over the live
	 * vocabulary, the tuned roster rows, and the composed schedule's sessions,
	 * so target existence — active entries, retired entries still named in a
	 * kept scope, collecting sessions — is counted exactly the way the real
	 * panel would count it. The probe's placeholder submissions list only
	 * fills per-row counts, never row existence, and the probe rows are
	 * discarded, so no fabricated per-target zero can escape it. Any populated
	 * target set declines (its rows' required `submissions` count has no live
	 * owner), and with no schedule delegate the collecting-session population
	 * is unknowable, so the empty claim is unprovable and the projection
	 * declines the same way. A composed delegate's own read failure propagates
	 * as itself: its typed error names the failing owner more precisely than a
	 * re-wrap.
	 *
	 * A decline is a returned `unavailable` rather than a throw. Coverage is one
	 * panel; the roster is the surface. Throwing here failed `list()` outright,
	 * so an unprovable coverage claim left the whole Reviewers page rendering
	 * skeleton rows forever — the page waiting on an answer the port had already
	 * decided it would never give.
	 */
	async function provenEmptyCoverage(reviewers: readonly Reviewer[]): Promise<ReviewerCoverage> {
		if (!input.schedule) return { kind: 'unavailable', reason: UNMOUNTED_COPY.reviewer_coverage };
		const [tracks, formats, scheduleState] = await Promise.all([
			input.vocabulary.tracks(),
			input.vocabulary.formats(),
			input.schedule.state()
		]);
		const probe = coverageRows({
			tracks: tracks.map(liveTrack),
			formats: formats.map(liveFormat),
			sessions: scheduleState.sessions,
			submissions: [],
			reviewers
		});
		if (probe.length > 0) return { kind: 'unavailable', reason: UNMOUNTED_COPY.reviewer_coverage };
		return { kind: 'served', rows: [] };
	}

	async function inviteReviewer(
		entry: { readonly email: string; readonly name?: string },
		reviews: ScopeRef[]
	): Promise<ReviewerInviteLine> {
		const normalized = normalizeEmail(entry.email);
		if (normalized === null) {
			return { email: entry.email, ok: false, reason: 'Enter a valid email address.' };
		}
		const teamResult = await input.team.members();
		if (teamResult.kind !== 'success') {
			return {
				email: entry.email,
				ok: false,
				reason: readFailure(teamResult, 'workspace team').reason
			};
		}
		let member = teamResult.data.members.find((candidate) =>
			normalizeEmail(candidate.email) === normalized
		);
		let reservedNow = false;
		if (!member) {
			const invitation = await input.team.invite(normalized, 'Speaker Reviewer', {
				idempotencyKey: newAttemptKey()
			});
			if (invitation.kind !== 'success') {
				return { email: entry.email, ok: false, reason: teamInviteFailure(invitation) };
			}
			member = invitation.data.effect.action === 'invite'
				? invitation.data.effect.currentInvitation ?? undefined
				: undefined;
			reservedNow = true;
			if (!member) {
				return {
					email: entry.email,
					ok: false,
					reason: 'Workspace access was reserved, but the reviewer reservation could not be verified. Reload and try again.'
				};
			}
		}
		if (member.role.key !== 'speaker_reviewer') {
			return {
				email: entry.email,
				ok: false,
				reason: `${member.email} already has the ${member.role.name} workspace role. Change their role in Settings before adding them as a reviewer.`
			};
		}
		const accessSubject = teamRosterSubject(member);
		const roster = await currentRoster();
		const subjectKey = `${accessSubject.kind}:${accessSubject.id}`;
		if (roster.reviewers.some((candidate) => rosterAccessSubjectKey(candidate) === subjectKey)) {
			return { email: entry.email, ok: false, reason: 'Already on the reviewer roster.' };
		}
		const reviewerId = newReviewerId();
		const changed = await input.roster.change({
			action: 'register',
			reviewerId,
			accessSubject,
			reviews,
			expectedRosterVersion: roster.rosterVersion,
			expectedRosterDigestSha256: roster.rosterDigestSha256
		}, newAttemptKey());
		if (changed.kind !== 'success') {
			const reason = changeFailure(changed, 'reviewer roster').reason;
			return {
				email: entry.email,
				ok: false,
				reason: reservedNow ? `Workspace access was reserved, but ${reason}` : reason
			};
		}
		if (changed.data.action !== 'register'
			|| changed.data.reviewer.reviewerId !== reviewerId) {
			return {
				email: entry.email,
				ok: false,
				reason: 'Workspace access was reserved, but the reviewer registration response was not valid. Reload and try again.'
			};
		}
		return {
			email: entry.email,
			ok: true,
			reviewer: {
				id: reviewerId,
				name: present(member.name) ?? present(entry.name) ?? normalized,
				email: normalized,
				status: member.kind === 'invitation' ? 'invited' : 'active',
				scope: reviews.map((review) => ({ ...review })),
				assigned: 0,
				done: 0,
				steppedBack: 0,
				awaitingReassignment: 0
			}
		};
	}

	return Object.freeze({
		reviewers: Object.freeze({
			async list() {
				const [rosterResult, reviewResult, teamResult] = await Promise.all([
					input.roster.readSnapshot(),
					input.review.readSnapshot(),
					input.team.members()
				]);
				if (rosterResult.kind !== 'success') {
					throw new ReviewersPageLiveError(readFailure(rosterResult, 'reviewer roster'));
				}
				if (reviewResult.kind !== 'success') {
					throw new ReviewersPageLiveError(readFailure(reviewResult, 'review load counts'));
				}
				if (teamResult.kind !== 'success') {
					throw new ReviewersPageLiveError(readFailure(teamResult, 'workspace team'));
				}
				// Whole-roster sums ride the served discriminator, not row shape: a
				// reviewer-served snapshot filters each hidden-identity round's rows
				// to the viewer's own row and does not disclose which rounds were
				// filtered, so summing it would print fabricated zeros for every
				// other member. A viewer-scoped population is a failed roster load.
				if (reviewResult.data.viewer.kind !== 'organizer') {
					throw new ReviewersPageLiveError(LOAD_POPULATION_PARTIAL);
				}
				const plans = mapLiveReviewPlans(reviewResult.data.plans, now());
				const teamBySubject = new Map(
					teamResult.data.members.map((member) => [teamSubjectKey(member), member] as const)
				);
				const reviewers: Reviewer[] = [];
				for (const member of rosterResult.data.reviewers) {
					if (member.status === 'revoked') continue;
					const subjectKey = rosterSubjectKey(member);
					const teamMember = subjectKey ? teamBySubject.get(subjectKey) : undefined;
					const name = present(teamMember?.name) ?? present(member.displayName);
					if (!name) {
						throw new ReviewersPageLiveError({
							code: 'reviewer_identity_missing',
							reason: 'A reviewer identity could not be resolved from the workspace team.'
						});
					}
					const email = present(teamMember?.email);
					reviewers.push({
						id: member.reviewerId,
						name,
						...(email ? { email } : {}),
						status: member.status,
						scope: member.reviews.map((ref) => ({ kind: ref.kind, id: ref.id })),
						...planLoad(member.reviewerId, plans)
					});
				}
				return {
					reviewers,
					generalists: reviewers.filter(
						(reviewer) => reviewer.status === 'active' && isGeneralist(reviewer)
					).length,
					coverage: await provenEmptyCoverage(reviewers)
				};
			},
			async invite(
				entries: { readonly email: string; readonly name?: string }[],
				scope: ScopeRef[] = []
			): Promise<ReviewerInviteLine[]> {
				// Sequential by design: each reservation and roster registration
				// advances an optimistic aggregate guard. Every line still reports
				// independently, and no email string is ever used as roster authority.
				const lines: ReviewerInviteLine[] = [];
				for (const entry of entries) lines.push(await inviteReviewer(entry, scope));
				return lines;
			},
			async setScope(id: string, scope: ScopeRef[]): Promise<MutationOutcome> {
				try {
					await changeReviewer('set_scope', id, scope);
					return { ok: true };
				} catch (error) {
					if (error instanceof ReviewersPageLiveError) return { ok: false, reason: error.message };
					throw error;
				}
			},
			async remove(id: string): Promise<MutationOutcome> {
				try {
					await changeReviewer('revoke', id);
					return { ok: true };
				} catch (error) {
					if (error instanceof ReviewersPageLiveError) return { ok: false, reason: error.message };
					throw error;
				}
			},
			async restore(id: string): Promise<void> {
				await changeReviewer('restore', id);
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack),
			formats: async () => (await input.vocabulary.formats()).map(liveFormat)
		}),
		schedule: Object.freeze({
			async state(): Promise<ScheduleState> {
				if (input.schedule) return input.schedule.state();
				throw unmounted('reviewer_scope_targets');
			}
		}),
		tasks: Object.freeze({
			async remind(): Promise<never> {
				throw unmounted('reviewer_reminders');
			}
		})
	} satisfies ReviewersPagePort);
}
