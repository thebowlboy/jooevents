export interface ProgramVocabularyScopeView {
	readonly workspaceId: string;
	readonly eventId: string;
}

export interface ProgramVocabularyUsageView {
	readonly currentReferences: number;
	readonly historicalPins: number;
}

export type ProgramVocabularyDeleteAvailabilityView =
	| { readonly kind: 'available' }
	| {
			readonly kind: 'unavailable';
			readonly currentReferences: number;
			readonly historicalPins: number;
	  };

interface ProgramVocabularyItemView {
	readonly id: string;
	readonly name: string;
	readonly status: 'active' | 'retired';
	readonly version: number;
	readonly usage: ProgramVocabularyUsageView;
	readonly deleteAvailability: ProgramVocabularyDeleteAvailabilityView;
}

export interface ProgramRoomView extends ProgramVocabularyItemView {
	readonly kind: 'room';
	readonly capacity: number | null;
}

export interface ProgramTrackView extends ProgramVocabularyItemView {
	readonly kind: 'track';
}

export interface ProgramFormatView extends ProgramVocabularyItemView {
	readonly kind: 'format';
}

export interface ProgramVocabularySnapshotView {
	readonly schemaVersion: 1;
	readonly scope: ProgramVocabularyScopeView;
	readonly setVersion: number;
	readonly rooms: readonly ProgramRoomView[];
	readonly tracks: readonly ProgramTrackView[];
	readonly formats: readonly ProgramFormatView[];
}
