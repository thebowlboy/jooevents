import type {
	PortalAnswerDto,
	PortalAppealDto,
	PortalEngagementConfirmationDto,
	PortalEngagementDto,
	PortalEventDto,
	PortalFileDto,
	PortalParticipantDto,
	PortalProfileDto,
	PortalProfileFieldAccessDto,
	PortalProfileFieldDto,
	PortalResourceDto,
	PortalSnapshotDto,
	PortalSpeakerDto,
	PortalSubmissionDto,
	PortalSubmissionTargetDto,
	PortalTaskCompletionDto,
	PortalTaskDto,
	PortalTimelineEventDto
} from '@jooevents/contracts';
import type {
	PortalAnswerView,
	PortalAppealView,
	PortalEditabilityView,
	PortalEngagementConfirmationView,
	PortalEngagementView,
	PortalEventView,
	PortalFileView,
	PortalParticipantView,
	PortalProfileFieldAccessView,
	PortalProfileFieldView,
	PortalProfileView,
	PortalResourceView,
	PortalSnapshotView,
	PortalSpeakerView,
	PortalSubmissionTargetView,
	PortalSubmissionView,
	PortalTaskCompletionView,
	PortalTaskView,
	PortalTimelineEventView
} from './view-models';

/**
 * What a projection needs beyond the record itself: whose portal this is (so
 * "you" is resolved by participant relationship rather than by matching an
 * email address) and the instant the surface is being rendered at.
 */
export interface PortalProjectionContext {
	readonly participantId: string;
	readonly event: PortalEventDto;
	readonly now: number;
}

type HandledSnapshotKey =
	| 'schemaVersion'
	| 'participant'
	| 'event'
	| 'submissions'
	| 'engagements'
	| 'tasks'
	| 'files'
	| 'resources'
	| 'profile';
const handledSnapshotKeys: Record<Exclude<keyof PortalSnapshotDto, HandledSnapshotKey>, never> = {};
void handledSnapshotKeys;

type HandledSubmissionKey =
	| 'id'
	| 'title'
	| 'formVersion'
	| 'answers'
	| 'target'
	| 'status'
	| 'statusNotifiedAt'
	| 'submittedAt'
	| 'editableUntilClose'
	| 'late'
	| 'speakers'
	| 'speakerAuthority'
	| 'appeal'
	| 'timeline';
const handledSubmissionKeys: Record<
	Exclude<keyof PortalSubmissionDto, HandledSubmissionKey>,
	never
> = {};
void handledSubmissionKeys;

type HandledEngagementKey =
	| 'id'
	| 'sessionId'
	| 'sessionTitle'
	| 'submissionId'
	| 'status'
	| 'invitedAt'
	| 'respondBy'
	| 'confirmation'
	| 'speakers';
const handledEngagementKeys: Record<
	Exclude<keyof PortalEngagementDto, HandledEngagementKey>,
	never
> = {};
void handledEngagementKeys;

type HandledTaskKey =
	| 'id'
	| 'title'
	| 'required'
	| 'completion'
	| 'state'
	| 'dueAt'
	| 'timezone'
	| 'closePolicy'
	| 'sessionId';
const handledTaskKeys: Record<Exclude<keyof PortalTaskDto, HandledTaskKey>, never> = {};
void handledTaskKeys;

function unreachable(value: never): never {
	throw new TypeError(`Unsupported participant portal contract variant: ${JSON.stringify(value)}`);
}

export function mapPortalParticipant(participant: PortalParticipantDto): PortalParticipantView {
	return Object.freeze({
		id: participant.id,
		displayName: participant.displayName,
		email: participant.email
	});
}

export function mapPortalEvent(event: PortalEventDto, now: number): PortalEventView {
	return Object.freeze({
		id: event.id,
		name: event.name,
		timezone: event.timezone,
		cfpClosesAt: event.cfpClosesAt,
		closePolicy: event.closePolicy,
		cfpOpen: now < Date.parse(event.cfpClosesAt)
	});
}

