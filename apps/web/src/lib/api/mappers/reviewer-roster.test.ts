import { describe, expect, test } from 'bun:test';
import {
	reviewerRosterSnapshotSchema,
	type ReviewerRosterSnapshotDto
} from '@jooevents/contracts/reviewer-roster';
import { mapReviewerRosterSnapshot } from './reviewer-roster';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);

function snapshot(): ReviewerRosterSnapshotDto {
	const scope = { workspaceId: id(1), eventId: id(2) };
	const membership = { kind: 'workspace_membership' as const, id: id(11), version: 1 };
	const reservation = { kind: 'access_reservation' as const, id: id(21), version: 1 };
	return reviewerRosterSnapshotSchema.parse({
		schemaVersion: 1,
		scope,
		version: 4,
		digestSha256: digest('a'),
		rosterVersion: 3,
		rosterDigestSha256: digest('b'),
		authorityVersion: 2,
		authorityDigestSha256: digest('c'),
		reviewers: [{
			reviewerId: id(10),
			recordVersion: 2,
			projectionVersion: 3,
			status: 'active',
			accessSubject: membership,
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: membership,
				currentSubject: membership,
				state: 'active',
				version: 5,
				digestSha256: digest('d'),
				capabilityIds: [
					'event.read',
					'speaker.directory.read',
					'submission.read',
					'submission.score',
					'submission.comment',
					'schedule.read'
				],
				evidenceIds: ['evidence:membership'],
				displayName: 'Ada Bell'
			},
			displayName: 'Ada Bell',
			reviews: [{ kind: 'track', id: id(12) }]
		}, {
			reviewerId: id(20),
			recordVersion: 1,
			projectionVersion: 1,
			status: 'invited',
			accessSubject: reservation,
			authority: {
				schemaVersion: 1,
				scope,
				rosterSubject: reservation,
				currentSubject: reservation,
				state: 'reserved',
				version: 1,
				digestSha256: digest('e'),
				capabilityIds: [
					'event.read',
					'speaker.directory.read',
					'submission.read',
					'submission.score',
					'submission.comment',
					'schedule.read'
				],
				evidenceIds: ['evidence:reservation'],
				displayName: 'Ben Cho'
			},
			// Roster-level display name deliberately undisclosed for this member.
			reviews: []
		}]
	});
}

describe('reviewer roster mappers', () => {
	test('copies the snapshot deeply frozen without aliasing the wire value', () => {
		const wire = snapshot();
		const view = mapReviewerRosterSnapshot(wire);

		expect(view).toEqual(wire as never);
		expect(view).not.toBe(wire as never);
		expect(view.reviewers[0]).not.toBe(wire.reviewers[0] as never);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.reviewers)).toBe(true);
		expect(Object.isFrozen(view.reviewers[0]?.authority)).toBe(true);
		expect(Object.isFrozen(view.reviewers[0]?.reviews)).toBe(true);

		// Mutating the wire value after mapping must not reach the view.
		wire.reviewers[0]!.reviews.push({ ...wire.reviewers[0]!.reviews[0]! });
		expect(view.reviewers[0]?.reviews).toHaveLength(1);
	});

	test('keeps canonical absence absent instead of inventing labels', () => {
		const view = mapReviewerRosterSnapshot(snapshot());
		expect(view.reviewers[1]?.displayName).toBeUndefined();
		expect('email' in (view.reviewers[1] ?? {})).toBe(false);
	});

});
