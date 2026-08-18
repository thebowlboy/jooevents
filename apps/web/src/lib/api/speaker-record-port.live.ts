import {
	DECISION_DECIDE_ROWS_MAX,
	formatInstant,
	type DecisionStateSnapshotDto,
	type EngagementHeadDto,
	type TaskAssignmentDto,
	type TaskBoardSnapshotDto
} from '@jooevents/contracts';
import type { DecisionsLiveClient } from './operations/decisions-live';
import type { EngagementsLiveClient } from './operations/engagements-live';
import type { TaskLiveClient } from './operations/tasks-live';
import type { FilesPagePort } from './files/files-page-port';
import type { MaterialFileView } from './files/view-models';
import type {
	OrganizerSubmissionAnswerView,
	OrganizerSubmissionsPort,
	LiveOrganizerSubmissionsPort
} from './view-models/intake-submissions';
import type { SchedulePagePort } from './schedule-page-port';
import type { SpeakersPagePort } from './speakers-page-port';
import type { TasksPagePort } from './tasks-page-port';
import { sessionPlacementDisplay } from './session-placement';
import { speakerRecordHref } from './speaker-record';
import type {
	SpeakerDeliverable,
	SpeakerRecordPort,
	SpeakerRecordProvenance,
	SpeakerRecordSnapshot,
	SpeakerRecordSubmission,
	SubmittedAnswer,
	TaskSubmission
} from './speaker-record-port';
import type { DecisionState } from './types';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';

type Failure = Readonly<{ code: string; reason: string }>;

export class SpeakerRecordLiveError extends Error {
	readonly code: string;

	constructor(failure: Failure) {
		super(failure.reason);
		this.name = 'SpeakerRecordLiveError';
		this.code = failure.code;
	}
}

function unavailable(code: string, subject: string): never {
	throw new SpeakerRecordLiveError({
		code,
		reason: `The ${subject} could not be loaded for this speaker record.`
	});
}

function displayInstant(instant: string): string {
	return formatInstant(instant, 'UTC', { zone: true, fallback: 'Not recorded' });
}

function answerValue(answer: OrganizerSubmissionAnswerView): string {
	switch (answer.type) {
		case 'text':
		case 'textarea':
		case 'url':
		case 'phone':
		case 'date':
		case 'datetime':
			return answer.value;
		case 'number':
			return String(answer.value);
		case 'select':
			return answer.choice.label;
		case 'multiselect':
			return answer.choices.map((choice) => choice.label).join(', ');
		case 'checkbox':
			return answer.checked ? 'Yes' : 'No';
	}
}

function fileKindLabel(contentType: MaterialFileView['contentType']): string {
	const labels: Readonly<Record<MaterialFileView['contentType'], string>> = Object.freeze({
		'application/pdf': 'PDF document',
		'image/png': 'PNG image',
		'image/jpeg': 'JPEG image',
		'image/webp': 'WebP image',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
		'application/vnd.apple.keynote': 'Keynote presentation',
		'application/zip': 'ZIP archive'
	});
	return labels[contentType];
}