function mapAnswer(answer: PortalAnswerDto): PortalAnswerView {
	return Object.freeze({ fieldId: answer.fieldId, label: answer.label, value: answer.value });
}

function mapTarget(target: PortalSubmissionTargetDto): PortalSubmissionTargetView {
	switch (target.kind) {
		case 'new_session':
			return Object.freeze({ kind: 'new_session' });
		case 'collecting_session':
			return Object.freeze({
				kind: 'collecting_session',
				sessionId: target.sessionId,
				name: target.name
			});
		default:
			return unreachable(target);
	}
}

function mapSpeaker(speaker: PortalSpeakerDto, participantId: string): PortalSpeakerView {
	return Object.freeze({
		participantId: speaker.participantId,
		displayName: speaker.displayName,
		isYou: speaker.participantId === participantId
	});
}

function mapAppeal(appeal: PortalAppealDto): PortalAppealView {
	switch (appeal.kind) {
		case 'unavailable':
			return Object.freeze({ kind: 'unavailable' });
		case 'available':
			return Object.freeze({ kind: 'available' });
		case 'submitted':
			return Object.freeze({
				kind: 'submitted',
				submittedAt: appeal.submittedAt,
				reason: appeal.reason
			});
		default:
			return unreachable(appeal);
	}
}

function mapTimelineEvent(event: PortalTimelineEventDto): PortalTimelineEventView {
	return Object.freeze({
		id: event.id,
		occurredAt: event.occurredAt,
		actor: event.actor,
		kind: event.kind,
		summary: event.summary
	});
}

/**
 * Whether the submitted record can still be corrected. One function answers
 * this for the projection and for the refusal an attempted edit receives, so a
 * surface can never offer an edit the operation would decline.
 */
export function submissionEditability(
	submission: PortalSubmissionDto,
	context: PortalProjectionContext
): PortalEditabilityView {
	if (submission.status === 'withdrawn') return Object.freeze({ kind: 'locked', reason: 'withdrawn' });
	if (submission.status !== 'submitted' && submission.status !== 'in_review') {
		return Object.freeze({ kind: 'locked', reason: 'decided' });
	}
	if (!submission.editableUntilClose) return Object.freeze({ kind: 'locked', reason: 'not_editable' });
	if (context.now >= Date.parse(context.event.cfpClosesAt)) {
		return Object.freeze({ kind: 'locked', reason: 'cfp_closed' });
	}
	return Object.freeze({ kind: 'open', closesAt: context.event.cfpClosesAt });
}

export function mapPortalSubmission(
	submission: PortalSubmissionDto,
	context: PortalProjectionContext
): PortalSubmissionView {
	return Object.freeze({
		id: submission.id,
		title: submission.title,
		formVersion: submission.formVersion,
		answers: Object.freeze(submission.answers.map(mapAnswer)),
		target: mapTarget(submission.target),
		status: submission.status,
		statusNotifiedAt: submission.statusNotifiedAt,
		submittedAt: submission.submittedAt,
		late: submission.late,
		editability: submissionEditability(submission, context),
		speakers: Object.freeze(
			submission.speakers.map((speaker) => mapSpeaker(speaker, context.participantId))
		),
		authority: submission.speakerAuthority,
		sharedAuthority: submission.speakers.length > 1,
		appeal: mapAppeal(submission.appeal),
		timeline: Object.freeze(submission.timeline.map(mapTimelineEvent))
	});
}

function mapConfirmation(
	confirmation: PortalEngagementConfirmationDto
): PortalEngagementConfirmationView {
	switch (confirmation.by) {
		case 'you':
			return Object.freeze({ by: 'you', at: confirmation.at });
		case 'co_speaker':
			return Object.freeze({
				by: 'co_speaker',
				at: confirmation.at,
				displayName: confirmation.displayName
			});
		case 'organizer':
			return Object.freeze({
				by: 'organizer',
				at: confirmation.at,
				displayName: confirmation.displayName
			});
		default:
			return unreachable(confirmation);
	}
}

