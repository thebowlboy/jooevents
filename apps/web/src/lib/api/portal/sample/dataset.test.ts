import { describe, expect, test } from 'bun:test';
import { portalSnapshotSchema } from '@jooevents/contracts';
import { portalScenarios } from './registry';
import { portalSnapshotDto } from './projection';

const now = Date.parse('2026-08-12T09:00:00-04:00');

describe('participant portal scenarios', () => {
	test('every scenario projects a snapshot the published contract accepts', () => {
		for (const scenario of portalScenarios) {
			const parsed = portalSnapshotSchema.safeParse(portalSnapshotDto(scenario, now));
			expect(parsed.error?.issues ?? []).toEqual([]);
			expect(parsed.success).toBe(true);
		}
	});

	test('all four stories belong to the same event', () => {
		for (const scenario of portalScenarios) {
			expect(scenario.event).toMatchObject({
				id: 'evt_aie-nyc-2026',
				name: 'AI Engineer NYC 2026',
				timezone: 'America/New_York'
			});
		}
	});

	test('every scenario is exactly one participant seen through their own records', () => {
		for (const scenario of portalScenarios) {
			for (const submission of scenario.submissions) {
				expect(submission.speakers.some((speaker) => speaker.participantId === scenario.participant.id)).toBe(true);
			}
			for (const engagement of scenario.engagements) {
				expect(engagement.speakers.some((speaker) => speaker.participantId === scenario.participant.id)).toBe(true);
			}
		}
	});

	test('cross-references resolve inside each scenario', () => {
		for (const scenario of portalScenarios) {
			const submissionIds = new Set(scenario.submissions.map(({ id }) => id));
			const sessionIds = new Set(scenario.engagements.map(({ sessionId }) => sessionId));
			const taskIds = new Set(scenario.tasks.map(({ id }) => id));

			for (const engagement of scenario.engagements) {
				if (engagement.submissionId !== null) {
					expect(submissionIds.has(engagement.submissionId)).toBe(true);
				}
			}
			for (const task of scenario.tasks) {
				if (task.sessionId !== null) expect(sessionIds.has(task.sessionId)).toBe(true);
			}
			for (const file of scenario.files) {
				if (file.taskId !== null) expect(taskIds.has(file.taskId)).toBe(true);
			}
		}
	});

	test('a status the participant has not been told is never notified, and vice versa', () => {
		for (const scenario of portalScenarios) {
			for (const submission of scenario.submissions) {
				const decided =
					submission.status === 'accepted' ||
					submission.status === 'declined' ||
					submission.status === 'waitlisted';
				if (decided) expect(submission.statusNotifiedAt).not.toBeNull();
				if (submission.status === 'withdrawn') expect(submission.statusNotifiedAt).toBeNull();
			}
		}
	});

	test('an appeal exists only where a decline does', () => {
		for (const scenario of portalScenarios) {
			for (const submission of scenario.submissions) {
				if (submission.appeal.kind === 'unavailable') continue;
				expect(submission.status).toBe('declined');
			}
		}
	});

	test('the deadline decides lateness rather than the dataset', () => {
		const mixed = portalScenarios.find((scenario) => scenario.key === 'mixed');
		const snapshot = portalSnapshotDto(mixed!, now);
		const late = snapshot.submissions.find((submission) => submission.id === 'sub-402');
		const onTime = snapshot.submissions.find((submission) => submission.id === 'sub-401');
		expect(late?.late).toBe(true);
		expect(onTime?.late).toBe(false);
	});

	test('a passed deadline turns an open task late without the dataset saying so', () => {
		const accepted = portalScenarios.find((scenario) => scenario.key === 'accepted');
		expect(accepted?.tasks.every((task) => task.state !== 'todo' || task.dueAt !== null)).toBe(true);
		const snapshot = portalSnapshotDto(accepted!, now);
		expect(snapshot.tasks.find((task) => task.id === 'tsk-av')?.state).toBe('late');
		expect(snapshot.tasks.find((task) => task.id === 'tsk-travel')?.state).toBe('todo');
		expect(snapshot.tasks.find((task) => task.id === 'tsk-headshot')?.state).toBe(
			'received_pending_check'
		);
	});
});
