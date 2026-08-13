import type {
	EventCreateInput,
	OperationReceiptRef,
	ProgramVocabularyCreateDraftRequest,
	ProgramVocabularyDeleteDraftRequest,
	ProgramVocabularyEditDraftRequest,
	ProgramVocabularyMergeDraftRequest,
	ProgramVocabularyRestoreDraftRequest,
	ProgramVocabularyRetireDraftRequest,
	StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from '../client';
import type { CurrentEventView, EventView } from '../view-models/event';
import type {
	ProgramVocabularyDraftView,
	ProgramVocabularySnapshotView
} from '../view-models/program-vocabulary';
import type { OperatorHttpBindingUnavailableReason } from '../operations/operator-http-binding';

export type EventProgramSource =
	| { readonly kind: 'live' }
	| { readonly kind: 'sample'; readonly label: string; readonly resettable: true };

export type EventProgramDraftRequest =
	| { readonly action: 'create'; readonly input: ProgramVocabularyCreateDraftRequest }
	| { readonly action: 'edit'; readonly input: ProgramVocabularyEditDraftRequest }
	| { readonly action: 'retire'; readonly input: ProgramVocabularyRetireDraftRequest }
	| { readonly action: 'restore'; readonly input: ProgramVocabularyRestoreDraftRequest }
	| { readonly action: 'delete'; readonly input: ProgramVocabularyDeleteDraftRequest }
	| { readonly action: 'merge'; readonly input: ProgramVocabularyMergeDraftRequest };

export type EventProgramReadResult<T> =
	| { readonly kind: 'success'; readonly data: T; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export type EventProgramEffectResult<T> =
	| {
			readonly kind: 'success';
			readonly data: T;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
			readonly receipt?: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export interface EventProgramPort {
	readonly source: EventProgramSource;
	readonly event: {
		read(options?: { readonly signal?: AbortSignal }): Promise<EventProgramReadResult<CurrentEventView>>;
		create(
			input: EventCreateInput,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<{ readonly eventSetVersion: number; readonly event: EventView }>>;
	};
	readonly vocabulary: {
		read(
			options?: { readonly signal?: AbortSignal }
		): Promise<EventProgramReadResult<ProgramVocabularySnapshotView>>;
		draft(
			request: EventProgramDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDraftView>>;
	};
}

export interface ResettableEventProgramSample {
	readonly port: EventProgramPort & {
		readonly source: Extract<EventProgramSource, { kind: 'sample' }>;
	};
	reset(): void;
}
