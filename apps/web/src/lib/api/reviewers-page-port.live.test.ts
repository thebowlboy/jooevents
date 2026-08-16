import { describe, expect, test } from 'bun:test';
import { workspaceTeamSnapshotSchema } from '@jooevents/contracts';
import {
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
const subject = { kind: 'workspace_membership' as const, id: membershipId, version: 1 };
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
				authorityDigestSha256: 'c'.repeat(64), reviewers: [{ reviewerId, recordVersion,
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
		data: { schemaVersion: 1, viewer: { kind: 'organizer' }, plans: [], standings: {} } }; },
	async readRoundSetup() { throw new Error('unused'); }, async changeRound() { throw new Error('unused'); },
	async stepBack() { throw new Error('unused'); }, async changeEvaluation() { throw new Error('unused'); },
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
const team: Pick<WorkspaceTeamSettingsPort, 'source' | 'members'> = {
	source: { kind: 'live' }, async members() { return { kind: 'success', correlationId,
		data: mapWorkspaceTeamSnapshot(workspaceTeamSnapshotSchema.parse({
			schemaVersion: 1, version: 1, digestSha256: 'e'.repeat(64), roles, members: []
		})) }; }
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

	test('keeps email invite on its separate refused reservation workflow', async () => {
		const page = createLiveReviewersPagePort({ roster: rosterPort([]), review, team, vocabulary });
		expect(await page.reviewers.invite([{ email: 'ada@example.test' }])).toEqual([{
			email: 'ada@example.test', ok: false,
			reason: 'Inviting reviewers by email is not available in this live workspace yet. Reviewer access is reserved through workspace member admission.'
		}]);
	});
});