function chunks<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
	const result: Value[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

function provenance(head: EngagementHeadDto, title: string | undefined): SpeakerRecordProvenance {
	if (head.source.kind === 'submission' && head.submissionId !== null) {
		return { kind: 'submission', submissionId: head.submissionId, title: title ?? 'Untitled submission' };
	}
	if (head.source.kind === 'direct_entry') return { kind: 'direct_entry' };
	if (head.source.kind === 'import') return { kind: 'import' };
	return { kind: 'editorial' };
}

async function formSubmission(
	assignment: TaskAssignmentDto,
	intake: Pick<OrganizerSubmissionsPort, 'readDetail'>
): Promise<TaskSubmission | null> {
	const evidence = assignment.completionEvidence;
	if (evidence?.kind !== 'form') return null;
	const result = await intake.readDetail(evidence.submissionId);
	if (result.kind !== 'success') return null;
	const answers: SubmittedAnswer[] = result.data.answers.map((answer) => ({
		fieldId: answer.fieldId,
		label: answer.fieldLabel,
		value: answerValue(answer)
	}));
	return {
		kind: 'form',
		submittedAt: result.data.submittedAtLabel,
		answers
	};
}

function fileSubmission(
	assignment: TaskAssignmentDto,
	files: readonly MaterialFileView[],
	downloadPath: FilesPagePort['downloadPath']
): TaskSubmission | null {
	const evidence = assignment.completionEvidence;
	if (evidence?.kind !== 'file') return null;
	const file = files.find((item) =>
		item.assetId === evidence.mediaAssetId
		&& item.assetVersion === evidence.mediaAssetVersion
	);
	if (!file || !file.downloadable) return null;
	const href = downloadPath(file.assetId);
	if (href === null) return null;
	return {
		kind: 'upload',
		submittedAt: displayInstant(file.attachedAt),
		files: [{
			id: file.assetId,
			name: file.name,
			kindLabel: fileKindLabel(file.contentType),
			sizeLabel: file.sizeLabel,
			href
		}]
	};
}

async function taskSubmission(
	assignment: TaskAssignmentDto,
	input: {
		readonly intake: Pick<OrganizerSubmissionsPort, 'readDetail'>;
		readonly files: readonly MaterialFileView[];
		readonly downloadPath: FilesPagePort['downloadPath'];
	}
): Promise<TaskSubmission | null> {
	const evidence = assignment.completionEvidence;
	if (evidence === null) return null;
	if (evidence.kind === 'form') return formSubmission(assignment, input.intake);
	if (evidence.kind === 'file') return fileSubmission(assignment, input.files, input.downloadPath);
	if (evidence.kind === 'acknowledged') {
		return {
			kind: 'confirm',
			submittedAt: displayInstant(evidence.acknowledgedAt),
			statement: 'Acknowledged.'
		};
	}
	// `external` carries a note but no evidence time or URL. Rendering it as a
	// sent link would invent both; the record therefore keeps the content read
	// unavailable and the no-accept-above-unviewable rule disables acceptance.
	return null;
}

/**
 * Live Speaker Record assembled from the same canonical reads as Speakers,
 * Schedule, Tasks, Files, Decisions, and Communications. No source is replaced
 * by sample state, and no display-name/email join is used as person identity.
 */
export function createLiveSpeakerRecordPort(input: {
	readonly speakers: SpeakersPagePort;
	readonly engagements: Pick<EngagementsLiveClient, 'readSnapshot'>;
	readonly tasks: Pick<TaskLiveClient, 'readBoard'>;
	readonly taskActions: TasksPagePort;
	readonly schedule: Pick<SchedulePagePort, 'schedule'>;
	readonly decisions: Pick<DecisionsLiveClient, 'readState'>;
	readonly intake: Pick<LiveOrganizerSubmissionsPort, 'readDetail' | 'listForPerson'>;
	readonly files: Pick<FilesPagePort, 'read' | 'downloadPath'>;
}): SpeakerRecordPort {
	async function board(): Promise<TaskBoardSnapshotDto> {
		const result = await input.tasks.readBoard();
		if (result.kind !== 'success') unavailable('speaker_record_task_board_unavailable', 'task board');
		return result.data;
	}

	async function read(engagementId: string): Promise<SpeakerRecordSnapshot | null> {
		const [rows, engagementResult, schedule, taskBoard] = await Promise.all([
			input.speakers.speakers.list(),
			input.engagements.readSnapshot(),
			input.schedule.schedule.state(),
			board()
		]);
		if (engagementResult.kind !== 'success') {
			return unavailable('speaker_record_engagements_unavailable', 'engagement');
		}
		const head = engagementResult.data.engagements.find((entry) => entry.id === engagementId);
		if (!head) return null;
		const engagement = rows.find((entry) => entry.id === engagementId);
		if (!engagement || engagement.personId !== head.personId || !engagement.name.trim() || !engagement.email.trim()) {
			return unavailable('speaker_record_identity_unavailable', 'speaker identity');
		}

		const personSubmissions = await input.intake.listForPerson(head.personId);
		if (personSubmissions.kind !== 'success') {
			unavailable('speaker_record_submission_unavailable', 'speaker proposals');
		}
		const submissionRows = personSubmissions.data;
		const submissionIds = submissionRows.map((row) => row.id);
		const decisionRows = new Map<string, DecisionStateSnapshotDto['rows'][number]>();
		for (const batch of chunks(submissionIds, DECISION_DECIDE_ROWS_MAX)) {
			if (batch.length === 0) continue;
			const result = await input.decisions.readState(batch);
			if (result.kind !== 'success') unavailable('speaker_record_decisions_unavailable', 'proposal decisions');
			if (result.data.rows.length !== batch.length) unavailable('speaker_record_decisions_incomplete', 'proposal decisions');
			for (const row of result.data.rows) decisionRows.set(row.submissionId, row);
		}

		const proposalRows: SpeakerRecordSubmission[] = submissionRows.map((row) => {
			const decision = decisionRows.get(row.id);
			if (!decision) unavailable('speaker_record_decisions_incomplete', 'proposal decisions');
			if (decision.head !== null && decision.notificationAcceptedAt === undefined) {
				unavailable('speaker_record_notification_evidence_unavailable', 'proposal notification evidence');
			}
			return {
				id: row.id,
				title: row.title || 'Untitled submission',
				decision: (decision.head?.state ?? 'undecided') as DecisionState,
				notified: decision.notificationAcceptedAt != null,
				href: `/app/submissions?submission=${row.id}`,
				decisionHref: `/app/decisions?submission=${row.id}`
			};
		});

		let fileRows: MaterialFileView[] = [];
		if (taskBoard.assignments.some((assignment) =>
			assignment.engagementId === engagementId && assignment.completionEvidence?.kind === 'file'
		)) {
			try {
				const overview = await input.files.read();
				fileRows = overview.received
					.filter((group) => group.engagementId === engagementId)
					.flatMap((group) => group.items.filter((item): item is MaterialFileView => item.kind === 'file'));
			} catch {
				// The record remains useful; the affected deliverable carries the
				// existing typed no-content refusal and cannot be accepted blindly.
				fileRows = [];
			}
		}
		const definitions = new Map(taskBoard.definitions.map((entry) => [entry.head.id, entry]));
		const assignments = taskBoard.assignments.filter((entry) => entry.engagementId === engagementId);
		const deliverables: SpeakerDeliverable[] = await Promise.all(assignments.map(async (assignment) => {
			const definition = definitions.get(assignment.taskDefinitionId);
			if (!definition) unavailable('speaker_record_task_definition_missing', 'task definition');
			return {
				def: taskDefinitionView(definition),
				assignment: taskAssignmentView(assignment),
				submission: await taskSubmission(assignment, {
					intake: input.intake,
					files: fileRows,
					downloadPath: input.files.downloadPath
				})
			};
		}));

		const linkedTitle = head.submissionId === null
			? undefined
			: submissionRows.find((row) => row.id === head.submissionId)?.title ?? undefined;
		return {
			engagement,
			sessions: engagement.sessions.map((session) => {
				const placement = sessionPlacementDisplay(schedule, session.id);
				return {
					id: session.id,
					title: session.title,
					...(placement ? { placement } : {}),
					href: `/app/schedule?session=${session.id}`
				};
			}),
			publication: {
				onLineup: engagement.publiclyVisible,
				provisional: engagement.publiclyVisible && !engagement.contentApproved
			},
			provenance: provenance(head, linkedTitle),
			otherEngagements: rows
				.filter((row) => row.id !== engagementId && row.personId === head.personId)
				.map((row) => ({
					id: row.id,
					state: row.state,
					sessionTitles: row.sessions.map((session) => session.title),
					href: speakerRecordHref(row.id)
				})),
			deliverables,
			thread: await input.speakers.communications.thread(head.personId),
			submissions: proposalRows,
			submissionCoverage: 'complete',
			publicCard: engagement.publiclyVisible
				? { links: [], provisional: !engagement.contentApproved }
				: null,
			profile: null,
			// The event operation log does not yet key every task/engagement row
			// to this person. Filtering summaries or display names would invent
			// attribution, so the page renders its existing typed absence.
			history: []
		};
	}

	return Object.freeze({
		record: Object.freeze({ read }),
		engagement: Object.freeze({
			recordConfirmation: (engagementId: string) =>
				input.speakers.speakers.recordConfirmation(engagementId)
		}),
		deliverables: Object.freeze({
			accept: (taskId: string, speakerId: string) =>
				input.taskActions.tasks.acceptFulfillment(taskId, speakerId),
			waive: (taskId: string, speakerId: string) =>
				input.taskActions.tasks.markWaived(taskId, speakerId),
			restore: (taskId: string, speakerId: string, state, overdue) =>
				input.taskActions.tasks.restoreAssignment(taskId, speakerId, state, overdue)
		})
	} satisfies SpeakerRecordPort);
}
