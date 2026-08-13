import { describe, expect, test } from 'bun:test';
import {
	reviewChangeDraftDataSchema,
	reviewDraftSaveResultSchema,
	reviewRoundSetupProjectionSchema,
	reviewSnapshotSchema,
	type ReviewSnapshot
} from '@jooevents/contracts/reviews';
import type {
	ChangesetDiffView,
	ChangesetReviewEffectInput,
	ChangesetReviewPort,
	ChangesetSafeDiff
} from './changesets';
import {
	mapReviewChangeDraft,
	mapReviewDraftSave,
	mapReviewRoundSetup,
	mapReviewSnapshot
} from './mappers/review';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import { createLiveReviewPagePort, ReviewPageLiveError } from './review-page-port.live';
import type { ReviewChangeDraftView } from './view-models/review';
import type { ProgramFormatView, ProgramTrackView } from './view-models/program-vocabulary';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const correlationId = id(900);
const reviewerId = id(3);
const scoredSubmissionId = id(5);
const committedSubmissionId = id(6);
const openRoundId = id(4);
const openCriterionId = id(70);

/** 2026-08-13T12:00:00.000Z, so the open round on Sep 1 is due in 19 days. */
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

type FixtureViewer = { kind: 'organizer' } | { kind: 'reviewer'; reviewerId: string };

/** Unparsed criterion input; the snapshot parse brands and validates it. */
type CriterionInput = {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly position: number;
	readonly weightBps: number;
	readonly scaleMin: number;
	readonly scaleMax: number;
};

function singleCriterion(criterionId: string): CriterionInput[] {
	return [{
		id: criterionId, key: 'overall', label: 'Overall', position: 0,
		weightBps: 10_000, scaleMin: 1, scaleMax: 5
	}];
}

type SnapshotOptions = {
	readonly openRoundCriteria?: CriterionInput[];
	/** The scored item re-served as a committed review (post-commit truth). */
	readonly scoredCommitted?: boolean;
	/** The scored item served without any saved draft. */
	readonly scoredDraftAbsent?: boolean;
	/** One additional open round appended to the served plans. */
	readonly extraOpenRound?: {
		readonly id: string;
		readonly name: string;
		readonly deadlineEffectiveAt: string;
		readonly criterionId: string;
		readonly total: number;
	};
};

