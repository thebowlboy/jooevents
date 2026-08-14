import type {
	CommunicationThread,
	MutationOutcome,
	SpeakerCategory,
	SpeakerRow,
	TaskAssignment,
	TaskDef
} from './types';

/** Factual capabilities consumed by the tuned Speakers roster and lineup. */
export interface SpeakersPagePort {
	readonly speakers: {
		list(): Promise<SpeakerRow[]>;
		/**
		 * The two engagement response acts resolve an outcome rather than void:
		 * live they are consequential commits fenced on the engagement's version,
		 * so a stale row or lost authority is an ordinary refusal the page must
		 * show, never a silent no-op behind a resolved promise.
		 */
		recordConfirmation(id: string): Promise<MutationOutcome>;
		acceptCancellation(id: string): Promise<MutationOutcome>;
		reorder(id: string, toIndex: number): Promise<MutationOutcome>;
		setCategory(id: string, categoryId: string | null): Promise<MutationOutcome>;
		setVisibility(id: string, publiclyVisible: boolean): Promise<MutationOutcome>;
	};
	readonly tasks: {
		defs(): Promise<TaskDef[]>;
		assignments(): Promise<TaskAssignment[]>;
	};
	readonly communications: {
		thread(personId: string): Promise<CommunicationThread | null>;
	};
	readonly vocab: {
		speakerCategories(): Promise<SpeakerCategory[]>;
		addSpeakerCategory(name: string): Promise<SpeakerCategory>;
	};
}
