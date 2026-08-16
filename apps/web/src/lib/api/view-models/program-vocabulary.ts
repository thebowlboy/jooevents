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
	readonly accent: 'lavender' | 'sea' | 'neutral';
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

export type ProgramVocabularyDiffItemView =
	| {
			readonly kind: 'room';
			readonly id: string;
			readonly name: string;
			readonly status: 'active' | 'retired';
			readonly version: number;
			readonly capacity: number | null;
	  }
	| {
			readonly kind: 'track';
			readonly id: string;
			readonly name: string;
			readonly accent: 'lavender' | 'sea' | 'neutral';
			readonly status: 'active' | 'retired';
			readonly version: number;
	  }
	| {
			readonly kind: 'format';
			readonly id: string;
			readonly name: string;
			readonly status: 'active' | 'retired';
			readonly version: number;
	  };

export type ProgramVocabularyChangeView =
	| { readonly action: 'create'; readonly before: null; readonly after: ProgramVocabularyDiffItemView }
	| { readonly action: 'edit' | 'retire' | 'restore'; readonly before: ProgramVocabularyDiffItemView; readonly after: ProgramVocabularyDiffItemView }
	| { readonly action: 'delete'; readonly before: ProgramVocabularyDiffItemView; readonly after: null; readonly usage: ProgramVocabularyUsageView }
	| { readonly action: 'merge'; readonly sourceBefore: ProgramVocabularyDiffItemView; readonly sourceAfter: ProgramVocabularyDiffItemView; readonly target: ProgramVocabularyDiffItemView; readonly liveRepoints: number; readonly historicalPinsPreserved: number };