function canonicalSnapshot(
	viewer: FixtureViewer,
	options: SnapshotOptions = {}
): ReviewSnapshot {
	const openRoundCriteria = options.openRoundCriteria ?? singleCriterion(openCriterionId);
	const committedRevision = {
		revisionId: id(95),
		score: 4,
		comment: 'Working notes.',
		at: '2026-08-13T12:30:00.000Z',
		postUnlock: false
	};
	const scoredEntry = {
		assignmentId: id(7),
		roundId: openRoundId,
		submissionId: scoredSubmissionId,
		assignmentVersion: 1,
		candidate: {
			submissionId: scoredSubmissionId,
			version: 2,
			title: 'Blind candidate',
			abstract: 'The canonical candidate body.',
			submittedAt: '2026-08-01T10:00:00.000Z',
			trackId: id(11),
			resources: []
		},
		...(options.scoredCommitted
			? { committed: true, current: committedRevision, revisions: [committedRevision] }
			: {
					...(options.scoredDraftAbsent
						? {}
						: { draft: { version: 1, score: 4, comment: 'Working notes.' } }),
					committed: false,
					revisions: []
				})
	};
	return reviewSnapshotSchema.parse({
		schemaVersion: 1,
		viewer,
		plans: [{
			id: id(40),
			ordinal: 1,
			name: 'Round 1',
			state: 'closed',
			version: 2,
			scaleMax: 5,
			criteria: singleCriterion(id(71)),
			deadlineEffectiveAt: '2026-07-28T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 4,
			total: 4,
			reviewers: [{
				reviewerId,
				displayName: 'Ada Bell',
				assigned: 4,
				done: 4,
				steppedBack: 0,
				awaitingReassignment: 0
			}]
		}, {
			id: id(41),
			ordinal: 2,
			name: 'Discarded round',
			state: 'discarded',
			version: 2,
			scaleMax: 5,
			criteria: singleCriterion(id(72)),
			deadlineEffectiveAt: '2026-08-20T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 0,
			total: 9,
			reviewers: [{
				reviewerId,
				displayName: 'Ada Bell',
				assigned: 9,
				done: 0,
				steppedBack: 0,
				awaitingReassignment: 0
			}]
		}, {
			id: openRoundId,
			ordinal: 3,
			name: 'Round 2',
			state: 'open',
			version: 1,
			scaleMax: 5,
			criteria: openRoundCriteria,
			deadlineEffectiveAt: '2026-09-01T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 1,
			total: 2,
			reviewers: [{
				reviewerId,
				// Display name deliberately undisclosed on this row.
				assigned: 2,
				done: 1,
				steppedBack: 0,
				awaitingReassignment: 0
			}]
		}, ...(options.extraOpenRound
			? [{
					id: options.extraOpenRound.id,
					ordinal: 4,
					name: options.extraOpenRound.name,
					state: 'open',
					version: 1,
					scaleMax: 5,
					criteria: singleCriterion(options.extraOpenRound.criterionId),
					deadlineEffectiveAt: options.extraOpenRound.deadlineEffectiveAt,
					anonymized: true,
					antiAnchoring: true,
					done: 0,
					total: options.extraOpenRound.total,
					reviewers: []
				}]
			: [])],
		...(viewer.kind === 'reviewer'
			? {
					reviewerScope: [{ kind: 'track', id: id(11) }],
					queue: [scoredEntry, {
						assignmentId: id(8),
						roundId: openRoundId,
						submissionId: committedSubmissionId,
						assignmentVersion: 2,
						candidate: {
							submissionId: committedSubmissionId,
							version: 1,
							title: 'Committed candidate',
							abstract: 'Another canonical body.',
							submittedAt: '2026-08-02T10:00:00.000Z',
							trackId: id(11),
							resources: []
						},
						committed: true,
						current: {
							revisionId: id(9),
							score: 5,
							comment: 'Must-have.',
							at: '2026-08-10T09:00:00.000Z',
							postUnlock: false
						},
						revisions: [{
							revisionId: id(9),
							score: 5,
							comment: 'Must-have.',
							at: '2026-08-10T09:00:00.000Z',
							postUnlock: false
						}],
						peerScores: [3, 4]
					}]
				}
			: {}),
		standings: {
			[scoredSubmissionId]: {
				submissionId: scoredSubmissionId,
				value: 4.2,
				scaleMax: 5,
				reviews: 2,
				n: 3,
				median: 3.5,
				band: 'few',
				phrase: 'Too few scored yet to rank.',
				slice: { trackId: id(11) },
				points: [3.5, 3.1]
			}
		}
	});
}

type RecordedSnapshotRequest = {
	readonly standingSubmissionIds?: readonly string[];
	readonly standingSlice?: 'track' | 'all';
};

function corePort(viewer: FixtureViewer): {
	readonly port: ReviewCorePort;
	readonly snapshotRequests: RecordedSnapshotRequest[];
} {
	const snapshotRequests: RecordedSnapshotRequest[] = [];
	const port: ReviewCorePort = {
		source: { kind: 'live' },
		async readSnapshot(request = {}) {
			snapshotRequests.push(request);
			return {
				kind: 'success',
				data: mapReviewSnapshot(canonicalSnapshot(viewer)),
				correlationId
			};
		},
		async readRoundSetup() {
			return {
				kind: 'success',
				data: mapReviewRoundSetup(reviewRoundSetupProjectionSchema.parse({
					activeReviewers: 2,
					invitedReviewers: 1,
					submissions: 6,
					expectedReviews: 12,
					perReviewer: [
						{ reviewerId, displayName: 'Ada Bell', assigned: 6 },
						{ reviewerId: id(30), assigned: 6 }
					]
				})),
				correlationId
			};
		},
		async draftRoundChange() {
			throw new Error('unused');
		},
		async draftStepBack() {
			throw new Error('unused');
		},
		async draftEvaluationChange() {
			throw new Error('unused');
		},
		async saveEvaluationDraft() {
			throw new Error('unused');
		}
	};
	return { port, snapshotRequests };
}

