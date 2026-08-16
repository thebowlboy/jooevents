import {
	operationHttpIdempotencyKeySchema,
	programVocabularyCreateDraftRequestSchema,
	programVocabularyDeleteDraftRequestSchema,
	programVocabularyEditDraftRequestSchema,
	programVocabularyMergeDraftRequestSchema,
	programVocabularyRestoreDraftRequestSchema,
	programVocabularyRetireDraftRequestSchema,
	programVocabularySafeDiffSchema,
	type OperationReceiptRef,
	type ProgramVocabularyDirectData,
	type ProgramVocabularyMergePublishInput,
	type ProgramVocabularyMergeReviewData,
	type ProgramVocabularySafeDiff,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from './client';
import type {
	EventProgramDirectRequest,
	EventProgramMergeDraftRequest,
	EventProgramPort,
	EventProgramSource
} from './event-program/port';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type { MutationOutcome } from './types';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView,
	ProgramVocabularyChangeView,
	ProgramVocabularySnapshotView,
	ProgramVocabularyUsageView
} from './view-models/program-vocabulary';

export {
	presentProgramRoomCapacity,
	presentProgramVocabularyUsage,
	type ProgramRoomCapacityPresentation,
	type ProgramVocabularyUsagePresentation
} from './program-vocabulary-presentation';

export type ProgramVocabularySettingsEntry =
	| ProgramRoomView
	| ProgramTrackView
	| ProgramFormatView;
export type ProgramVocabularySettingsKind = ProgramVocabularySettingsEntry['kind'];

const directReceiptOperations = Object.freeze({
	create: { name: 'program_vocabulary.create', version: 1 },
	edit: { name: 'program_vocabulary.edit', version: 1 },
	retire: { name: 'program_vocabulary.retire', version: 1 },
	restore: { name: 'program_vocabulary.restore', version: 1 },
	delete: { name: 'program_vocabulary.delete', version: 1 }
} as const);
const draftReceiptOperations = Object.freeze({
	merge: { name: 'program_vocabulary.merge.draft', version: 1 }
} as const);
const publishReceiptOperation = Object.freeze({ name: 'program_vocabulary.merge', version: 1 } as const);

export type ProgramVocabularySettingsCommand =
	| { readonly action: 'create'; readonly kind: 'room'; readonly name: string; readonly capacity: number | null }
	| { readonly action: 'create'; readonly kind: 'track' | 'format'; readonly name: string }
	| {
			readonly action: 'edit';
			readonly kind: 'room';
			readonly id: string;
			readonly changes: { readonly name: string; readonly capacity: number | null };
	  }
	| {
			readonly action: 'edit';
			readonly kind: 'track' | 'format';
			readonly id: string;
			readonly changes: { readonly name: string };
	  }
	| {
			readonly action: 'retire' | 'restore' | 'delete';
			readonly kind: ProgramVocabularySettingsKind;
			readonly id: string;
	  }
	| {
			readonly action: 'merge';
			readonly kind: ProgramVocabularySettingsKind;
			readonly sourceId: string;
			readonly targetId: string;
	  };

export type ProgramVocabularySettingsOperation =
	| 'read' | 'create' | 'edit' | 'retire' | 'restore' | 'delete'
	| 'draft' | 'publish';

export type ProgramVocabularySettingsRefusalCode =
	| 'invalid_request'
	| 'item_not_found'
	| 'merge_target_not_found'
	| 'merge_same_item';

export type ProgramVocabularySettingsCorrection =
	| {
			readonly kind: 'forward_lifecycle';
			readonly command: {
				readonly action: 'retire' | 'restore';
				readonly kind: ProgramVocabularySettingsKind;
				readonly id: string;
			};
	  }
	| {
			readonly kind: 'forward_change_required';
			readonly action: 'create' | 'edit' | 'delete';
	  };

export type ProgramVocabularySettingsCommittedMutation =
	| {
	readonly action: Exclude<ProgramVocabularySettingsCommand['action'], 'merge'>;
	readonly change: ProgramVocabularyChangeView;
	readonly correction: ProgramVocabularySettingsCorrection;
	  }
	| {
	readonly action: 'merge';
	readonly change: ProgramVocabularyChangeView;
	  };

export interface ProgramVocabularySettingsConfirmationRequired {
	readonly action: 'merge';
	readonly selector: ProgramVocabularyMergePublishInput;
	readonly change: ProgramVocabularyChangeView;
}