export function mapPortalEngagement(
	engagement: PortalEngagementDto,
	context: PortalProjectionContext
): PortalEngagementView {
	return Object.freeze({
		id: engagement.id,
		sessionId: engagement.sessionId,
		sessionTitle: engagement.sessionTitle,
		submissionId: engagement.submissionId,
		status: engagement.status,
		invitedAt: engagement.invitedAt,
		respondBy: engagement.respondBy,
		confirmation: engagement.confirmation ? mapConfirmation(engagement.confirmation) : null,
		speakers: Object.freeze(
			engagement.speakers.map((speaker) => mapSpeaker(speaker, context.participantId))
		),
		awaitingYou: engagement.status === 'invited',
		sharedAuthority: engagement.speakers.length > 1
	});
}

function mapCompletion(completion: PortalTaskCompletionDto): PortalTaskCompletionView {
	switch (completion.mode) {
		case 'acknowledge':
			return Object.freeze({ mode: 'acknowledge' });
		case 'upload':
			return Object.freeze({
				mode: 'upload',
				acceptedTypes: Object.freeze([...completion.acceptedTypes]),
				receivedFileId: completion.receivedFileId
			});
		case 'form_fill':
			return Object.freeze({ mode: 'form_fill', formId: completion.formId });
		case 'external':
			return Object.freeze({ mode: 'external', url: completion.url });
		default:
			return unreachable(completion);
	}
}

export function mapPortalTask(task: PortalTaskDto): PortalTaskView {
	return Object.freeze({
		id: task.id,
		title: task.title,
		required: task.required,
		completion: mapCompletion(task.completion),
		state: task.state,
		dueAt: task.dueAt,
		timezone: task.timezone,
		closePolicy: task.closePolicy,
		sessionId: task.sessionId,
		acceptsLateCompletion: task.closePolicy === 'soft'
	});
}

export function mapPortalFile(file: PortalFileDto): PortalFileView {
	return Object.freeze({
		id: file.id,
		name: file.name,
		sizeBytes: file.sizeBytes,
		version: file.version,
		uploadedAt: file.uploadedAt,
		taskId: file.taskId
	});
}

export function mapPortalResource(resource: PortalResourceDto): PortalResourceView {
	return Object.freeze({
		id: resource.id,
		title: resource.title,
		kind: resource.kind,
		url: resource.url,
		detail: resource.detail
	});
}

function mapFieldAccess(access: PortalProfileFieldAccessDto): PortalProfileFieldAccessView {
	switch (access.kind) {
		case 'editable':
			return Object.freeze({ kind: 'editable' });
		case 'locked':
			return Object.freeze({
				kind: 'locked',
				reason: access.reason,
				changeRequested: access.changeRequested
			});
		default:
			return unreachable(access);
	}
}

export function mapPortalProfileField(field: PortalProfileFieldDto): PortalProfileFieldView {
	return Object.freeze({
		id: field.id,
		label: field.label,
		value: field.value,
		kind: field.kind,
		access: mapFieldAccess(field.access)
	});
}

export function mapPortalProfile(profile: PortalProfileDto): PortalProfileView {
	return Object.freeze({ fields: Object.freeze(profile.fields.map(mapPortalProfileField)) });
}

export function mapPortalSnapshot(snapshot: PortalSnapshotDto, now: number): PortalSnapshotView {
	const context: PortalProjectionContext = {
		participantId: snapshot.participant.id,
		event: snapshot.event,
		now
	};
	return Object.freeze({
		schemaVersion: snapshot.schemaVersion,
		participant: mapPortalParticipant(snapshot.participant),
		event: mapPortalEvent(snapshot.event, now),
		submissions: Object.freeze(
			snapshot.submissions.map((submission) => mapPortalSubmission(submission, context))
		),
		engagements: Object.freeze(
			snapshot.engagements.map((engagement) => mapPortalEngagement(engagement, context))
		),
		tasks: Object.freeze(snapshot.tasks.map(mapPortalTask)),
		files: Object.freeze(snapshot.files.map(mapPortalFile)),
		resources: Object.freeze(snapshot.resources.map(mapPortalResource)),
		profile: mapPortalProfile(snapshot.profile)
	});
}
