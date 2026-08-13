import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { createPortalApi } from './api';
import type { PortalDataset } from './dataset';
import submitted from './submitted';
import accepted from './accepted';
import declined from './declined';
import mixed from './mixed';

// The scenarios are a fiction anchored to real dates, so the clock is pinned:
// otherwise "before the call closes" would stop being true one day.
beforeAll(() => setSystemTime(new Date('2026-08-12T13:00:00Z')));
afterAll(() => setSystemTime());

function apiFor(dataset: PortalDataset) {
	return createPortalApi(structuredClone(dataset));
}

describe('sample participant portal api', () => {
	test('a read answers with the participant’s own world', async () => {
		const snapshot = await apiFor(submitted).snapshot();
		expect(snapshot.participant.displayName).toBe('Amara Okafor');
		expect(snapshot.submissions.map((submission) => submission.status)).toEqual([
			'submitted',
			'in_review'
		]);
		expect(snapshot.event.cfpOpen).toBe(true);
	});

	test('an edit while the call is open records the correction on the timeline', async () => {
		const api = apiFor(submitted);
		const outcome = await api.editAnswers({
			submissionId: 'sub-201',
			answers: [{ fieldId: 'fld-level', value: 'Advanced' }]
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.data.answers.find((answer) => answer.fieldId === 'fld-level')?.value).toBe(
			'Advanced'
		);
		expect(outcome.data.timeline.at(-1)?.kind).toBe('edited');
		expect(outcome.data.formVersion).toBe(3);
	});

	test('an edit to a decided submission is refused with the reason already on screen', async () => {
		const outcome = await apiFor(accepted).editAnswers({
			submissionId: 'sub-101',
			answers: [{ fieldId: 'fld-level', value: 'Beginner' }]
		});
		expect(outcome).toEqual({ ok: false, reason: 'submission_decided' });
	});

	test('withdrawal is available before a decision and refused after one', async () => {
		const api = apiFor(submitted);
		const first = await api.withdrawSubmission('sub-201');
		expect(first.ok && first.data.status).toBe('withdrawn');
		expect(await api.withdrawSubmission('sub-201')).toEqual({
			ok: false,
			reason: 'submission_withdrawn'
		});
		expect(await apiFor(accepted).withdrawSubmission('sub-101')).toEqual({
			ok: false,
			reason: 'submission_not_withdrawable'
		});
	});

	test('an appeal is one per submission and capped per person', async () => {
		const api = apiFor(declined);
		expect(await api.appealDecision({ submissionId: 'sub-302', reason: 'Again, please.' })).toEqual({
			ok: false,
			reason: 'appeal_already_used'
		});
		const first = await api.appealDecision({ submissionId: 'sub-301', reason: 'Please re-read it.' });
		expect(first.ok && first.data.appeal.kind).toBe('submitted');
		expect(await api.appealDecision({ submissionId: 'sub-303', reason: 'This one too.' })).toEqual({
			ok: false,
			reason: 'appeal_rate_limited'
		});
	});

	test('an appeal is refused where nothing was declined', async () => {
		expect(
			await apiFor(submitted).appealDecision({ submissionId: 'sub-201', reason: 'Why not?' })
		).toEqual({ ok: false, reason: 'appeal_unavailable' });
	});

	test('confirming an invitation attributes the answer and tells the timeline', async () => {
		const api = apiFor(accepted);
		const outcome = await api.respondToEngagement({ engagementId: 'eng-101', response: 'confirm' });
		expect(outcome.ok && outcome.data.confirmation?.by).toBe('you');
		expect(outcome.ok && outcome.data.awaitingYou).toBe(false);
		expect(await api.respondToEngagement({ engagementId: 'eng-101', response: 'decline' })).toEqual({
			ok: false,
			reason: 'engagement_not_open'
		});
		const submission = await api.submission('sub-101');
		expect(submission?.timeline.at(-1)?.kind).toBe('engagement_responded');
	});

	test('an answer given for a group says so', async () => {
		const api = apiFor(mixed);
		const engagement = (await api.snapshot()).engagements[0];
		expect(engagement?.sharedAuthority).toBe(true);
		expect(engagement?.confirmation).toEqual({
			by: 'co_speaker',
			at: '2026-07-29T08:12:00-04:00',
			displayName: 'Ana Duarte'
		});
	});

	test('an upload adds a version rather than replacing what was sent', async () => {
		const api = apiFor(accepted);
		const outcome = await api.completeTask({ taskId: 'tsk-slides', fileName: 'draft.pdf' });
		expect(outcome.ok).toBe(true);
		const snapshot = await api.snapshot();
		const uploaded = snapshot.files.filter((file) => file.taskId === 'tsk-slides');
		expect(uploaded.map((file) => file.version)).toEqual([1]);
		expect(snapshot.tasks.find((task) => task.id === 'tsk-slides')?.state).toBe('complete');
		const headshot = await apiFor(accepted).completeTask({ taskId: 'tsk-headshot' });
		expect(headshot).toEqual({ ok: false, reason: 'task_not_actionable' });
	});

	test('a late soft-closed task still accepts work', async () => {
		const outcome = await apiFor(accepted).completeTask({ taskId: 'tsk-av' });
		expect(outcome.ok).toBe(true);
	});

	test('a locked profile field refuses the write and offers the request instead', async () => {
		const api = apiFor(accepted);
		expect(await api.saveProfileField({ fieldId: 'prf-title', value: 'Something else' })).toEqual({
			ok: false,
			reason: 'field_locked'
		});
		const requested = await api.requestProfileChange({ fieldId: 'prf-title' });
		expect(requested.ok).toBe(true);
		if (!requested.ok) return;
		const field = requested.data.fields.find((candidate) => candidate.id === 'prf-title');
		expect(field?.access).toEqual({
			kind: 'locked',
			reason: 'locked_after_acceptance',
			changeRequested: true
		});
		expect(await api.requestProfileChange({ fieldId: 'prf-headline' })).toEqual({
			ok: false,
			reason: 'field_editable'
		});
	});

	test('an editable field saves', async () => {
		const api = apiFor(accepted);
		const outcome = await api.saveProfileField({ fieldId: 'prf-headline', value: 'Caching, mostly' });
		expect(outcome.ok && outcome.data.fields.find((field) => field.id === 'prf-headline')?.value).toBe(
			'Caching, mostly'
		);
	});

	test('an unknown record is named as one rather than failing silently', async () => {
		const api = apiFor(submitted);
		expect(await api.submission('sub-nope')).toBeNull();
		expect(await api.completeTask({ taskId: 'tsk-nope' })).toEqual({
			ok: false,
			reason: 'unknown_record'
		});
	});
});
