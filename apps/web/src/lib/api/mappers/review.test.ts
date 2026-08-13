import { describe, expect, test } from 'bun:test';
import { reviewSnapshotSchema, type ReviewSnapshot } from '@jooevents/contracts/reviews';
import { mapReviewSnapshot } from './review';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function snapshot(): ReviewSnapshot {
	const workspaceId = id(1);
	const eventId = id(2);
	const reviewerId = id(3);
	const roundId = id(4);
	const firstSubmissionId = id(5);
	const secondSubmissionId = id(6);
	const firstAssignmentId = id(7);
	const secondAssignmentId = id(8);
	const firstRevisionId = id(9);
	const secondRevisionId = id(10);

	return reviewSnapshotSchema.parse({
		schemaVersion: 1,
		viewer: { kind: 'reviewer', reviewerId },
		plans: [{
			id: roundId,
			ordinal: 1,
			name: 'Round 1',
			state: 'open',
			version: 1,
			scaleMax: 5,
			criteria: [{
				id: id(13), key: 'overall', label: 'Overall', position: 0,
				weightBps: 10_000, scaleMin: 1, scaleMax: 5
			}],
			deadlineEffectiveAt: '2026-09-01T23:59:59.000Z',
			anonymized: true,
			antiAnchoring: true,
			done: 1,
			total: 2,
			reviewers: [{
				reviewerId,
				assigned: 2,
				done: 1,
				steppedBack: 0,
				awaitingReassignment: 0
			}]
		}],
		reviewerScope: [{ kind: 'track', id: id(11) }],
		queue: [{
			assignmentId: firstAssignmentId,
			roundId,
			submissionId: firstSubmissionId,
			assignmentVersion: 1,
			candidate: {
				submissionId: firstSubmissionId,
				version: 2,
				title: 'Blind candidate',
				abstract: 'The canonical candidate body.',
				submittedAt: '2026-08-13T10:00:00.000Z',
				trackId: id(11),
				targetSessionId: id(12),
				resources: []
			},
			committed: false,
			revisions: []
		}, {
			assignmentId: secondAssignmentId,
			roundId,
			submissionId: secondSubmissionId,
			assignmentVersion: 3,
			candidate: {
				submissionId: secondSubmissionId,
				version: 4,
				title: 'Committed candidate',
				abstract: 'A review with an attributable amendment.',
				submittedAt: '2026-08-13T10:01:00.000Z',
				resources: []
			},
			committed: true,
			current: {
				revisionId: secondRevisionId,
				score: 4,
				comment: 'Recalibrated after peer reveal.',
				at: '2026-08-13T11:00:00.000Z',
				postUnlock: true,
				correctionOfRevisionId: firstRevisionId
			},
			revisions: [{
				revisionId: firstRevisionId,
				score: 3,
				comment: 'Initial independent judgment.',
				at: '2026-08-13T10:30:00.000Z',
				postUnlock: false
			}, {
				revisionId: secondRevisionId,
				score: 4,
				comment: 'Recalibrated after peer reveal.',
				at: '2026-08-13T11:00:00.000Z',
				postUnlock: true,
				correctionOfRevisionId: firstRevisionId
			}],
			peerScores: []
		}],
		standings: {}
	});
}

describe('Review source-neutral mapper', () => {
	test('preserves disclosure absence, peer unlock, target context, and revision truth', () => {
		const canonical = snapshot();
		const mapped = mapReviewSnapshot(canonical);
		const first = mapped.queue?.[0];
		const second = mapped.queue?.[1];

		expect(String(first?.candidate.targetSessionId)).toBe(id(12));
		expect('speakers' in (first?.candidate ?? {})).toBe(false);
		expect('peerScores' in (first ?? {})).toBe(false);
		expect(second?.peerScores).toEqual([]);
		expect(second?.current).toMatchObject({
			postUnlock: true,
			correctionOfRevisionId: id(9)
		});
		expect('displayName' in (mapped.plans[0]?.reviewers[0] ?? {})).toBe(false);
		// Served criterion identities are carried by value, never re-minted.
		expect(mapped.plans[0]?.criteria.map((criterion) => String(criterion.id))).toEqual([id(13)]);
		expect(mapped.plans[0]?.version).toBe(1);
		expect(Object.isFrozen(mapped)).toBe(true);
		expect(Object.isFrozen(second?.revisions)).toBe(true);

		canonical.plans[0]!.name = 'Changed after mapping';
		expect(mapped.plans[0]?.name).toBe('Round 1');
	});
});