function vocabulary(): Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> {
	const track: ProgramTrackView = {
		kind: 'track',
		id: id(11),
		name: 'AI',
		accent: 'lavender',
		status: 'active',
		version: 1,
		usage: { currentReferences: 2, historicalPins: 0 },
		deleteAvailability: { kind: 'unavailable', currentReferences: 2, historicalPins: 0 }
	};
	const format: ProgramFormatView = {
		kind: 'format',
		id: id(12),
		name: 'Talk',
		status: 'active',
		version: 1,
		usage: { currentReferences: 0, historicalPins: 0 },
		deleteAvailability: { kind: 'available' }
	};
	return {
		source: { kind: 'live' },
		tracks: async () => [track],
		formats: async () => [format]
	};
}

function organizerPort() {
	const { port } = corePort({ kind: 'organizer' });
	return createLiveReviewPagePort({
		review: port,
		vocabulary: vocabulary(),
		viewer: { kind: 'organizer' },
		now: () => NOW
	});
}

function reviewerPort() {
	const { port, snapshotRequests } = corePort({ kind: 'reviewer', reviewerId });
	const page = createLiveReviewPagePort({
		review: port,
		vocabulary: vocabulary(),
		viewer: { kind: 'reviewer', reviewerId },
		now: () => NOW
	});
	return { page, snapshotRequests };
}

function draftView(data: unknown): ReviewChangeDraftView {
	return mapReviewChangeDraft(reviewChangeDraftDataSchema.parse(data));
}

const approvalPolicy = {
	reference: { key: 'policy.review.change.bounded', version: 1 },
	definitionDigestSha256: 'b'.repeat(64),
	requirement: 'none'
};

function riskView() {
	return { value: 'normal' as const, label: 'Normal risk' as const, tone: 'info' as const };
}

function proposedDiffView(draft: ReviewChangeDraftView): ChangesetDiffView {
	return {
		selector: {
			changesetId: draft.changesetId,
			revisionId: draft.revision.id,
			revisionDigest: draft.revision.digestSha256
		},
		headVersion: draft.headVersion + 1,
		status: { value: 'proposed', label: 'Proposed', tone: 'info' },
		revisionNumber: draft.revision.number,
		risk: riskView(),
		approval: { requirement: 'none', label: 'No separate approval required' },
		operationCount: 1,
		groups: [{
			key: 'review',
			label: 'Review',
			risk: riskView(),
			operations: [{
				key: 'operation-1',
				kind: 'review.core.mutate',
				kindLabel: 'Review change',
				version: 1,
				risk: riskView(),
				dependencyGroup: 'review',
				safeDiff: draft.safeDiff as ChangesetSafeDiff,
				safeDiffText: '',
				consequences: [],
				consequenceLabels: []
			}],
			consequences: [],
			consequenceLabels: []
		}]
	};
}

type RecordedEffectInput = {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly expectedHeadVersion: number;
};

function plainEffectInput(effectInput: ChangesetReviewEffectInput): RecordedEffectInput {
	return {
		changesetId: String(effectInput.changesetId),
		revisionId: String(effectInput.revisionId),
		revisionDigest: effectInput.revisionDigest,
		expectedHeadVersion: effectInput.expectedHeadVersion
	};
}

function fakeChangesets(draft: ReviewChangeDraftView) {
	const calls: {
		propose?: { input: RecordedEffectInput; key: string };
		commit?: { input: RecordedEffectInput; key: string };
	} = {};
	const port: ChangesetReviewPort = {
		source: { kind: 'live' },
		async readDiff() {
			throw new Error('unused');
		},
		async propose(effectInput, key) {
			calls.propose = { input: plainEffectInput(effectInput), key };
			return {
				kind: 'success',
				data: proposedDiffView(draft),
				correlationId,
				receipt: { id: id(500), operationName: 'changeset.propose', operationVersion: 1 }
			};
		},
		async commit(effectInput, key) {
			calls.commit = { input: plainEffectInput(effectInput), key };
			return {
				kind: 'success',
				data: {
					changesetId: effectInput.changesetId,
					expectedHeadVersion: effectInput.expectedHeadVersion,
					committedHeadVersion: effectInput.expectedHeadVersion + 1,
					revisionId: effectInput.revisionId,
					revisionDigest: effectInput.revisionDigest
				},
				correlationId,
				receipt: { id: id(501), operationName: 'changeset.commit', operationVersion: 1 }
			};
		}
	};
	return { port, calls };
}

async function liveErrorCode(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		if (error instanceof ReviewPageLiveError) return error.code;
		throw error;
	}
	throw new Error('Expected a ReviewPageLiveError.');
}

