import { describe, expect, test } from 'bun:test';
import type { PortalEventDto, PortalSubmissionDto, PortalTaskDto } from '@jooevents/contracts';
import { mapPortalSnapshot, mapPortalSubmission, mapPortalTask, submissionEditability } from './mappers';
import { portalSnapshotDto } from './sample/projection';
import mixed from './sample/mixed';

const now = Date.parse('2026-08-12T09:00:00-04:00');

const openEvent: PortalEventDto = {
	id: 'evt-1',
	name: 'Test Event',
	timezone: 'America/New_York',
	cfpClosesAt: '2026-09-20T23:59:00-04:00',
	closePolicy: 'soft'
};

const closedEvent: PortalEventDto = { ...openEvent, cfpClosesAt: '2026-06-30T23:59:00-04:00' };

const submission: PortalSubmissionDto = {
	id: 'sub-1',
	title: 'A talk',
	formVersion: 2,
	answers: [{ fieldId: 'fld-abstract', label: 'Abstract', value: 'Something specific.' }],
	target: { kind: 'new_session' },
	status: 'submitted',
	statusNotifiedAt: null,
	submittedAt: '2026-07-01T09:00:00-04:00',
	editableUntilClose: true,
	late: false,
	speakers: [
		{ participantId: 'par-1', displayName: 'You' },
		{ participantId: 'par-2', displayName: 'Someone else' }
	],
	speakerAuthority: 'any_participant_acts',
	appeal: { kind: 'unavailable' },
	timeline: []
};

const context = { participantId: 'par-1', event: openEvent, now };

describe('participant portal projections', () => {
	test('"you" is resolved by participant relationship, not by address', () => {
		const view = mapPortalSubmission(submission, context);
		expect(view.speakers.map((speaker) => speaker.isYou)).toEqual([true, false]);
		expect(view.sharedAuthority).toBe(true);
		expect(view.authority).toBe('any_participant_acts');
	});

	test('an editable submission names its own deadline', () => {
		expect(submissionEditability(submission, context)).toEqual({
			kind: 'open',
			closesAt: openEvent.cfpClosesAt
		});
	});

	test('every lock states its reason before anyone attempts an edit', () => {
		expect(submissionEditability(submission, { ...context, event: closedEvent })).toEqual({
			kind: 'locked',
			reason: 'cfp_closed'
		});
		expect(submissionEditability({ ...submission, editableUntilClose: false }, context)).toEqual({
			kind: 'locked',
			reason: 'not_editable'
		});
		expect(submissionEditability({ ...submission, status: 'accepted' }, context)).toEqual({
			kind: 'locked',
			reason: 'decided'
		});
		expect(submissionEditability({ ...submission, status: 'withdrawn' }, context)).toEqual({
			kind: 'locked',
			reason: 'withdrawn'
		});
	});

	test('a soft-closed task says it still accepts work; a hard-closed one does not', () => {
		const task: PortalTaskDto = {
			id: 'tsk-1',
			title: 'Headshot',
			required: true,
			completion: { mode: 'upload', acceptedTypes: ['image/png'], receivedFileId: null },
			state: 'late',
			dueAt: '2026-08-01T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: null
		};
		expect(mapPortalTask(task).acceptsLateCompletion).toBe(true);
		expect(mapPortalTask({ ...task, closePolicy: 'hard' }).acceptsLateCompletion).toBe(false);
	});

	test('projections are frozen all the way down', () => {
		const view = mapPortalSnapshot(portalSnapshotDto(mixed, now), now);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.submissions)).toBe(true);
		expect(Object.isFrozen(view.submissions[0])).toBe(true);
		expect(Object.isFrozen(view.submissions[0]?.timeline)).toBe(true);
		expect(Object.isFrozen(view.engagements[0]?.confirmation)).toBe(true);
		expect(Object.isFrozen(view.profile.fields[0])).toBe(true);
	});

	test('the call state is computed from the deadline rather than carried', () => {
		expect(mapPortalSnapshot(portalSnapshotDto(mixed, now), now).event.cfpOpen).toBe(false);
		const early = Date.parse('2026-06-01T09:00:00-04:00');
		expect(mapPortalSnapshot(portalSnapshotDto(mixed, early), early).event.cfpOpen).toBe(true);
	});

	test('a confirmation keeps the name of whoever gave it', () => {
		const view = mapPortalSnapshot(portalSnapshotDto(mixed, now), now);
		expect(view.engagements[0]?.confirmation).toEqual({
			by: 'co_speaker',
			at: '2026-07-29T08:12:00-04:00',
			displayName: 'Ana Duarte'
		});
		expect(view.engagements[0]?.awaitingYou).toBe(false);
	});
});
