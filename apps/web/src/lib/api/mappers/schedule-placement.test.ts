import { describe, expect, test } from 'bun:test';
import {
	schedulePlacementDraftDataSchema,
	schedulePlacementSnapshotSchema
} from '@jooevents/contracts/schedule-placement';
import {
	mapSchedulePlacementCommit,
	mapSchedulePlacementDraft,
	mapSchedulePlacementSnapshot
} from './schedule-placement';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });
const occurrence = Object.freeze({
	id: id(3),
	sessionId: id(4),
	roomId: id(5),
	startAt: '2026-09-01T09:00:00.000Z',
	endAt: '2026-09-01T09:45:00.000Z',
	version: 1
});

function placementPlan(action: 'place' | 'move') {
	const before = action === 'move' ? { ...occurrence, version: 2 } : null;
	const after = {
		...occurrence,
		version: action === 'move' ? 3 : 1,
		startAt: action === 'move' ? '2026-09-01T10:00:00.000Z' : occurrence.startAt,
		endAt: action === 'move' ? '2026-09-01T10:45:00.000Z' : occurrence.endAt
	};
	return {
		input: action === 'place'
			? {
				action, scope, expectedScheduleVersion: 4, occurrenceId: occurrence.id,
				sessionId: occurrence.sessionId, roomId: occurrence.roomId,
				startAt: after.startAt, endAt: after.endAt
			}
			: {
				action, scope, expectedScheduleVersion: 4, occurrenceId: occurrence.id,
				expectedOccurrenceVersion: 2, roomId: occurrence.roomId,
				startAt: after.startAt, endAt: after.endAt
			},
		before,
		after,
		scheduleVersion: { before: 4, after: 5 },
		roomQueryGuard: {
			id: `schedule_room_query:${scope.eventId}:${occurrence.roomId}`,
			version: 4,
			digestSha256: digest('a')
		}
	};
}

function draft(action: 'place' | 'move') {
	return schedulePlacementDraftDataSchema.parse({
		schemaVersion: 1,
		action,
		changesetId: id(6),
		headVersion: 1,
		status: 'draft',
		revision: { id: id(7), number: 1, digestSha256: digest('b') },
		riskTier: 'normal',
		approvalPolicy: {
			reference: { key: 'policy.schedule.placement.bounded', version: 1 },
			definitionDigestSha256: digest('c'),
			requirement: 'none'
		},
		safeDiff: placementPlan(action)
	});
}

describe('Schedule placement browser mapper', () => {
	test('keeps canonical scope and versions while naming UTC-only time evidence honestly', () => {
		const view = mapSchedulePlacementSnapshot(schedulePlacementSnapshotSchema.parse({
			schemaVersion: 1,
			scope,
			scheduleVersion: 4,
			occurrences: [occurrence]
		}));

		expect(view).toEqual({
			schemaVersion: 1,
			scope,
			scheduleVersion: 4,
			timeBasis: {
				kind: 'utc_instants_only',
				eventTimezone: null,
				localCalendarReady: false
			},
			occurrences: [{
				id: occurrence.id,
				sessionId: occurrence.sessionId,
				roomId: occurrence.roomId,
				startAtUtc: occurrence.startAt,
				endAtUtc: occurrence.endAt,
				version: 1
			}]
		});
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.occurrences)).toBe(true);
		expect(Object.isFrozen(view.occurrences[0])).toBe(true);
	});

	test('maps the exact draft selector, guard, and place images without a local timezone guess', () => {
		const view = mapSchedulePlacementDraft(draft('place'));
		expect(view).toMatchObject({
			action: 'place',
			selector: {
				changesetId: id(6),
				revisionId: id(7),
				revisionDigest: digest('b')
			},
			headVersion: 1,
			revisionNumber: 1,
			safeDiff: {
				action: 'place',
				input: {
					action: 'place',
					expectedScheduleVersion: 4,
					startAtUtc: occurrence.startAt,
					endAtUtc: occurrence.endAt
				},
				timeBasis: { eventTimezone: null, localCalendarReady: false }
			}
		});
		expect(JSON.stringify(view)).not.toContain('timezone":"UTC');
	});

	test('projects a committed move from the reviewed after-image and exact head advance', () => {
		const value = draft('move');
		const view = mapSchedulePlacementCommit({
			draft: value,
			proposedHeadVersion: 2,
			committedHeadVersion: 3
		});

		expect(view).toMatchObject({
			action: 'move',
			changesetHead: { proposedVersion: 2, committedVersion: 3 },
			scheduleVersion: 5,
			occurrence: {
				id: occurrence.id,
				startAtUtc: '2026-09-01T10:00:00.000Z',
				endAtUtc: '2026-09-01T10:45:00.000Z',
				version: 3
			}
		});
	});
});
