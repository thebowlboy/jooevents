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
		recordConfirmation(id: string): Promise<void>;
		acceptCancellation(id: string): Promise<void>;
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
