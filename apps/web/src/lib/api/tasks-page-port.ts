import type {
	AssignmentState,
	EventTheme,
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

/**
 * What one lane's reminder will contain: either a stored template the sender
 * renders, or the fixed words it mails instead.
 */
export type ReminderPreview =
	| { readonly kind: 'template'; readonly template: MessageTemplate }
	| { readonly kind: 'plain'; readonly subject: string; readonly body: string };

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
		/**
		 * What a reminder actually sends, so the ceremony can show it before
		 * anyone presses send.
		 *
		 * Two answers, because two lanes genuinely differ: one renders a stored
		 * template, the other mails a fixed plain body of its own. A composition
		 * that mails fixed copy must say so rather than name a template it never
		 * reads — the shape makes claiming the wrong one impossible.
		 *
		 * Optional: a composition that cannot answer shows no body, which is a
		 * visible gap rather than a false promise.
		 */
		reminderPreview?(): Promise<ReminderPreview>;
	};
	readonly speakers: {
		list(): Promise<SpeakerRow[]>;
		profile(email: string): Promise<SpeakerProfile | null>;
	};
	readonly templates: {
		list(): Promise<{ readonly messages: MessageTemplate[] }>;
	};
	/**
	 * The event brand the rendered reminder is drawn in. Optional: a composition
	 * without one still shows the plain body, which is what its lane sends.
	 */
	readonly theme?: {
		get(): Promise<EventTheme>;
	};
}
