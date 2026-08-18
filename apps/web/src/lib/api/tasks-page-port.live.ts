import type { TaskBoardSnapshotDto } from '@jooevents/contracts';
import type { SpeakersPagePort } from './speakers-page-port';
import type { TemplatesPagePort } from './templates-page-port';
import type { SpeakerProfileBatchSource } from './speaker-profile-directory.live';
import type { CreateTaskDefinitionInput, ReminderPreview, TasksPagePort } from './tasks-page-port';
import { TASK_REMINDER_BODY } from './task-reminder-copy';
import type { CommittedTaskMutation, TaskLiveClient, TaskLiveResult } from './operations/tasks-live';
import type {
	AssignmentState,
	MessageTemplate,
	MutationOutcome,
	SpeakerProfile,
	SpeakerRow,
	ScheduleState,
	TaskAssignment,
	TaskDef
} from './types';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';
import { sessionPlacementDisplay } from './session-placement';
import type { SpeakerProfileBatchSource } from './speaker-profile-directory.live';

type Failure = Readonly<{ code: string; reason: string }>;
export class TasksPageLiveError extends Error {
	readonly code: string;
	constructor(failure: Failure) {
		super(failure.reason);
		this.name = 'TasksPageLiveError';
		this.code = failure.code;
	}
}

function failure(result: Exclude<TaskLiveResult<unknown>, { readonly kind: 'success' }>): Failure {
	if (result.kind === 'unavailable') return {
		code: result.reason,
		reason: 'Speaker tasks are not available in this live workspace.'
	};
	if (result.kind === 'transport_error') return {
		code: result.error.code,
		reason: result.error.retryable
			? 'The task board could not be reached. Try again.'
			: 'This task request is not valid.'
	};
	if (result.outcome.class === 'access_denied') return {
		code: result.outcome.kind,
		reason: 'You no longer have permission to change speaker tasks.'
	};
	if (result.outcome.class === 'stale_revision' || result.outcome.class === 'conflict') return {
		code: result.outcome.kind,
		reason: 'The task board changed while you were working. Reload and try again.'
	};
	return { code: result.outcome.kind, reason: 'This task change could not be applied.' };
}

const actionKey = () => `je.tasks.page.${globalThis.crypto.randomUUID()}`;

/** Canonical Task board projected into the already-tuned task matrix. */
export function createLiveTasksPagePort(input: {
	readonly tasks: TaskLiveClient;
	readonly speakers: SpeakersPagePort;
	readonly templates: TemplatesPagePort;
	readonly schedule: { state(): Promise<ScheduleState> };
	readonly remind: (speakerIds: readonly string[], subject: string) => Promise<unknown>;
	readonly profileBatch?: SpeakerProfileBatchSource;
}): TasksPagePort {
	let boardRead: Promise<TaskBoardSnapshotDto> | null = null;

	async function board(force = false): Promise<TaskBoardSnapshotDto> {
		if (force) boardRead = null;
		boardRead ??= input.tasks.readBoard().then((result) => {
			if (result.kind === 'success') return result.data;
			boardRead = null;
			throw new TasksPageLiveError(failure(result));
		});
		return boardRead;
	}

	async function mutate(raw: Parameters<TaskLiveClient['mutate']>[0]): Promise<CommittedTaskMutation> {
		const result = await input.tasks.mutate(raw, actionKey());
		if (result.kind !== 'success') throw new TasksPageLiveError(failure(result));
		boardRead = null;
		return result.data;
	}

	async function transition(
		taskId: string,
		speakerId: string,
		action: 'waive_assignment' | 'accept_fulfillment'
	): Promise<MutationOutcome> {
		const current = (await board(true)).assignments.find((entry) =>
			entry.taskDefinitionId === taskId && entry.engagementId === speakerId
		);
		if (!current) return { ok: false, reason: 'This task is no longer assigned to this speaker.' };
		try {
			await mutate({ action, assignmentId: current.id, expectedVersion: current.version });
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : 'This task change could not be applied.'
			};
		}
	}

	return Object.freeze({
		tasks: Object.freeze({
			async createDefinition(value: CreateTaskDefinitionInput): Promise<MutationOutcome> {
				try {
					await mutate({ action: 'create_definition', ...value });
					return { ok: true };
				} catch (error) {
					return { ok: false, reason: error instanceof Error ? error.message : 'The task could not be created.' };
				}
			},
			async defs(): Promise<TaskDef[]> {
				return (await board()).definitions.map((entry) => taskDefinitionView(entry));
			},
			async assignments(): Promise<TaskAssignment[]> {
				return (await board()).assignments.map((entry) => taskAssignmentView(entry));
			},
			async markWaived(taskId: string, speakerId: string): Promise<void> {
				const result = await transition(taskId, speakerId, 'waive_assignment');
				if (!result.ok) throw new TasksPageLiveError({ code: 'task_waive_refused', reason: result.reason });
			},
			async acceptFulfillment(taskId: string, speakerId: string): Promise<MutationOutcome> {
				return transition(taskId, speakerId, 'accept_fulfillment');
			},
			async restoreAssignment(
				taskId: string,
				speakerId: string,
				_state: AssignmentState,
				_overdue: boolean
			): Promise<void> {
				const current = (await board(true)).assignments.find((entry) =>
					entry.taskDefinitionId === taskId && entry.engagementId === speakerId
				);
				if (!current) throw new TasksPageLiveError({
					code: 'task_restore_source_missing',
					reason: 'This task change can no longer be undone from this screen.'
				});
				await mutate({ action: 'restore_assignment', assignmentId: current.id, expectedVersion: current.version });
			},
			remind: (speakerIds: string[], subject: string) => input.remind(speakerIds, subject),
			/**
			 * This lane mails a fixed plain body rather than rendering a stored
			 * template, so the ceremony is told exactly that and shows the words
			 * themselves. Both this and the sender read one owner, which is what
			 * keeps the dialog from promising copy the mail does not carry.
			 *
			 * The subject is the operator's and is supplied by the dialog; what is
			 * fixed — and therefore worth showing — is the body.
			 */
			async reminderPreview(): Promise<ReminderPreview> {
				return { kind: 'plain', subject: '', body: TASK_REMINDER_BODY };
			}
		}),
		speakers: Object.freeze({
			list: () => input.speakers.speakers.list(),
			async profile(email: string): Promise<SpeakerProfile | null> {
				const [roster, schedule] = await Promise.all([
					input.speakers.speakers.list(),
					input.schedule.state()
				]);
				const speaker = roster.find((entry) => entry.email === email);
				return speaker ? {
					name: speaker.name,
					email: speaker.email,
					headline: '',
					submissionCount: 1,
					sessions: speaker.sessions.map((session) => {
						const placement = sessionPlacementDisplay(schedule, session.id);
						return { ...session, ...(placement ? { placement } : {}) };
					}),
					speakerId: speaker.id
				} : null;
			},
			...(input.profileBatch ? { profiles: input.profileBatch.profiles } : {})
		}),
		templates: Object.freeze({
			async list(): Promise<{ readonly messages: MessageTemplate[] }> {
				return { messages: (await input.templates.templates.list()).messages };
			}
		})
	});
}
