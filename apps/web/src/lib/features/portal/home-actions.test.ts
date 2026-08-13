import { describe, expect, test } from 'bun:test';
import { mapPortalSnapshot } from '$lib/api/portal/mappers';
import { portalSnapshotDto } from '$lib/api/portal/sample/projection';
import { portalScenarios } from '$lib/api/portal/sample/registry';
import type { PortalDataset } from '$lib/api/portal/sample/dataset';
import type { PortalSnapshotView } from '$lib/api/portal/view-models';
import { engagementStatusCopy, submissionStatusCopy, taskStateCopy } from './copy';
import { engagementForSubmission, portalActionItems, tasksForSession } from './home-actions';

const now = Date.parse('2026-08-12T09:00:00-04:00');

function snapshotOf(key: string): PortalSnapshotView {
	const dataset = portalScenarios.find((scenario: PortalDataset) => scenario.key === key);
	if (!dataset) throw new Error(`No portal scenario named ${key}`);
	return mapPortalSnapshot(portalSnapshotDto(dataset, now), now);
}

describe('what is waiting on the participant', () => {
	test('nothing is asked of someone whose submissions are simply being read', () => {
		expect(portalActionItems(snapshotOf('submitted'), now)).toEqual([]);
	});

	test('an unanswered invitation and a task that still accepts work are the only entries', () => {
		const items = portalActionItems(snapshotOf('accepted'), now);
		expect(items.map((item) => item.kind)).toEqual(['engagement', 'task']);
		expect(items[0]?.headline).toContain('Confirm you can speak at');
		expect(items[1]?.targetId).toBe('tsk-av');
		expect(items[1]?.detail).toBe('You can still send it; it will be marked late.');
	});

	test('a decision offers another look exactly once per submission', () => {
		const snapshot = snapshotOf('declined');
		const items = portalActionItems(snapshot, now);
		expect(items.every((item) => item.kind === 'appeal')).toBe(true);
		// The submission whose request was already sent is not offered a second one.
		const spent = snapshot.submissions.filter(
			(submission) => submission.appeal.kind === 'submitted'
		);
		expect(spent).toHaveLength(1);
		expect(items.map((item) => item.targetId)).not.toContain(spent[0]?.id);
		expect(items.every((item) => item.href?.endsWith('?appeal=1'))).toBe(true);
	});

	test('an answered invitation and a deadline still weeks away ask for nothing', () => {
		expect(portalActionItems(snapshotOf('mixed'), now)).toEqual([]);
	});

	test('a task closed against further work is a state, never an entry', () => {
		const snapshot = snapshotOf('accepted');
		const closed: PortalSnapshotView = {
			...snapshot,
			tasks: snapshot.tasks.map((task) =>
				task.id === 'tsk-av' ? { ...task, acceptsLateCompletion: false } : task
			)
		};
		expect(portalActionItems(closed, now).map((item) => item.kind)).toEqual(['engagement']);
	});
});

describe('every scenario renders with words the surface owns', () => {
	for (const scenario of portalScenarios) {
		test(`“${scenario.name}” is fully described`, () => {
			const snapshot = snapshotOf(scenario.key);
			for (const submission of snapshot.submissions) {
				expect(submissionStatusCopy[submission.status]?.label).toBeTruthy();
			}
			for (const task of snapshot.tasks) {
				expect(taskStateCopy[task.state]?.label).toBeTruthy();
			}
			for (const engagement of snapshot.engagements) {
				expect(engagementStatusCopy[engagement.status]?.label).toBeTruthy();
				// Every invitation points back at a submission this participant can open.
				if (engagement.submissionId !== null) {
					expect(
						snapshot.submissions.some((submission) => submission.id === engagement.submissionId)
					).toBe(true);
				}
			}
			// A decision the participant has not been told is never carried here.
			for (const submission of snapshot.submissions) {
				const decided =
					submission.status === 'accepted' ||
					submission.status === 'declined' ||
					submission.status === 'waitlisted';
				if (decided) expect(submission.statusNotifiedAt).not.toBeNull();
			}
		});
	}
});

describe('joins used by the record pages', () => {
	test('a submission finds its own invitation and that session’s checklist', () => {
		const snapshot = snapshotOf('accepted');
		const engagement = engagementForSubmission(snapshot, 'sub-101');
		expect(engagement?.id).toBe('eng-101');
		expect(tasksForSession(snapshot, engagement?.sessionId ?? null).length).toBe(
			snapshot.tasks.length
		);
	});

	test('a submission with no session has no checklist to show', () => {
		const snapshot = snapshotOf('submitted');
		expect(engagementForSubmission(snapshot, 'sub-201')).toBeNull();
		expect(tasksForSession(snapshot, null)).toEqual([]);
	});
});
