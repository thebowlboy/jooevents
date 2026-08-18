import { describe, expect, test } from 'bun:test';
import { workspaceTeamSnapshotSchema } from '@jooevents/contracts';
import { reviewMutationResultSchema } from '@jooevents/contracts/reviews';
import {
	reviewerCoveragePopulationSchema,
	reviewerRosterMutationResultSchema,
	reviewerRosterSnapshotSchema,
	type ReviewerRosterMutationResult
} from '@jooevents/contracts/reviewer-roster';
import { mapReviewerRosterSnapshot } from './mappers/reviewer-roster';
import { mapWorkspaceTeamSnapshot } from './mappers/workspace-team';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ReviewCorePort } from './review-core-port';
import type { ReviewerRosterChangeRequest, ReviewerRosterCorePort } from './reviewer-roster-core-port';
import { createLiveReviewersPagePort } from './reviewers-page-port.live';
import type { WorkspaceTeamSettingsPort } from './workspace-team-settings-adapter';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90); const scope = { workspaceId: id(80), eventId: id(81) };
const reviewerId = id(1); const membershipId = id(2); const trackId = id(3);
const formatId = id(5); const sessionId = id(6);
const subject = { kind: 'workspace_membership' as const, id: membershipId, version: 1 };
const coveragePopulation = reviewerCoveragePopulationSchema.parse({
	schemaVersion: 1,
	candidateVersion: 11,
	candidateCount: 7,
	digestSha256: '9'.repeat(64),
	counts: [
		{ ref: { kind: 'track', id: trackId }, submissions: 7 },
		{ ref: { kind: 'format', id: formatId }, submissions: 5 },
		{ ref: { kind: 'session', id: sessionId }, submissions: 3 }
	]
});
function mutation(action: ReviewerRosterMutationResult['action'], revoked: boolean): ReviewerRosterMutationResult {
	return reviewerRosterMutationResultSchema.parse({ schemaVersion: 1, action, rosterVersion: 2, rosterDigestSha256: 'b'.repeat(64),
		reviewer: { schemaVersion: 1, scope, reviewerId, version: 2, accessSubject: subject,
			reviews: [{ kind: 'track', id: trackId }], addedByUserId: id(4), addedAt: '2027-03-01T00:00:00.000Z',
			state: revoked ? 'revoked' : 'included',
			...(revoked ? { revokedByUserId: id(4), revokedAt: '2027-03-02T00:00:00.000Z' } : {}) } });
}
function rosterPort(calls: { input: ReviewerRosterChangeRequest; key: string }[]): ReviewerRosterCorePort {
	let revoked = false; let recordVersion = 1; let rosterVersion = 1;
	return { source: { kind: 'live' },
		async readSnapshot() {
			return { kind: 'success', correlationId, data: mapReviewerRosterSnapshot(reviewerRosterSnapshotSchema.parse({
				schemaVersion: 1, scope, version: rosterVersion, digestSha256: 'a'.repeat(64),
				rosterVersion, rosterDigestSha256: 'b'.repeat(64), authorityVersion: 1,
				authorityDigestSha256: 'c'.repeat(64), coveragePopulation,
				reviewers: [{ reviewerId, recordVersion,
					projectionVersion: recordVersion, status: revoked ? 'revoked' : 'active', accessSubject: subject,
					authority: { schemaVersion: 1, scope, rosterSubject: subject,
						...(revoked ? {} : { currentSubject: subject }), state: revoked ? 'unavailable' : 'active',
						version: 1, digestSha256: 'd'.repeat(64),
						capabilityIds: revoked ? [] : [
							'event.read', 'speaker.directory.read', 'submission.read',
							'submission.score', 'submission.comment', 'schedule.read'
						], evidenceIds: ['evidence:membership'] },
					displayName: 'Ada', reviews: [{ kind: 'track', id: trackId }] }] })) };
		},
		async change(input, key) {
			calls.push({ input, key }); revoked = input.action === 'revoke' ? true : input.action === 'restore' ? false : revoked;
			recordVersion += 1; rosterVersion += 1;
			return { kind: 'success', data: mutation(input.action, revoked),
				receipt: { id: id(40), operationName: 'reviewer_roster.change', operationVersion: 1 }, correlationId };
		}
	};
}
const review: ReviewCorePort = { source: { kind: 'live' },
	async readSnapshot() { return { kind: 'success', correlationId,
		data: { schemaVersion: 1, viewer: { kind: 'organizer' }, plans: [], accoladeDefinitions: [], standings: {} } }; },
	async readRoundSetup() { throw new Error('unused'); }, async changeRound() { throw new Error('unused'); },
	async stepBack() { throw new Error('unused'); }, async changeEvaluation() { throw new Error('unused'); },
	async changeAccolade() { throw new Error('unused'); },
	async saveEvaluationDraft() { throw new Error('unused'); } };
const vocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> = {
	source: { kind: 'live' }, async tracks() { return []; }, async formats() { return []; }
};
const roles = [
	{ key: 'workspace_admin', name: 'Workspace Admin', version: 1 },
	{ key: 'event_manager', name: 'Event Manager', version: 1 },
	{ key: 'speaker_manager', name: 'Speaker Manager', version: 1 },
	{ key: 'speaker_reviewer', name: 'Speaker Reviewer', version: 1 },
	{ key: 'scheduler', name: 'Scheduler', version: 1 },
	{ key: 'communications_coordinator', name: 'Communications Coordinator', version: 1 },
	{ key: 'viewer', name: 'Viewer', version: 1 }
] as const;
const team: Pick<WorkspaceTeamSettingsPort, 'source' | 'members' | 'invite'> = {
	source: { kind: 'live' }, async members() { return { kind: 'success', correlationId,
		data: mapWorkspaceTeamSnapshot(workspaceTeamSnapshotSchema.parse({
			schemaVersion: 1, version: 1, digestSha256: 'e'.repeat(64), roles, members: []
		})) }; },
	async invite() { throw new Error('unused'); }
};

describe('direct live Reviewer page port', () => {
	test('sets scope and revokes with one fresh read and one caller key each', async () => {
		const calls: { input: ReviewerRosterChangeRequest; key: string }[] = []; let next = 0;
		const page = createLiveReviewersPagePort({ roster: rosterPort(calls), review, team, vocabulary,
			newAttemptKey: () => `roster-page-key-${++next}` });
		expect(await page.reviewers.setScope(reviewerId, [{ kind: 'track', id: trackId }])).toEqual({ ok: true });
		expect(await page.reviewers.remove(reviewerId)).toEqual({ ok: true });
		expect(calls.map(({ input, key }) => ({ action: input.action, key }))).toEqual([
			{ action: 'set_scope', key: 'roster-page-key-1' }, { action: 'revoke', key: 'roster-page-key-2' }
		]);
	});

	test('restores only from the retained revoked row without browser prior state', async () => {
		const calls: { input: ReviewerRosterChangeRequest; key: string }[] = [];
		const page = createLiveReviewersPagePort({ roster: rosterPort(calls), review, team, vocabulary,
			newAttemptKey: () => 'roster-forward-key' });
		expect(await page.reviewers.remove(reviewerId)).toEqual({ ok: true });
		await page.reviewers.restore(reviewerId);
		expect(calls.map(({ input }) => input.action)).toEqual(['revoke', 'restore']);
		const restored = calls[1]?.input;
		expect(restored).toMatchObject({ action: 'restore', reviewerId,
			expectedReviewerVersion: 2, expectedRosterVersion: 2 });
		expect(restored).not.toHaveProperty('before');
		expect(restored).not.toHaveProperty('reviews');
	});

	test('commits replacement and accepted coverage through the canonical Review vacancy operation', async () => {
		const calls: { input: unknown; key: string }[] = [];
		let next = 0;
		const vacancyReview: ReviewCorePort = {
			...review,
			async changeVacancy(input, key) {
				calls.push({ input, key });
				const data = input.action === 'assign_replacement'
					? reviewMutationResultSchema.parse({
						action: input.action,
						resolution: {
							schemaVersion: 1, scope, kind: 'replacement',
							vacatedAssignmentId: input.assignmentId,
							replacementAssignmentId: id(71),
							replacementReviewerId: input.replacementReviewerId,
							resolvedByUserId: id(72), resolvedAt: '2027-03-03T00:00:00.000Z'
						},
						replacement: {
							schemaVersion: 1, scope, id: id(71), roundId: id(73), submissionId: id(74),
							reviewerId: input.replacementReviewerId, version: 1, state: 'assigned',
							assignedAt: '2027-03-03T00:00:00.000Z'
						}
					})
					: reviewMutationResultSchema.parse({
						action: input.action,
						resolution: {
							schemaVersion: 1, scope, kind: 'coverage_accepted',
							vacatedAssignmentId: input.assignmentId,
							resolvedByUserId: id(72), resolvedAt: '2027-03-03T00:00:00.000Z'
						}
					});
				return {
					kind: 'success' as const,
					data,
					receipt: { id: id(75), operationName: 'review.assignment.vacancy.change', operationVersion: 1 },
					correlationId
				};
			}
		};
		const page = createLiveReviewersPagePort({
			roster: rosterPort([]), review: vacancyReview, team, vocabulary,
			newAttemptKey: () => `vacancy-key-${++next}`
		});
		expect(await page.reviewers.assignReplacement({
			assignmentId: id(70), expectedAssignmentVersion: 2, reviewerId
		})).toEqual({ ok: true });
		expect(await page.reviewers.acceptCoverage({
			assignmentId: id(76), expectedAssignmentVersion: 3
		})).toEqual({ ok: true });
		expect(calls).toEqual([
			{
				input: { action: 'assign_replacement', assignmentId: id(70), expectedAssignmentVersion: 2, replacementReviewerId: reviewerId },
				key: 'vacancy-key-1'
			},
			{
				input: { action: 'accept_coverage', assignmentId: id(76), expectedAssignmentVersion: 3 },
				key: 'vacancy-key-2'
			}
		]);
	});

	test('serves exact track, format, and collecting-session coverage from canonical counts', async () => {
		const countedVocabulary: Pick<ProgramVocabularySettingsPort, 'source' | 'tracks' | 'formats'> = {
			source: { kind: 'live' },
			async tracks() {
				return [{
					kind: 'track', id: trackId, name: 'Systems', accent: 'sea', status: 'active',
					version: 1, usage: { currentReferences: 7, historicalPins: 0 },
					deleteAvailability: { kind: 'unavailable', currentReferences: 7, historicalPins: 0 }
				}];
			},
			async formats() {
				return [{
					kind: 'format', id: formatId, name: 'Talk', status: 'active', version: 1,
					usage: { currentReferences: 5, historicalPins: 0 },
					deleteAvailability: { kind: 'unavailable', currentReferences: 5, historicalPins: 0 }
				}];
			}
		};
		const page = createLiveReviewersPagePort({
			roster: rosterPort([]), review, team, vocabulary: countedVocabulary,
			schedule: {
				async state() {
					return {
						days: [], rooms: [], dayStart: '09:00', slotMinutes: 30, slotsPerDay: 0,
						sessions: [{
							id: sessionId, title: 'Agents clinic', speakers: [], trackId, formatId,
							durationMin: 45, state: 'collecting' as const
						}],
						placements: [], breaks: [], published: false
					};
				}
			}
		});
		const roster = await page.reviewers.list();
		expect(roster.coverage).toEqual({
			kind: 'served',
			rows: [
				{ ref: { kind: 'track', id: trackId }, label: 'Systems', reviewers: 1, submissions: 7 },
				{ ref: { kind: 'format', id: formatId }, label: 'Talk', reviewers: 0, submissions: 5 },
				{ ref: { kind: 'session', id: sessionId }, label: 'Agents clinic', reviewers: 1, submissions: 3 }
			]
		});
	});

	test('reserves workspace access, then registers that exact reservation as reviewer authority', async () => {
		const reservationId = id(51);
		const invitedSnapshot = mapWorkspaceTeamSnapshot(workspaceTeamSnapshotSchema.parse({
			schemaVersion: 1, version: 2, digestSha256: 'f'.repeat(64), roles,
			members: [{
				id: reservationId, kind: 'invitation', name: 'ada', email: 'ada@example.test',
				role: roles[3], status: 'invited', delivery: 'awaiting_activation', version: 1,
				hasAdditionalAccess: false
			}]
		}));
		let invited = false;
		const invitingTeam: Pick<WorkspaceTeamSettingsPort, 'source' | 'members' | 'invite'> = {
			source: { kind: 'live' },
			async members() {
				return { kind: 'success', correlationId,
					data: invited ? invitedSnapshot : mapWorkspaceTeamSnapshot(workspaceTeamSnapshotSchema.parse({
						schemaVersion: 1, version: 1, digestSha256: 'e'.repeat(64), roles, members: []
					})) };
			},
			async invite(email, role) {
				expect({ email, role }).toEqual({ email: 'ada@example.test', role: 'Speaker Reviewer' });
				invited = true;
				return {
					kind: 'success', correlationId,
					receipt: { id: id(52), operationName: 'workspace.team.apply', operationVersion: 1 },
					data: {
						committed: {
							action: 'invite', teamVersion: 2,
							change: {
								action: 'invite', recipientHint: 'a…@example.test', role: roles[3],
								invitationStatus: 'recorded', delivery: 'awaiting_activation'
							}
						},
						team: invitedSnapshot,
						effect: {
							action: 'invite', invitationStatus: 'recorded', delivery: 'awaiting_activation',
							recipientHint: 'a…@example.test', currentInvitation: invitedSnapshot.members[0]!
						}
					}
				};
			}
		};
		const rosterCalls: ReviewerRosterChangeRequest[] = [];
		const emptyRoster: ReviewerRosterCorePort = {
			source: { kind: 'live' },
			async readSnapshot() {
				return { kind: 'success', correlationId, data: mapReviewerRosterSnapshot(
					reviewerRosterSnapshotSchema.parse({
						schemaVersion: 1, scope, version: 1, digestSha256: 'a'.repeat(64),
						rosterVersion: 1, rosterDigestSha256: 'b'.repeat(64), authorityVersion: 1,
						authorityDigestSha256: 'c'.repeat(64), reviewers: []
					})
				) };
			},
			async change(input) {
				rosterCalls.push(input);
				if (input.action !== 'register') throw new Error('expected_register');
				const result = reviewerRosterMutationResultSchema.parse({
					schemaVersion: 1, action: 'register', rosterVersion: 2,
					rosterDigestSha256: 'd'.repeat(64),
					reviewer: {
						schemaVersion: 1, scope, reviewerId: input.reviewerId, version: 1,
						accessSubject: input.accessSubject, reviews: input.reviews,
						addedByUserId: id(4), addedAt: '2027-03-01T00:00:00.000Z', state: 'included'
					}
				});
				return { kind: 'success', data: result,
					receipt: { id: id(53), operationName: 'reviewer_roster.change', operationVersion: 1 },
					correlationId };
			}
		};
		const page = createLiveReviewersPagePort({
			roster: emptyRoster, review, team: invitingTeam, vocabulary,
			newReviewerId: () => id(54), newAttemptKey: () => 'reviewer-invite-key'
		});
		expect(await page.reviewers.invite(
			[{ email: 'ADA@example.test' }], [{ kind: 'track', id: trackId }]
		)).toEqual([{
			email: 'ADA@example.test', ok: true,
			reviewer: {
				id: id(54), name: 'ada', email: 'ada@example.test', status: 'invited',
				scope: [{ kind: 'track', id: trackId }], assigned: 0, done: 0,
				steppedBack: 0, awaitingReassignment: 0
			}
		}]);
		expect(rosterCalls[0]).toMatchObject({
			action: 'register', reviewerId: id(54),
			accessSubject: { kind: 'access_reservation', id: reservationId, version: 1 },
			reviews: [{ kind: 'track', id: trackId }]
		});
	});

	test('reuses a composed reminder lane and refuses when that lane is absent', async () => {
		const sent: { ids: string[]; subject: string }[] = [];
		const wired = createLiveReviewersPagePort({
			roster: rosterPort([]), review, team, vocabulary,
			remind: async (ids, subject) => {
				sent.push({ ids: [...ids], subject });
			}
		});
		await wired.tasks.remind([reviewerId], 'Review reminder');
		expect(sent).toEqual([{ ids: [reviewerId], subject: 'Review reminder' }]);

		const unmounted = createLiveReviewersPagePort({
			roster: rosterPort([]), review, team, vocabulary
		});
		await expect(unmounted.tasks.remind([reviewerId], 'Review reminder')).rejects.toMatchObject({
			code: 'reviewer_reminders'
		});
	});
});
