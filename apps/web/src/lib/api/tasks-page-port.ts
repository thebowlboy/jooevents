import type {
	AssignmentState,
	MessageTemplate,
	MutationOutcome,
	SpeakerProfile,
	SpeakerRow,
	TaskAssignment,
	TaskDef
} from './types';

export interface CreateTaskDefinitionInput {
	readonly name: string;
	readonly description: string | null;
	readonly completionMode: 'acknowledge' | 'file_upload' | 'form' | 'external_action';
	readonly required: boolean;
	readonly dueOn: string;
}

/** Factual capabilities consumed by the tuned speaker-task matrix. */
export interface TasksPagePort {
	readonly tasks: {
		createDefinition(input: CreateTaskDefinitionInput): Promise<MutationOutcome>;
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
