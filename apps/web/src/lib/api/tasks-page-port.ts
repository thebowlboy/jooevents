import type {
	AssignmentState,
	MessageTemplate,
	MutationOutcome,
	SpeakerProfile,
	SpeakerRow,
	TaskAssignment,
	TaskDef
} from './types';

/** Factual capabilities consumed by the tuned speaker-task matrix. */
export interface TasksPagePort {
	readonly tasks: {
		defs(): Promise<TaskDef[]>;
		assignments(): Promise<TaskAssignment[]>;
		markWaived(taskId: string, speakerId: string): Promise<void>;
		restoreAssignment(
			taskId: string,
			speakerId: string,
			state: AssignmentState,
			overdue: boolean
		): Promise<void>;
		acceptFulfillment(taskId: string, speakerId: string): Promise<MutationOutcome>;
		remind(speakerIds: string[], subject: string): Promise<unknown>;
	};
	readonly speakers: {
		list(): Promise<SpeakerRow[]>;
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly templates: {
		list(): Promise<{ readonly messages: MessageTemplate[] }>;
	};
}
