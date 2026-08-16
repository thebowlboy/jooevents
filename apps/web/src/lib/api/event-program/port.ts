import type {
	EventCreateInput,
	OperationReceiptRef,
	ProgramVocabularyCreateDraftRequest,
	ProgramVocabularyDeleteDraftRequest,
	ProgramVocabularyEditDraftRequest,
	ProgramVocabularyMergeDraftRequest,
	ProgramVocabularyMergePublishInput,
	ProgramVocabularyMergeReviewData,
	ProgramVocabularyRestoreDraftRequest,
	ProgramVocabularyRetireDraftRequest,
	ProgramVocabularyDirectData,
	StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from '../client';
import type { CurrentEventView, EventView } from '../view-models/event';
import type { ProgramVocabularySnapshotView } from '../view-models/program-vocabulary';
import type { OperatorHttpBindingUnavailableReason } from '../operations/operator-http-binding';

export type EventProgramSource =
	| { readonly kind: 'live' }
	| { readonly kind: 'sample'; readonly label: string; readonly resettable: true };

export type EventProgramDirectRequest =
	| { readonly action: 'create'; readonly input: ProgramVocabularyCreateDraftRequest }
	| { readonly action: 'edit'; readonly input: ProgramVocabularyEditDraftRequest }
	| { readonly action: 'retire'; readonly input: ProgramVocabularyRetireDraftRequest }
	| { readonly action: 'restore'; readonly input: ProgramVocabularyRestoreDraftRequest }
	| { readonly action: 'delete'; readonly input: ProgramVocabularyDeleteDraftRequest };

export type EventProgramMergeDraftRequest = Readonly<{
	action: 'merge';
	input: ProgramVocabularyMergeDraftRequest;
}>;

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
		create(
			input: ProgramVocabularyCreateDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
		edit(
			input: ProgramVocabularyEditDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
		retire(
			input: ProgramVocabularyRetireDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
		restore(
			input: ProgramVocabularyRestoreDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
		delete(
			input: ProgramVocabularyDeleteDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
		draftMerge(
			request: EventProgramMergeDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyMergeReviewData>>;
		publishMerge(
			input: ProgramVocabularyMergePublishInput,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<EventProgramEffectResult<ProgramVocabularyDirectData>>;
	};
}

export interface ResettableEventProgramSample {
	readonly port: EventProgramPort & {
		readonly source: Extract<EventProgramSource, { kind: 'sample' }>;
	};
	reset(): void;
}