describe('live tuned Review page port', () => {
	test('refuses any non-live composed source', () => {
		const live = corePort({ kind: 'organizer' }).port;
		const sampleReview = {
			...live,
			source: {
				kind: 'sample',
				label: 'Sample data',
				scenario: { key: 'k', name: 'n', description: 'd' }
			}
		} as ReviewCorePort;
		expect(() => createLiveReviewPagePort({
			review: sampleReview,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' }
		})).toThrow(new TypeError('live_review_source_required'));

		expect(() => createLiveReviewPagePort({
			review: live,
			vocabulary: {
				...vocabulary(),
				source: { kind: 'sample', label: 'Sample data', resettable: true }
			},
			viewer: { kind: 'organizer' }
		})).toThrow(new TypeError('live_review_source_required'));

		expect(() => createLiveReviewPagePort({
			review: live,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			changesets: {
				...fakeChangesets(draftView(stepBackDraftData())).port,
				source: { kind: 'sample', label: 'Sample data' }
			}
		})).toThrow(new TypeError('live_review_source_required'));
	});

	test('serves plans without discarded rounds and with UTC-derived deadline copy', async () => {
		const plans = await organizerPort().review.plans();
		expect(plans.map((plan) => ({ id: plan.id, deadlineRelative: plan.deadlineRelative }))).toEqual([
			{ id: id(40), deadlineRelative: 'closed Jul 28' },
			{ id: openRoundId, deadlineRelative: 'due in 19 days' }
		]);
		expect(plans[1]).toMatchObject({
			name: 'Round 2',
			scaleMax: 5,
			anonymized: true,
			antiAnchoring: true,
			done: 1,
			total: 2,
			// Undisclosed display name stays absent, never an invented label.
			reviewers: [{ id: reviewerId, name: '', assigned: 2, done: 1 }]
		});
	});

	test('serves round setup with canonical counts and absent names kept absent', async () => {
		expect(await organizerPort().review.roundSetup()).toEqual({
			activeReviewers: 2,
			invitedReviewers: 1,
			submissions: 6,
			expectedReviews: 12,
			perReviewer: [
				{ id: reviewerId, name: 'Ada Bell', assigned: 6 },
				{ id: id(30), name: '', assigned: 6 }
			]
		});
	});

	test('serves the reviewer queue with draft and committed values in their own places', async () => {
		const { page } = reviewerPort();
		expect(await page.review.myQueue()).toEqual([{
			submissionId: scoredSubmissionId,
			myScore: 4,
			myComment: 'Working notes.',
			committed: false
		}, {
			submissionId: committedSubmissionId,
			myScore: 5,
			myComment: 'Must-have.',
			committed: true,
			peerScores: [3, 4],
			revisions: [{
				score: 5,
				comment: 'Must-have.',
				at: '2026-08-10T09:00:00.000Z',
				postUnlock: false
			}]
		}]);
	});

	test('states an organizer queue as the true empty list', async () => {
		expect(await organizerPort().review.myQueue()).toEqual([]);
	});

	test('serves standings for asked ids and null for the served absence', async () => {
		const { page, snapshotRequests } = reviewerPort();
		const standing = await page.review.standing(scoredSubmissionId);
		expect(standing).toEqual({
			value: 4.2,
			scaleMax: 5,
			reviews: 2,
			n: 3,
			median: 3.5,
			band: 'few',
			phrase: 'Too few scored yet to rank.',
			// Undisclosed slice label stays absent in the tuned string.
			slice: { label: '', trackId: id(11) },
			points: [3.5, 3.1]
		});
		expect(await page.review.standing(id(99))).toBeNull();
		expect(await page.review.standings([scoredSubmissionId])).toEqual({
			[scoredSubmissionId]: {
				value: 4.2,
				scaleMax: 5,
				reviews: 2,
				n: 3,
				median: 3.5,
				band: 'few',
				phrase: 'Too few scored yet to rank.',
				slice: { label: '', trackId: id(11) },
				points: [3.5, 3.1]
			}
		});
		expect(snapshotRequests).toEqual([
			{ standingSubmissionIds: [scoredSubmissionId] },
			{ standingSubmissionIds: [id(99)] },
			{ standingSubmissionIds: [scoredSubmissionId] }
		]);
	});

	test('splits a large standings ask into exact chunks of at most 100 ids', async () => {
		const { page, snapshotRequests } = reviewerPort();
		const asked = Array.from({ length: 150 }, (_, index) => id(2000 + index));
		// A duplicated id is asked once, never spent against the chunk budget.
		await page.review.standings([...asked, asked[0]!]);
		expect(snapshotRequests.map((request) => request.standingSubmissionIds?.length))
			.toEqual([100, 50]);
		expect(snapshotRequests[0]?.standingSubmissionIds).toEqual(asked.slice(0, 100));
		expect(snapshotRequests[1]?.standingSubmissionIds).toEqual(asked.slice(100));
	});

	test('serves only the viewer’s own served scope and refuses any other subject', async () => {
		const { page } = reviewerPort();
		expect(await page.review.myScope(reviewerId)).toEqual([{ kind: 'track', id: id(11) }]);
		expect(await liveErrorCode(page.review.myScope(id(31)))).toBe('reviewer_scope');
		expect(await liveErrorCode(organizerPort().review.myScope(reviewerId))).toBe(
			'reviewer_scope'
		);
	});

	test('maps the live vocabulary and keeps the loading-shape answer unread', async () => {
		const page = organizerPort();
		expect(page.workspace.reviewPlanExpectedSnapshot()).toBeNull();
		expect(await page.vocab.tracks()).toEqual([{
			id: id(11),
			name: 'AI',
			accent: 'lavender',
			status: 'active',
			usage: { currentReferences: 2, historicalPins: 0 }
		}]);
		expect(await page.vocab.formats()).toEqual([{
			id: id(12),
			name: 'Talk',
			status: 'active',
			usage: { currentReferences: 0, historicalPins: 0 }
		}]);
	});

	test('surfaces every capability without a canonical owner as its typed refusal', async () => {
		const page = organizerPort();
		expect(await liveErrorCode(page.submissions.get(id(50)))).toBe('submission_detail');
		expect(await liveErrorCode(
			page.review.openRound({ deadlineIso: '2026-09-01', anonymized: true })
		)).toBe('review_round_commit');
		// Save is live, but an organizer holds no assignment for the submission.
		expect(await liveErrorCode(page.review.saveReview(id(50), 4, 'x'))).toBe(
			'review_assignment_missing'
		);
		expect(await liveErrorCode(page.review.commitReview(id(50)))).toBe(
			'review_evaluation_commit'
		);
		expect(await liveErrorCode(page.review.amend(id(50), 4, 'x'))).toBe(
			'review_evaluation_amend'
		);
		expect(await liveErrorCode(page.review.revertAmend(id(50)))).toBe(
			'review_evaluation_revert'
		);
		expect(await liveErrorCode(page.review.comparables(id(50), 'track'))).toBe(
			'review_comparison'
		);
		expect(await liveErrorCode(page.tasks.remind([reviewerId], 'Review reminder'))).toBe(
			'reviewer_reminders'
		);
		expect(await liveErrorCode(page.schedule.state())).toBe('review_schedule_state');

		expect(await page.review.discardRound(openRoundId)).toEqual({
			ok: false,
			reason: 'Discarding a review round is not available in this live workspace yet.'
		});
		expect((await page.review.stepBack(id(50), reviewerId)).ok).toBe(false);
		expect((await page.review.pinAccolade(id(50), 'top_pick')).ok).toBe(false);
		expect((await page.review.unpinAccolade(id(50), 'top_pick')).ok).toBe(false);

		// No accolade owner exists, so no defs exist to offer; no profile owner
		// is mounted, so every profile is the typed unknown-profile absence.
		expect(await page.review.accoladeDefs()).toEqual([]);
		expect(await page.speakers.profile('ada@example.com')).toBeNull();
	});

	test('propagates a failed snapshot read as the typed failure, never as empty data', async () => {
		const failing: ReviewCorePort = {
			...corePort({ kind: 'organizer' }).port,
			async readSnapshot() {
				return { kind: 'unavailable', operation: 'snapshot', reason: 'operation_not_registered' };
			}
		};
		const page = createLiveReviewPagePort({
			review: failing,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			now: () => NOW
		});
		expect(await liveErrorCode(page.review.plans())).toBe('operation_not_registered');
	});

	test('saves the tuned single score onto the served criterion identity', async () => {
		const saves: { input: unknown; key: string }[] = [];
		const base = corePort({ kind: 'reviewer', reviewerId }).port;
		const review: ReviewCorePort = {
			...base,
			async saveEvaluationDraft(input, key) {
				saves.push({ input, key });
				return {
					kind: 'success',
					data: mapReviewDraftSave(reviewDraftSaveResultSchema.parse({
						draft: {
							schemaVersion: 1,
							scope: { workspaceId: id(1), eventId: id(2) },
							assignmentId: id(7),
							version: 2,
							scores: [{ criterionId: openCriterionId, score: 3 }],
							comment: 'Sharper.',
							updatedByReviewerId: reviewerId,
							updatedByUserId: id(33),
							updatedAt: '2026-08-13T12:10:00.000Z'
						}
					})),
					receipt: {
						id: id(502),
						operationName: 'review.evaluation.draft.save',
						operationVersion: 1
					},
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'reviewer', reviewerId },
			now: () => NOW
		});
		await page.review.saveReview(scoredSubmissionId, 3, 'Sharper.');
		expect(saves).toHaveLength(1);
		expect(saves[0]?.input).toEqual({
			assignmentId: id(7),
			expectedDraftVersion: 1,
			scores: [{ criterionId: openCriterionId, score: 3 }],
			comment: 'Sharper.'
		});
		expect(saves[0]?.key).toMatch(/^je\.review\.evaluation-save\.save\.[0-9a-f]{64}$/);

		// A non-integer or out-of-scale score refuses before any request leaves.
		expect(await liveErrorCode(page.review.saveReview(scoredSubmissionId, 4.5, '')))
			.toBe('review_score_invalid');
		expect(await liveErrorCode(page.review.saveReview(committedSubmissionId, 4, '')))
			.toBe('review_already_committed');
		expect(saves).toHaveLength(1);
	});

	test('refuses the single-score save on a round serving several criteria', async () => {
		const twoCriteria: CriterionInput[] = [{
			id: id(73), key: 'quality', label: 'Quality', position: 0,
			weightBps: 6_000, scaleMin: 1, scaleMax: 5
		}, {
			id: id(74), key: 'fit', label: 'Fit', position: 1,
			weightBps: 4_000, scaleMin: 1, scaleMax: 5
		}];
		const review: ReviewCorePort = {
			...corePort({ kind: 'reviewer', reviewerId }).port,
			async readSnapshot() {
				return {
					kind: 'success',
					data: mapReviewSnapshot(
						canonicalSnapshot({ kind: 'reviewer', reviewerId }, { openRoundCriteria: twoCriteria })
					),
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'reviewer', reviewerId },
			now: () => NOW
		});
		expect(await liveErrorCode(page.review.saveReview(scoredSubmissionId, 4, 'x')))
			.toBe('review_multi_criterion_round');
	});

	test('commits a drafted review through propose and commit, then re-reads the truth', async () => {
		const drafted = draftView({
			schemaVersion: 1,
			action: 'commit_review',
			changesetId: id(80),
			headVersion: 1,
			status: 'draft',
			revision: { id: id(81), number: 1, digestSha256: 'a'.repeat(64) },
			riskTier: 'normal',
			approvalPolicy,
			safeDiff: {
				action: 'commit_review',
				assignmentId: id(7),
				submissionId: scoredSubmissionId,
				weightedScore: 4,
				commentPresent: true
			}
		});
		const { port: changesets, calls } = fakeChangesets(drafted);
		const snapshots = [
			canonicalSnapshot({ kind: 'reviewer', reviewerId }),
			canonicalSnapshot({ kind: 'reviewer', reviewerId }, { scoredCommitted: true })
		];
		const evaluationDrafts: { input: unknown; key: string }[] = [];
		const review: ReviewCorePort = {
			...corePort({ kind: 'reviewer', reviewerId }).port,
			async readSnapshot() {
				const next = snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!;
				return { kind: 'success', data: mapReviewSnapshot(next), correlationId };
			},
			async draftEvaluationChange(input, key) {
				evaluationDrafts.push({ input, key });
				return {
					kind: 'success',
					data: drafted,
					receipt: {
						id: id(503),
						operationName: 'review.evaluation.change.draft',
						operationVersion: 1
					},
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'reviewer', reviewerId },
			changesets,
			now: () => NOW
		});
		const committed = await page.review.commitReview(scoredSubmissionId);
		expect(evaluationDrafts[0]?.input).toEqual({
			action: 'commit_review',
			assignmentId: id(7),
			expectedAssignmentVersion: 1,
			expectedDraftVersion: 1
		});
		expect(calls.propose?.input).toEqual({
			changesetId: id(80),
			revisionId: id(81),
			revisionDigest: 'a'.repeat(64),
			expectedHeadVersion: 1
		});
		expect(calls.commit?.input).toEqual({
			changesetId: id(80),
			revisionId: id(81),
			revisionDigest: 'a'.repeat(64),
			expectedHeadVersion: 2
		});
		expect(committed).toMatchObject({
			submissionId: scoredSubmissionId,
			committed: true,
			myScore: 4,
			myComment: 'Working notes.'
		});
	});

	test('refuses a commit without a saved draft instead of drafting a doomed change', async () => {
		const review: ReviewCorePort = {
			...corePort({ kind: 'reviewer', reviewerId }).port,
			async readSnapshot() {
				return {
					kind: 'success',
					data: mapReviewSnapshot(
						canonicalSnapshot({ kind: 'reviewer', reviewerId }, { scoredDraftAbsent: true })
					),
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'reviewer', reviewerId },
			changesets: fakeChangesets(draftView(stepBackDraftData())).port,
			now: () => NOW
		});
		expect(await liveErrorCode(page.review.commitReview(scoredSubmissionId)))
			.toBe('review_draft_missing');
	});

	test('opens a round with the server-defaulted criteria and returns the served plan', async () => {
		const newRoundId = id(85);
		const drafted = draftView({
			schemaVersion: 1,
			action: 'open_round',
			changesetId: id(82),
			headVersion: 1,
			status: 'draft',
			revision: { id: id(83), number: 1, digestSha256: 'c'.repeat(64) },
			riskTier: 'normal',
			approvalPolicy,
			safeDiff: {
				action: 'open_round',
				roundId: newRoundId,
				roundName: 'Round 3',
				assignmentCount: 2,
				reviewerCount: 1,
				submissionCount: 2,
				deadlineEffectiveAt: '2026-09-15T00:00:00.000Z',
				anonymized: true,
				criterionLabels: ['Overall'],
				deadline: {
					action: 'create',
					before: null,
					after: {
						id: id(86),
						status: 'active',
						version: 1,
						displayDate: '2026-09-14',
						effectiveAt: '2026-09-15T00:00:00.000Z',
						gracePolicy: 'soft'
					},
					representedConsequences: ['deadline_changed']
				}
			}
		});
		const { port: changesets, calls } = fakeChangesets(drafted);
		const afterSnapshot = canonicalSnapshot({ kind: 'organizer' }, {
			extraOpenRound: {
				id: newRoundId,
				name: 'Round 3',
				deadlineEffectiveAt: '2026-09-15T00:00:00.000Z',
				criterionId: id(87),
				total: 2
			}
		});
		const roundDrafts: { input: unknown; key: string }[] = [];
		const review: ReviewCorePort = {
			...corePort({ kind: 'organizer' }).port,
			async readSnapshot() {
				return {
					kind: 'success',
					data: mapReviewSnapshot(afterSnapshot),
					correlationId
				};
			},
			async draftRoundChange(input, key) {
				roundDrafts.push({ input, key });
				return {
					kind: 'success',
					data: drafted,
					receipt: {
						id: id(504),
						operationName: 'review.round.change.draft',
						operationVersion: 1
					},
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			changesets,
			now: () => NOW
		});
		const opened = await page.review.openRound({ deadlineIso: '2026-09-14', anonymized: true });
		// Criteria stay absent from the wire input: identities are server-minted.
		expect(roundDrafts[0]?.input).toEqual({
			action: 'open_round',
			deadlineDate: '2026-09-14',
			anonymized: true
		});
		expect(calls.propose?.input.expectedHeadVersion).toBe(1);
		expect(calls.commit?.input.expectedHeadVersion).toBe(2);
		expect(opened).toMatchObject({ id: newRoundId, name: 'Round 3', total: 2 });
	});

	test('discards a round pinned to its served version through the same ceremony', async () => {
		const drafted = draftView({
			schemaVersion: 1,
			action: 'discard_empty_round',
			changesetId: id(88),
			headVersion: 1,
			status: 'draft',
			revision: { id: id(89), number: 1, digestSha256: 'd'.repeat(64) },
			riskTier: 'normal',
			approvalPolicy,
			safeDiff: {
				action: 'discard_empty_round',
				roundId: openRoundId,
				roundName: 'Round 2'
			}
		});
		const { port: changesets, calls } = fakeChangesets(drafted);
		const roundDrafts: { input: unknown; key: string }[] = [];
		const review: ReviewCorePort = {
			...corePort({ kind: 'organizer' }).port,
			async draftRoundChange(input, key) {
				roundDrafts.push({ input, key });
				return {
					kind: 'success',
					data: drafted,
					receipt: {
						id: id(505),
						operationName: 'review.round.change.draft',
						operationVersion: 1
					},
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			changesets,
			now: () => NOW
		});
		expect(await page.review.discardRound(openRoundId)).toEqual({ ok: true });
		expect(roundDrafts[0]?.input).toEqual({
			action: 'discard_empty_round',
			roundId: openRoundId,
			expectedRoundVersion: 1
		});
		expect(calls.commit?.input.changesetId).toBe(id(88));
		expect(await page.review.discardRound(id(99))).toEqual({
			ok: false,
			reason: 'This round is not on the current review plan.'
		});
	});

	test('steps the viewer back from their own served assignment only', async () => {
		const drafted = draftView(stepBackDraftData());
		const { port: changesets, calls } = fakeChangesets(drafted);
		const stepDrafts: { input: unknown; key: string }[] = [];
		const review: ReviewCorePort = {
			...corePort({ kind: 'reviewer', reviewerId }).port,
			async draftStepBack(input, key) {
				stepDrafts.push({ input, key });
				return {
					kind: 'success',
					data: drafted,
					receipt: {
						id: id(506),
						operationName: 'review.assignment.step-back.draft',
						operationVersion: 1
					},
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'reviewer', reviewerId },
			changesets,
			now: () => NOW
		});
		expect(await page.review.stepBack(scoredSubmissionId, reviewerId)).toEqual({ ok: true });
		expect(stepDrafts[0]?.input).toEqual({
			action: 'step_back',
			assignmentId: id(7),
			expectedAssignmentVersion: 1
		});
		expect(calls.propose?.input.changesetId).toBe(id(84));
		expect((await page.review.stepBack(scoredSubmissionId, id(31))).ok).toBe(false);
	});

	test('surfaces a refused draft as the typed outcome copy on the outcome channel', async () => {
		const review: ReviewCorePort = {
			...corePort({ kind: 'organizer' }).port,
			async draftRoundChange() {
				return {
					kind: 'outcome',
					outcome: {
						class: 'stale_revision',
						kind: 'review.canonical_changed',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			changesets: fakeChangesets(draftView(stepBackDraftData())).port,
			now: () => NOW
		});
		expect(await page.review.discardRound(openRoundId)).toEqual({
			ok: false,
			reason: 'The review round changed while you were working. Reload and try again.'
		});
	});

	test('words a mutation refusal on the change channel, never as a lost read', async () => {
		const review: ReviewCorePort = {
			...corePort({ kind: 'organizer' }).port,
			async draftRoundChange() {
				return {
					kind: 'outcome',
					outcome: {
						class: 'access_denied',
						kind: 'authority.permission_missing',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
		};
		const page = createLiveReviewPagePort({
			review,
			vocabulary: vocabulary(),
			viewer: { kind: 'organizer' },
			changesets: fakeChangesets(draftView(stepBackDraftData())).port,
			now: () => NOW
		});
		expect(await page.review.discardRound(openRoundId)).toEqual({
			ok: false,
			reason: 'You no longer have permission to change review round.'
		});
	});
});

function stepBackDraftData() {
	return {
		schemaVersion: 1,
		action: 'step_back',
		changesetId: id(84),
		headVersion: 1,
		status: 'draft',
		revision: { id: id(93), number: 1, digestSha256: 'e'.repeat(64) },
		riskTier: 'normal',
		approvalPolicy,
		safeDiff: {
			action: 'step_back',
			assignmentId: id(7),
			submissionId: scoredSubmissionId
		}
	};
}
