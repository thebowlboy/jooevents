import type { TaskBoardSnapshotDto } from '@jooevents/contracts';
import type { SpeakersPagePort } from './speakers-page-port';
import type { TemplatesPagePort } from './templates-page-port';
import type { CreateTaskDefinitionInput, TasksPagePort } from './tasks-page-port';
import type { CommittedTaskMutation, TaskLiveClient, TaskLiveResult } from './operations/tasks-live';
import type {
	AssignmentState,
	MessageTemplate,
	MutationOutcome,
	SpeakerProfile,
	SpeakerRow,
	TaskAssignment,
	TaskDef
} from './types';
import { taskAssignmentView, taskDefinitionView } from './mappers/tasks';

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
	readonly remind: (speakerIds: readonly string[], subject: string) => Promise<unknown>;
}): TasksPagePort {
	let boardRead: Promise<TaskBoardSnapshotDto> | null = null;
	const committedByCell = new Map<string, CommittedTaskMutation['source']>();
	const cell = (taskId: string, speakerId: string) => `${taskId}::${speakerId}`;

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
			const committed = await mutate({ action, assignmentId: current.id, expectedVersion: current.version });
			committedByCell.set(cell(taskId, speakerId), committed.source);
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
				const source = committedByCell.get(cell(taskId, speakerId));
				if (!source) throw new TasksPageLiveError({
					code: 'task_compensation_source_missing',
					reason: 'This task change can no longer be undone from this screen.'
				});
				const result = await input.tasks.compensate(source, actionKey());
				if (result.kind !== 'success') throw new TasksPageLiveError(failure(result));
				committedByCell.delete(cell(taskId, speakerId));
				boardRead = null;
			},
			remind: (speakerIds: string[], subject: string) => input.remind(speakerIds, subject)
		}),
		speakers: Object.freeze({
			list: () => input.speakers.speakers.list(),
			async profile(email: string): Promise<SpeakerProfile | null> {
				const speaker = (await input.speakers.speakers.list()).find((entry) => entry.email === email);
				return speaker ? {
					name: speaker.name,
					email: speaker.email,
					headline: '',
					submissionCount: 1,
					sessions: speaker.sessions,
					speakerId: speaker.id
				} : null;
			}
		}),
		templates: Object.freeze({
			async list(): Promise<{ readonly messages: MessageTemplate[] }> {
				return { messages: (await input.templates.templates.list()).messages };
			}
		})
	});
}
