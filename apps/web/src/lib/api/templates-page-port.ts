import type {
	AnyTemplate,
	EditClassification,
	EventTheme,
	FormSummary,
	ModelChoice,
	MutationOutcome,
	PublicSpeakerCard,
	RegistryField,
	ReviseProgress,
	ScheduleState,
	SpeakerCategory,
	SurfaceTemplate,
	MessageTemplate,
	Track
} from './types';

/** Factual capabilities consumed by the tuned template, public-surface, and brand editor. */
export interface TemplatesPagePort {
	readonly templates: {
		list(): Promise<{ messages: MessageTemplate[]; surfaces: SurfaceTemplate[] }>;
		/**
		 * Mints a hand-made template from one of the offered kinds.
		 *
		 * Optional, and the surface renders on its absence rather than around it:
		 * a composition that cannot create says so in place of the control, so
		 * the door is never a promise the lane cannot keep.
		 */
		create?(input: { name: string; kind: string }): Promise<MessageTemplate>;
		modelChoices(): Promise<ModelChoice[]>;
		classify(id: string, instruction: string, modelId?: string): Promise<EditClassification>;
		revise(
			id: string,
			instruction: string,
			onProgress?: (progress: ReviseProgress) => void,
			modelId?: string
		): Promise<{ draft: AnyTemplate; note: string }>;
		applyRevision(id: string, draft: AnyTemplate): Promise<MutationOutcome>;
		commitInline(id: string, next: AnyTemplate, note: string): Promise<MutationOutcome>;
		revertTo(id: string, revisionNumber: number): Promise<MutationOutcome>;
	};
	readonly theme: {
		get(): Promise<EventTheme>;
		set(theme: EventTheme): Promise<void>;
	};
	/** Explicit public-release capability; absent in non-live/reference compositions. */
	readonly publication?: {
		status(templateId: string): Promise<{
			readonly state: 'never_published' | 'published' | 'changes_pending';
			readonly publishedRevisionNumber: number | null;
		}>;
		publish(templateId: string, formId?: string): Promise<MutationOutcome>;
	};
	readonly workspace: {
		summary(): Promise<{
			readonly event: null | {
				readonly name: string;
				readonly dates: string;
				readonly location: string;
			};
		}>;
	};
	readonly schedule: {
		state(): Promise<ScheduleState>;
	};
	readonly vocab: {
		tracks(): Promise<Track[]>;
		speakerCategories(): Promise<SpeakerCategory[]>;
	};
	readonly speakers: {
		publicRoster(): Promise<PublicSpeakerCard[]>;
	};
	readonly forms: {
		list(): Promise<FormSummary[]>;
	};
	readonly fields: {
		list(): Promise<RegistryField[]>;
		update(id: string, patch: Partial<RegistryField>): Promise<MutationOutcome>;
		remove(id: string): Promise<MutationOutcome>;
	};
}