export type ProgramVocabularySettingsApplyResult =
	| {
			readonly kind: 'success';
			readonly data: ProgramVocabularySettingsCommittedMutation;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'confirmation_required';
			readonly data: ProgramVocabularySettingsConfirmationRequired;
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
	| {
			readonly kind: 'unavailable';
			readonly operation: ProgramVocabularySettingsOperation;
			readonly reason: OperatorHttpBindingUnavailableReason;
	  }
	| {
			readonly kind: 'refused';
			readonly code: ProgramVocabularySettingsRefusalCode;
			readonly reason: string;
	  };

export type ProgramVocabularySettingsMutationOutcome =
	| {
			readonly ok: true;
			readonly mutation: Extract<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }>;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly failure: Exclude<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }>;
	  };

type ApplyOptions = Readonly<{
	idempotencyKey?: string;
	signal?: AbortSignal;
}>;

/**
 * Source-neutral Settings vocabulary seam. Its verbs mirror the tuned consumer,
 * while its rows retain canonical usage and nullable capacity without aliases.
 */
export interface ProgramVocabularySettingsPort {
	readonly source: EventProgramSource;
	read(options?: { readonly signal?: AbortSignal }): Promise<
		| { readonly kind: 'success'; readonly data: ProgramVocabularySnapshotView; readonly correlationId: string }
		| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
		| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason }
	>;
	rooms(options?: { readonly signal?: AbortSignal }): Promise<ProgramRoomView[]>;
	tracks(options?: { readonly signal?: AbortSignal }): Promise<ProgramTrackView[]>;
	formats(options?: { readonly signal?: AbortSignal }): Promise<ProgramFormatView[]>;
	apply(command: ProgramVocabularySettingsCommand, options?: ApplyOptions): Promise<ProgramVocabularySettingsApplyResult>;
	publishMerge(confirmation: ProgramVocabularySettingsConfirmationRequired, options?: ApplyOptions): Promise<ProgramVocabularySettingsApplyResult>;
	addRoom(name: string, capacity: number | null): Promise<ProgramRoomView>;
	addTrack(name: string): Promise<ProgramTrackView>;
	addFormat(name: string): Promise<ProgramFormatView>;
	editRoom(id: string, name: string, capacity: number | null): Promise<ProgramVocabularySettingsMutationOutcome>;
	editTrack(id: string, name: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	editFormat(id: string, name: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	removeRoom(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	removeTrack(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	removeFormat(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	retireRoom(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	retireTrack(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	retireFormat(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	restoreRoom(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	restoreTrack(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	restoreFormat(id: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	mergeRoom(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsApplyResult>;
	mergeTrack(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsApplyResult>;
	mergeFormat(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsApplyResult>;
}

type AdapterFailure = Readonly<{ code: string; reason: string }>;

export class ProgramVocabularySettingsAdapterError extends Error {
	readonly code: string;
	readonly result: Exclude<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }> | null;

	constructor(
		failure: AdapterFailure,
		result: Exclude<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }> | null = null
	) {
		super(failure.reason);
		this.name = 'ProgramVocabularySettingsAdapterError';
		this.code = failure.code;
		this.result = result;
	}
}

function invalidRequest(): ProgramVocabularySettingsApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): ProgramVocabularySettingsApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name
		&& receipt.operationVersion === operation.version;
}

function sameJson(left: unknown, right: unknown): boolean {
	function ordered(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(ordered);
		if (typeof value !== 'object' || value === null) return value;
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
				.map(([key, child]) => [key, ordered(child)])
		);
	}
	return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function itemFrom(
	snapshot: ProgramVocabularySnapshotView,
	kind: ProgramVocabularySettingsKind,
	id: string
): ProgramVocabularySettingsEntry | undefined {
	const entries = kind === 'room'
		? snapshot.rooms
		: kind === 'track' ? snapshot.tracks : snapshot.formats;
	return entries.find((entry) => entry.id === id);
}

function safeItem(item: ProgramVocabularySettingsEntry) {
	switch (item.kind) {
		case 'room':
			return {
				kind: item.kind, id: item.id, name: item.name, status: item.status,
				version: item.version, capacity: item.capacity
			} as const;
		case 'track':
			return {
				kind: item.kind, id: item.id, name: item.name, status: item.status,
				version: item.version, accent: item.accent
			} as const;
		case 'format':
			return {
				kind: item.kind, id: item.id, name: item.name, status: item.status,
				version: item.version
			} as const;
	}
}

function mergeChange(draft: ProgramVocabularyMergeReviewData): ProgramVocabularyChangeView {
	const diff = draft.safeDiff;
	if (diff.action !== 'merge') throw new TypeError('program_vocabulary_merge_diff_required');
	return Object.freeze({
		action: 'merge',
		sourceBefore: Object.freeze({ ...diff.sourceBefore }),
		sourceAfter: Object.freeze({ ...diff.sourceAfter }),
		target: Object.freeze({ ...diff.target }),
		liveRepoints: diff.liveRepoints,
		historicalPinsPreserved: diff.historicalPinsPreserved
	});
}

function safeDiffMatchesRequest(
	diff: ProgramVocabularySafeDiff,
	request: EventProgramDirectRequest | EventProgramMergeDraftRequest,
	snapshot: ProgramVocabularySnapshotView
): boolean {
	if (diff.action !== request.action) return false;
	switch (request.action) {
		case 'create': {
			if (diff.action !== 'create'
				|| diff.before !== null
				|| diff.after.kind !== request.input.kind
				|| diff.after.name !== request.input.name
				|| diff.after.status !== 'active'
				|| diff.after.version !== 1
				|| itemFrom(snapshot, diff.after.kind, diff.after.id) !== undefined) return false;
			return diff.after.kind !== 'room'
				|| (request.input.kind === 'room' && diff.after.capacity === request.input.capacity);
		}
		case 'edit': {
			if (diff.action !== 'edit') return false;
			const before = itemFrom(snapshot, request.input.kind, request.input.id);
			if (!before || !sameJson(diff.before, safeItem(before))
				|| diff.after.kind !== before.kind
				|| diff.after.id !== before.id
				|| diff.after.status !== before.status
				|| diff.after.version !== before.version + 1) return false;
			if (diff.after.kind === 'room') {
				return request.input.kind === 'room'
					&& diff.after.name === request.input.changes.name
					&& diff.after.capacity === request.input.changes.capacity;
			}
			return diff.after.name === request.input.changes.name
				&& (diff.after.kind !== 'track'
					|| (before.kind === 'track' && diff.after.accent === before.accent));
		}
		case 'retire':
		case 'restore': {
			if (diff.action !== request.action) return false;
			const before = itemFrom(snapshot, request.input.kind, request.input.id);
			return before !== undefined
				&& before.status === (request.action === 'retire' ? 'active' : 'retired')
				&& sameJson(diff.before, safeItem(before))
				&& diff.after.id === before.id
				&& diff.after.kind === before.kind
				&& diff.after.name === before.name
				&& diff.after.version === before.version + 1
				&& diff.after.status === (request.action === 'retire' ? 'retired' : 'active')
				&& (diff.after.kind !== 'room'
					|| (before.kind === 'room' && diff.after.capacity === before.capacity))
				&& (diff.after.kind !== 'track'
					|| (before.kind === 'track' && diff.after.accent === before.accent));
		}
		case 'delete': {
			if (diff.action !== 'delete') return false;
			const before = itemFrom(snapshot, request.input.kind, request.input.id);
			return before !== undefined
				&& sameJson(diff.before, safeItem(before))
				&& diff.after === null
				&& diff.usage.current === before.usage.currentReferences
				&& diff.usage.historicalPins === before.usage.historicalPins;
		}
		case 'merge': {
			if (diff.action !== 'merge') return false;
			const source = itemFrom(snapshot, request.input.kind, request.input.sourceId);
			const target = itemFrom(snapshot, request.input.kind, request.input.targetId);
			return source !== undefined
				&& target !== undefined
				&& sameJson(diff.sourceBefore, safeItem(source))
				&& sameJson(diff.target, safeItem(target))
				&& diff.sourceAfter.kind === source.kind
				&& diff.sourceAfter.id === source.id
				&& diff.sourceAfter.name === source.name
				&& diff.sourceAfter.status === 'retired'
				&& diff.sourceAfter.version === source.version + 1
				&& (diff.sourceAfter.kind !== 'room'
					|| (source.kind === 'room' && diff.sourceAfter.capacity === source.capacity))
				&& (diff.sourceAfter.kind !== 'track'
					|| (source.kind === 'track' && diff.sourceAfter.accent === source.accent))
				&& diff.liveRepoints === source.usage.currentReferences
				&& diff.historicalPinsPreserved === source.usage.historicalPins;
		}
	}
}

type RequestBuild =
	| { readonly kind: 'request'; readonly request: EventProgramDirectRequest | EventProgramMergeDraftRequest }
	| {
			readonly kind: 'refused';
			readonly code: ProgramVocabularySettingsRefusalCode;
			readonly reason: string;
	  };

function buildRequest(
	command: ProgramVocabularySettingsCommand,
	snapshot: ProgramVocabularySnapshotView
): RequestBuild {
	if (command.action === 'create') {
		const parsed = programVocabularyCreateDraftRequestSchema.safeParse({
			kind: command.kind,
			name: command.name,
			expectedSetVersion: snapshot.setVersion,
			...(command.kind === 'room' ? { capacity: command.capacity } : {})
		});
		return parsed.success
			? { kind: 'request', request: { action: command.action, input: parsed.data } }
			: { kind: 'refused', code: 'invalid_request', reason: 'Review this vocabulary entry and try again.' };
	}

	if (command.action === 'merge') {
		if (command.sourceId === command.targetId) {
			return {
				kind: 'refused', code: 'merge_same_item',
				reason: 'Choose two different vocabulary entries to merge.'
			};
		}
		const source = itemFrom(snapshot, command.kind, command.sourceId);
		if (!source) {
			return {
				kind: 'refused', code: 'item_not_found',
				reason: 'The vocabulary entry being merged no longer exists. Reload and try again.'
			};
		}
		const target = itemFrom(snapshot, command.kind, command.targetId);
		if (!target) {
			return {
				kind: 'refused', code: 'merge_target_not_found',
				reason: 'The merge destination no longer exists. Reload and try again.'
			};
		}
		const parsed = programVocabularyMergeDraftRequestSchema.safeParse({
			kind: command.kind,
			sourceId: command.sourceId,
			targetId: command.targetId,
			expectedSetVersion: snapshot.setVersion,
			expectedSourceVersion: source.version,
			expectedTargetVersion: target.version
		});
		return parsed.success
			? { kind: 'request', request: { action: command.action, input: parsed.data } }
			: { kind: 'refused', code: 'invalid_request', reason: 'Review this merge and try again.' };
	}

	const current = itemFrom(snapshot, command.kind, command.id);
	if (!current) {
		return {
			kind: 'refused', code: 'item_not_found',
			reason: 'This vocabulary entry no longer exists. Reload and try again.'
		};
	}
	const base = {
		kind: command.kind,
		id: command.id,
		expectedSetVersion: snapshot.setVersion,
		expectedItemVersion: current.version
	};
	if (command.action === 'edit') {
		const parsed = programVocabularyEditDraftRequestSchema.safeParse({ ...base, changes: command.changes });
		return parsed.success
			? { kind: 'request', request: { action: command.action, input: parsed.data } }
			: { kind: 'refused', code: 'invalid_request', reason: 'Review this vocabulary entry and try again.' };
	}
	const schema = command.action === 'retire'
		? programVocabularyRetireDraftRequestSchema
		: command.action === 'restore'
			? programVocabularyRestoreDraftRequestSchema
			: programVocabularyDeleteDraftRequestSchema;
	const parsed = schema.safeParse(base);
	return parsed.success
		? { kind: 'request', request: { action: command.action, input: parsed.data } }
		: { kind: 'refused', code: 'invalid_request', reason: 'Review this vocabulary action and try again.' };
}

function directChange(input: {
	readonly command: Exclude<ProgramVocabularySettingsCommand, { readonly action: 'merge' }>;
	readonly request: EventProgramDirectRequest;
	readonly before: ProgramVocabularySnapshotView;
	readonly after: ProgramVocabularySnapshotView;
	readonly result: ProgramVocabularyDirectData;
}): ProgramVocabularyChangeView | null {
	const { command, request, before, after, result } = input;
	if (result.action !== command.action
		|| result.kind !== command.kind
		|| result.setVersion !== before.setVersion + 1
		|| after.setVersion !== result.setVersion
		|| result.liveRepoints !== 0
		|| result.affectedIds.length !== 1) return null;

	let raw: unknown;
	if (command.action === 'create') {
		const created = itemFrom(after, command.kind, result.affectedIds[0]!);
		if (!created) return null;
		raw = { action: 'create', before: null, after: safeItem(created) };
	} else {
		if (result.affectedIds[0] !== command.id) return null;
		const previous = itemFrom(before, command.kind, command.id);
		if (!previous) return null;
		if (command.action === 'delete') {
			if (itemFrom(after, command.kind, command.id)) return null;
			raw = {
				action: 'delete', before: safeItem(previous), after: null,
				usage: { current: previous.usage.currentReferences, historicalPins: previous.usage.historicalPins }
			};
		} else {
			const updated = itemFrom(after, command.kind, command.id);
			if (!updated) return null;
			raw = { action: command.action, before: safeItem(previous), after: safeItem(updated) };
		}
	}
	const diff = programVocabularySafeDiffSchema.safeParse(raw);
	if (!diff.success || !safeDiffMatchesRequest(diff.data, request, before)) return null;
	switch (diff.data.action) {
		case 'create':
			return Object.freeze({ action: 'create', before: null, after: Object.freeze({ ...diff.data.after }) });
		case 'edit':
		case 'retire':
		case 'restore':
			return Object.freeze({ action: diff.data.action,
				before: Object.freeze({ ...diff.data.before }), after: Object.freeze({ ...diff.data.after }) });
		case 'delete':
			return Object.freeze({ action: 'delete', before: Object.freeze({ ...diff.data.before }), after: null,
				usage: Object.freeze({ currentReferences: diff.data.usage.current,
					historicalPins: diff.data.usage.historicalPins }) });
		case 'merge':
			return null;
		default:
			return null;
	}
}

function directCorrection(
	command: Exclude<ProgramVocabularySettingsCommand, { readonly action: 'merge' }>,
	change: ProgramVocabularyChangeView
): ProgramVocabularySettingsCorrection {
	if ((command.action === 'retire' || command.action === 'restore')
		&& change.action === command.action) {
		return Object.freeze({
			kind: 'forward_lifecycle',
			command: Object.freeze({
				action: command.action === 'retire' ? 'restore' as const : 'retire' as const,
				kind: command.kind,
				id: command.id
			})
		});
	}
	if (command.action === 'create' || command.action === 'edit' || command.action === 'delete') {
		return Object.freeze({ kind: 'forward_change_required', action: command.action });
	}
	throw new TypeError('program_vocabulary_direct_correction_mismatch');
}

function failureCopy(
	result: Exclude<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'refused') return { code: result.code, reason: result.reason };
	if (result.kind === 'confirmation_required') {
		return {
			code: 'merge_review_required',
			reason: 'Review the affected references before merging these program categories.'
		};
	}
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Program vocabulary changes are not available in this workspace.'
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? 'The vocabulary change could not reach JooEvents. Try again.'
				: 'This vocabulary change is not valid.'
		};
	}
	if (result.outcome.kind === 'program_vocabulary.delete_referenced') {
		return {
			code: result.outcome.kind,
			reason: 'This entry still has current references or historical pins. Retire or merge it instead.'
		};
	}
	if (result.outcome.class === 'stale_revision') {
		return {
			code: result.outcome.kind,
			reason: 'Program vocabulary changed while you were working. Reload and try again.'
		};
	}
	if (result.outcome.class === 'access_denied') {
		return {
			code: result.outcome.kind,
			reason: 'You no longer have permission to change program vocabulary.'
		};
	}
	if (result.outcome.kind === 'program_vocabulary.event_required') {
		return {
			code: result.outcome.kind,
			reason: 'Create or select an event before changing program vocabulary.'
		};
	}
	return {
		code: result.outcome.kind,
		reason: 'This vocabulary change could not be applied.'
	};
}

function readFailure(
	result: Exclude<Awaited<ReturnType<EventProgramPort['vocabulary']['read']>>, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'outcome') {
		return failureCopy({
			kind: 'outcome', outcome: result.outcome, terminal: false,
			correlationId: result.correlationId
		});
	}
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Program vocabulary is not available in this workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Program vocabulary could not be reached. Try again.'
			: 'This Program Vocabulary request is not valid.'
	};
}

function createdEntry(
	change: ProgramVocabularyChangeView
): ProgramVocabularySettingsEntry | null {
	if (change.action !== 'create') return null;
	const usage = Object.freeze({ currentReferences: 0, historicalPins: 0 });
	const deleteAvailability = Object.freeze({ kind: 'available' as const });
	return Object.freeze({ ...change.after, usage, deleteAvailability });
}

function defaultIdempotencyKey(): string {
	return `je.program-vocabulary.action.${globalThis.crypto.randomUUID()}`;
}

export function createProgramVocabularySettingsAdapter(input: {
	readonly program: EventProgramPort;
	readonly newIdempotencyKey?: () => string;
}): ProgramVocabularySettingsPort {
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const replayKeys = new Map<string, string>();

	async function readSnapshot(options: { readonly signal?: AbortSignal } = {}) {
		return input.program.vocabulary.read(options);
	}

	async function list<Entry extends ProgramVocabularySettingsEntry>(
		select: (snapshot: ProgramVocabularySnapshotView) => readonly Entry[],
		options: { readonly signal?: AbortSignal } = {}
	): Promise<Entry[]> {
		const result = await readSnapshot(options);
		if (result.kind === 'success') return [...select(result.data)];
		throw new ProgramVocabularySettingsAdapterError(readFailure(result));
	}

	async function apply(
		command: ProgramVocabularySettingsCommand,
		options: ApplyOptions = {}
	): Promise<ProgramVocabularySettingsApplyResult> {
		options.signal?.throwIfAborted();
		const current = await readSnapshot(options.signal ? { signal: options.signal } : {});
		if (current.kind === 'outcome') {
			return {
				kind: 'outcome', outcome: current.outcome, terminal: false,
				correlationId: current.correlationId
			};
		}
		if (current.kind === 'transport_error') return current;
		if (current.kind === 'unavailable') {
			return { kind: 'unavailable', operation: 'read', reason: current.reason };
		}

		const built = buildRequest(command, current.data);
		if (built.kind === 'refused') return built;
		const fingerprint = `${command.action}:${JSON.stringify(built.request.input)}`;
		const baseKey = options.idempotencyKey
			?? replayKeys.get(fingerprint)
			?? newIdempotencyKey();
		if (options.idempotencyKey === undefined) replayKeys.set(fingerprint, baseKey);
		if (!operationHttpIdempotencyKeySchema.safeParse(baseKey).success) return invalidRequest();

		if (built.request.action !== 'merge' && command.action !== 'merge') {
			const direct = built.request.action === 'create'
				? await input.program.vocabulary.create(built.request.input, {
					idempotencyKey: baseKey, ...(options.signal ? { signal: options.signal } : {})
				})
				: built.request.action === 'edit'
					? await input.program.vocabulary.edit(built.request.input, {
						idempotencyKey: baseKey, ...(options.signal ? { signal: options.signal } : {})
					})
					: built.request.action === 'retire'
						? await input.program.vocabulary.retire(built.request.input, {
							idempotencyKey: baseKey, ...(options.signal ? { signal: options.signal } : {})
						})
						: built.request.action === 'restore'
							? await input.program.vocabulary.restore(built.request.input, {
								idempotencyKey: baseKey, ...(options.signal ? { signal: options.signal } : {})
							})
							: await input.program.vocabulary.delete(built.request.input, {
								idempotencyKey: baseKey, ...(options.signal ? { signal: options.signal } : {})
							});
			const directOperation = directReceiptOperations[built.request.action];
			if (direct.kind === 'outcome') {
				if ((direct.terminal && !receiptMatches(direct.receipt, directOperation))
					|| (!direct.terminal && direct.receipt !== undefined)) return invalidContract();
				if (direct.terminal) replayKeys.delete(fingerprint);
				return direct;
			}
			if (direct.kind === 'transport_error') return direct;
			if (direct.kind === 'unavailable') {
				return { kind: 'unavailable', operation: built.request.action, reason: direct.reason };
			}
			if (!receiptMatches(direct.receipt, directOperation)) return invalidContract();
			const refreshed = await readSnapshot(options.signal ? { signal: options.signal } : {});
			if (refreshed.kind === 'outcome') {
				return { kind: 'outcome', outcome: refreshed.outcome, terminal: false,
					correlationId: refreshed.correlationId };
			}
			if (refreshed.kind === 'transport_error') return refreshed;
			if (refreshed.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'read', reason: refreshed.reason };
			}
			const change = directChange({ command, request: built.request, before: current.data,
				after: refreshed.data, result: direct.data });
			if (!change) return invalidContract();
			replayKeys.delete(fingerprint);
			return {
				kind: 'success',
				data: Object.freeze({ action: command.action, change,
					correction: directCorrection(command, change) }),
				receipt: direct.receipt,
				correlationId: direct.correlationId
			};
		}
		if (built.request.action !== 'merge' || command.action !== 'merge') return invalidContract();
		const draft = await input.program.vocabulary.draftMerge(built.request, {
			idempotencyKey: baseKey,
			...(options.signal ? { signal: options.signal } : {})
		});
		const draftOperation = draftReceiptOperations.merge;
		if (draft.kind === 'outcome') {
			if ((draft.terminal && !receiptMatches(draft.receipt, draftOperation))
				|| (!draft.terminal && draft.receipt !== undefined)) return invalidContract();
			if (draft.terminal) replayKeys.delete(fingerprint);
			return draft;
		}
		if (draft.kind === 'transport_error') return draft;
		if (draft.kind === 'unavailable') {
			return { kind: 'unavailable', operation: 'draft', reason: draft.reason };
		}
		const draftSafeDiff = draft.data.safeDiff;
		if (!receiptMatches(draft.receipt, draftOperation)
			|| !safeDiffMatchesRequest(draftSafeDiff, built.request, current.data)) {
			return invalidContract();
		}
		replayKeys.delete(fingerprint);
		return {
			kind: 'confirmation_required',
			data: Object.freeze({
				action: 'merge',
				selector: Object.freeze({
					draftId: draft.data.draftId,
					revisionId: draft.data.revision.id,
					revisionDigestSha256: draft.data.revision.digestSha256
				}),
				change: mergeChange(draft.data)
			}),
			receipt: draft.receipt,
			correlationId: draft.correlationId
		};
	}

	async function publishMerge(
		confirmation: ProgramVocabularySettingsConfirmationRequired,
		options: ApplyOptions = {}
	): Promise<ProgramVocabularySettingsApplyResult> {
		options.signal?.throwIfAborted();
		if (confirmation.action !== 'merge' || confirmation.change.action !== 'merge') return invalidRequest();
		const fingerprint = `publish:${JSON.stringify(confirmation.selector)}`;
		const idempotencyKey = options.idempotencyKey
			?? replayKeys.get(fingerprint)
			?? newIdempotencyKey();
		if (options.idempotencyKey === undefined) replayKeys.set(fingerprint, idempotencyKey);
		if (!operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
		const published = await input.program.vocabulary.publishMerge(confirmation.selector, {
			idempotencyKey,
			...(options.signal ? { signal: options.signal } : {})
		});
		if (published.kind === 'outcome') {
			if ((published.terminal && !receiptMatches(published.receipt, publishReceiptOperation))
				|| (!published.terminal && published.receipt !== undefined)) return invalidContract();
			if (published.terminal) replayKeys.delete(fingerprint);
			return published;
		}
		if (published.kind === 'transport_error') return published;
		if (published.kind === 'unavailable') {
			return { kind: 'unavailable', operation: 'publish', reason: published.reason };
		}
		if (!receiptMatches(published.receipt, publishReceiptOperation)
			|| published.data.action !== 'merge'
			|| published.data.kind !== confirmation.change.sourceBefore.kind
			|| published.data.liveRepoints !== confirmation.change.liveRepoints
			|| published.data.affectedIds.length !== 2
			|| !published.data.affectedIds.includes(confirmation.change.sourceBefore.id)
			|| !published.data.affectedIds.includes(confirmation.change.target.id)) return invalidContract();
		const refreshed = await readSnapshot(options.signal ? { signal: options.signal } : {});
		if (refreshed.kind === 'outcome') {
			return { kind: 'outcome', outcome: refreshed.outcome, terminal: false, correlationId: refreshed.correlationId };
		}
		if (refreshed.kind === 'transport_error') return refreshed;
		if (refreshed.kind === 'unavailable') return { kind: 'unavailable', operation: 'read', reason: refreshed.reason };
		const source = itemFrom(refreshed.data, confirmation.change.sourceBefore.kind,
			confirmation.change.sourceBefore.id);
		const target = itemFrom(refreshed.data, confirmation.change.target.kind,
			confirmation.change.target.id);
		if (!source || !target || source.status !== 'retired'
			|| source.version !== confirmation.change.sourceAfter.version
			|| source.usage.currentReferences !== 0
			|| refreshed.data.setVersion !== published.data.setVersion) return invalidContract();
		replayKeys.delete(fingerprint);
		return {
			kind: 'success',
			data: Object.freeze({ action: 'merge', change: confirmation.change }),
			receipt: published.receipt,
			correlationId: published.correlationId
		};
	}

	async function mutation(
		command: ProgramVocabularySettingsCommand
	): Promise<ProgramVocabularySettingsMutationOutcome> {
		const result = await apply(command);
		return result.kind === 'success'
			? { ok: true, mutation: result }
			: { ok: false, reason: failureCopy(result).reason, failure: result };
	}

	async function add(
		command: Extract<ProgramVocabularySettingsCommand, { readonly action: 'create' }>
	): Promise<ProgramVocabularySettingsEntry> {
		const result = await apply(command);
		if (result.kind !== 'success') {
			const failure = failureCopy(result);
			throw new ProgramVocabularySettingsAdapterError(failure, result);
		}
		const entry = createdEntry(result.data.change);
		if (!entry || entry.kind !== command.kind) {
			throw new ProgramVocabularySettingsAdapterError({
				code: 'invalid_contract',
				reason: 'The committed vocabulary change returned an invalid entry.'
			});
		}
		return entry;
	}

	return Object.freeze({
		source: input.program.source,
		read: readSnapshot,
		rooms: (options = {}) => list((snapshot) => snapshot.rooms, options),
		tracks: (options = {}) => list((snapshot) => snapshot.tracks, options),
		formats: (options = {}) => list((snapshot) => snapshot.formats, options),
		apply,
		publishMerge,
		async addRoom(name, capacity) {
			const entry = await add({ action: 'create', kind: 'room', name, capacity });
			if (entry.kind !== 'room') throw new TypeError('program_vocabulary_created_kind_mismatch');
			return entry;
		},
		async addTrack(name) {
			const entry = await add({ action: 'create', kind: 'track', name });
			if (entry.kind !== 'track') throw new TypeError('program_vocabulary_created_kind_mismatch');
			return entry;
		},
		async addFormat(name) {
			const entry = await add({ action: 'create', kind: 'format', name });
			if (entry.kind !== 'format') throw new TypeError('program_vocabulary_created_kind_mismatch');
			return entry;
		},
		editRoom: (id, name, capacity) => mutation({ action: 'edit', kind: 'room', id, changes: { name, capacity } }),
		editTrack: (id, name) => mutation({ action: 'edit', kind: 'track', id, changes: { name } }),
		editFormat: (id, name) => mutation({ action: 'edit', kind: 'format', id, changes: { name } }),
		removeRoom: (id) => mutation({ action: 'delete', kind: 'room', id }),
		removeTrack: (id) => mutation({ action: 'delete', kind: 'track', id }),
		removeFormat: (id) => mutation({ action: 'delete', kind: 'format', id }),
		retireRoom: (id) => mutation({ action: 'retire', kind: 'room', id }),
		retireTrack: (id) => mutation({ action: 'retire', kind: 'track', id }),
		retireFormat: (id) => mutation({ action: 'retire', kind: 'format', id }),
		restoreRoom: (id) => mutation({ action: 'restore', kind: 'room', id }),
		restoreTrack: (id) => mutation({ action: 'restore', kind: 'track', id }),
		restoreFormat: (id) => mutation({ action: 'restore', kind: 'format', id }),
		mergeRoom: (sourceId, targetId) => apply({ action: 'merge', kind: 'room', sourceId, targetId }),
		mergeTrack: (sourceId, targetId) => apply({ action: 'merge', kind: 'track', sourceId, targetId }),
		mergeFormat: (sourceId, targetId) => apply({ action: 'merge', kind: 'format', sourceId, targetId })
	} satisfies ProgramVocabularySettingsPort);
}

// Structural proof: richer mutation results remain usable by the existing
// `ok/reason` consumer while the source-neutral port retains structured detail.
const mutationOutcomeCompatibility = (
	value: ProgramVocabularySettingsMutationOutcome
): MutationOutcome => value;
void mutationOutcomeCompatibility;
