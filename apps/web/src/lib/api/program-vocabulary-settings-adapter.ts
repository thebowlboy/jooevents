import {
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	programVocabularyCreateDraftRequestSchema,
	programVocabularyDeleteDraftRequestSchema,
	programVocabularyEditDraftRequestSchema,
	programVocabularyMergeDraftRequestSchema,
	programVocabularyRestoreDraftRequestSchema,
	programVocabularyRetireDraftRequestSchema,
	programVocabularySafeDiffSchema,
	type ChangesetRevisionSelector,
	type OperationReceiptRef,
	type ProgramVocabularySafeDiff,
	type StructuredOutcome
} from '@jooevents/contracts';
import type {
	ChangesetReviewPort,
	ChangesetReviewResult
} from './changesets/port';
import type { SafeApiError } from './client';
import type {
	EventProgramDraftRequest,
	EventProgramPort,
	EventProgramSource
} from './event-program/port';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type { MutationOutcome } from './types';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView,
	ProgramVocabularyDraftChangeView,
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

const draftReceiptOperations = Object.freeze({
	create: { name: 'program_vocabulary.create.draft', version: 1 },
	edit: { name: 'program_vocabulary.edit.draft', version: 1 },
	retire: { name: 'program_vocabulary.retire.draft', version: 1 },
	restore: { name: 'program_vocabulary.restore.draft', version: 1 },
	delete: { name: 'program_vocabulary.delete.draft', version: 1 },
	merge: { name: 'program_vocabulary.merge.draft', version: 1 }
} as const);

const changesetReceiptOperations = Object.freeze({
	propose: { name: 'changeset.propose', version: 1 },
	commit: { name: 'changeset.commit', version: 1 }
} as const);

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

export type ProgramVocabularySettingsOperation = 'read' | 'draft' | 'propose' | 'commit';

export type ProgramVocabularySettingsRefusalCode =
	| 'invalid_request'
	| 'item_not_found'
	| 'merge_target_not_found'
	| 'merge_same_item';

export interface ProgramVocabularySettingsCorrectionSource {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly sourceCommitReceiptId: string;
}

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
			readonly kind: 'changeset_correction_required';
			readonly source: ProgramVocabularySettingsCorrectionSource;
	  };

export interface ProgramVocabularySettingsCommittedMutation {
	readonly action: ProgramVocabularySettingsCommand['action'];
	readonly selector: ChangesetRevisionSelector;
	readonly committedHeadVersion: number;
	readonly change: ProgramVocabularyDraftChangeView;
	readonly correction: ProgramVocabularySettingsCorrection;
}

export interface ProgramVocabularySettingsConfirmationRequired {
	readonly action: ProgramVocabularySettingsCommand['action'];
	readonly selector: ChangesetRevisionSelector;
	readonly headVersion: number;
	readonly change: ProgramVocabularyDraftChangeView;
	readonly requirement: 'distinct_current_human';
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
	mergeRoom(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	mergeTrack(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsMutationOutcome>;
	mergeFormat(sourceId: string, targetId: string): Promise<ProgramVocabularySettingsMutationOutcome>;
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

function sameSelector(
	left: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
	right: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string }
): boolean {
	return left.changesetId === right.changesetId
		&& left.revisionId === right.revisionId
		&& left.revisionDigest === right.revisionDigest;
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

function rawSafeDiff(change: ProgramVocabularyDraftChangeView): ProgramVocabularySafeDiff | null {
	const raw = change.action === 'delete'
		? {
				action: change.action,
				before: change.before,
				after: change.after,
				usage: {
					current: change.usage.currentReferences,
					historicalPins: change.usage.historicalPins
				}
			}
		: change;
	const parsed = programVocabularySafeDiffSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

function safeDiffMatchesRequest(
	diff: ProgramVocabularySafeDiff,
	request: EventProgramDraftRequest,
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
	| { readonly kind: 'request'; readonly request: EventProgramDraftRequest }
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
		? { kind: 'request', request: { action: command.action, input: parsed.data } as EventProgramDraftRequest }
		: { kind: 'refused', code: 'invalid_request', reason: 'Review this vocabulary action and try again.' };
}

async function workflowKeys(
	rawKey: string,
	action: ProgramVocabularySettingsCommand['action']
): Promise<Readonly<{ draft: string; propose: string; commit: string }> | undefined> {
	const parsed = operationHttpIdempotencyKeySchema.safeParse(rawKey);
	if (!parsed.success) return undefined;
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parsed.data)
	);
	const anchor = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return Object.freeze({
		draft: `je.program-vocabulary.${action}.draft.${anchor}`,
		propose: `je.program-vocabulary.${action}.propose.${anchor}`,
		commit: `je.program-vocabulary.${action}.commit.${anchor}`
	});
}

function mapReviewFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): ProgramVocabularySettingsApplyResult {
	if (result.kind === 'unavailable') {
		return { kind: 'unavailable', operation, reason: result.reason };
	}
	if (result.kind === 'transport_error') return result;
	if (typeof result.terminal !== 'boolean') return invalidContract();
	const expected = changesetReceiptOperations[operation];
	if ((result.terminal && !receiptMatches(result.receipt, expected))
		|| (!result.terminal && result.receipt !== undefined)) return invalidContract();
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

function proposedMatches(input: {
	readonly result: Extract<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>['data'];
	readonly selector: ChangesetRevisionSelector;
	readonly expectedHeadVersion: number;
	readonly expectedRevisionNumber: number;
	readonly expectedRisk: 'low' | 'normal' | 'consequential';
	readonly expectedApproval: 'none' | 'distinct_current_human';
	readonly expectedSafeDiff: ProgramVocabularySafeDiff;
}): boolean {
	const result = input.result as {
		readonly selector: ChangesetRevisionSelector;
		readonly headVersion: number;
		readonly status: { readonly value: string };
		readonly revisionNumber: number;
		readonly risk: { readonly value: string };
		readonly approval: { readonly requirement: string };
		readonly operationCount: number;
		readonly groups: readonly {
			readonly operations: readonly {
				readonly kind: string;
				readonly version: number;
				readonly risk: { readonly value: string };
				readonly dependencyGroup: string;
				readonly safeDiff: unknown;
			}[];
		}[];
	};
	const operations = result.groups.flatMap((group) => group.operations);
	const operation = operations[0];
	const diff = programVocabularySafeDiffSchema.safeParse(operation?.safeDiff);
	return sameSelector(result.selector, input.selector)
		&& result.headVersion === input.expectedHeadVersion + 1
		&& result.status.value === 'proposed'
		&& result.revisionNumber === input.expectedRevisionNumber
		&& result.risk.value === input.expectedRisk
		&& result.approval.requirement === input.expectedApproval
		&& result.operationCount === 1
		&& operations.length === 1
		&& operation?.kind === 'program.vocabulary.mutate'
		&& operation.version === 1
		&& operation.risk.value === input.expectedRisk
		&& operation.dependencyGroup === 'program_vocabulary'
		&& diff.success
		&& sameJson(diff.data, input.expectedSafeDiff);
}

function correctionFor(input: {
	readonly command: ProgramVocabularySettingsCommand;
	readonly selector: ChangesetRevisionSelector;
	readonly receipt: OperationReceiptRef;
	readonly change: ProgramVocabularyDraftChangeView;
}): ProgramVocabularySettingsCorrection {
	if (input.command.action === 'retire' || input.command.action === 'restore') {
		const after = input.change.action === input.command.action ? input.change.after : null;
		if (after) {
			return Object.freeze({
				kind: 'forward_lifecycle',
				command: Object.freeze({
					action: input.command.action === 'retire' ? 'restore' as const : 'retire' as const,
					kind: after.kind,
					id: after.id
				})
			});
		}
	}
	return Object.freeze({
		kind: 'changeset_correction_required',
		source: Object.freeze({
			changesetId: input.selector.changesetId,
			revisionId: input.selector.revisionId,
			revisionDigest: input.selector.revisionDigest,
			sourceCommitReceiptId: input.receipt.id
		})
	});
}

function failureCopy(
	result: Exclude<ProgramVocabularySettingsApplyResult, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'refused') return { code: result.code, reason: result.reason };
	if (result.kind === 'confirmation_required') {
		return {
			code: 'distinct_current_human_required',
			reason: 'This vocabulary change needs confirmation from another currently authorized person.'
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
	change: ProgramVocabularyDraftChangeView
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
	readonly changesets: ChangesetReviewPort;
	readonly newIdempotencyKey?: () => string;
}): ProgramVocabularySettingsPort {
	if (input.program.source.kind !== input.changesets.source.kind) {
		throw new TypeError('program_vocabulary_source_mismatch');
	}
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
		const keys = await workflowKeys(baseKey, command.action);
		if (!keys) return invalidRequest();

		const draft = await input.program.vocabulary.draft(built.request, {
			idempotencyKey: keys.draft,
			...(options.signal ? { signal: options.signal } : {})
		});
		const draftOperation = draftReceiptOperations[command.action];
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
		const draftSafeDiff = rawSafeDiff(draft.data.change);
		if (!receiptMatches(draft.receipt, draftOperation)
			|| !draftSafeDiff
			|| !safeDiffMatchesRequest(draftSafeDiff, built.request, current.data)) {
			return invalidContract();
		}
		const selector = changesetRevisionSelectorSchema.safeParse({
			changesetId: draft.data.changesetId,
			revisionId: draft.data.revision.id,
			revisionDigest: draft.data.revision.digestSha256
		});
		if (!selector.success) return invalidContract();
		if (draft.data.approvalPolicy.requirement === 'distinct_current_human') {
			replayKeys.delete(fingerprint);
			return {
				kind: 'confirmation_required',
				data: Object.freeze({
					action: command.action,
					selector: Object.freeze({ ...selector.data }),
					headVersion: draft.data.headVersion,
					change: draft.data.change,
					requirement: 'distinct_current_human' as const
				}),
				receipt: draft.receipt,
				correlationId: draft.correlationId
			};
		}

		const proposed = await input.changesets.propose(
			{ ...selector.data, expectedHeadVersion: draft.data.headVersion },
			keys.propose,
			options.signal ? { signal: options.signal } : {}
		);
		if (proposed.kind !== 'success') return mapReviewFailure(proposed, 'propose');
		if (!receiptMatches(proposed.receipt, changesetReceiptOperations.propose)
			|| proposed.correlationId === undefined
			|| !proposedMatches({
				result: proposed.data,
				selector: selector.data,
				expectedHeadVersion: draft.data.headVersion,
				expectedRevisionNumber: draft.data.revision.number,
				expectedRisk: draft.data.riskTier,
				expectedApproval: draft.data.approvalPolicy.requirement,
				expectedSafeDiff: draftSafeDiff
			})) return invalidContract();

		const committed = await input.changesets.commit(
			{ ...selector.data, expectedHeadVersion: proposed.data.headVersion },
			keys.commit,
			options.signal ? { signal: options.signal } : {}
		);
		if (committed.kind !== 'success') return mapReviewFailure(committed, 'commit');
		if (!receiptMatches(committed.receipt, changesetReceiptOperations.commit)
			|| committed.correlationId === undefined
			|| !sameSelector({
				changesetId: committed.data.changesetId,
				revisionId: committed.data.revisionId,
				revisionDigest: committed.data.revisionDigest
			}, selector.data)
			|| committed.data.expectedHeadVersion !== proposed.data.headVersion
			|| committed.data.committedHeadVersion !== proposed.data.headVersion + 1) {
			return invalidContract();
		}
		replayKeys.delete(fingerprint);
		return {
			kind: 'success',
			data: Object.freeze({
				action: command.action,
				selector: Object.freeze({ ...selector.data }),
				committedHeadVersion: committed.data.committedHeadVersion,
				change: draft.data.change,
				correction: correctionFor({
					command,
					selector: selector.data,
					receipt: committed.receipt,
					change: draft.data.change
				})
			}),
			receipt: committed.receipt,
			correlationId: committed.correlationId
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
		mergeRoom: (sourceId, targetId) => mutation({ action: 'merge', kind: 'room', sourceId, targetId }),
		mergeTrack: (sourceId, targetId) => mutation({ action: 'merge', kind: 'track', sourceId, targetId }),
		mergeFormat: (sourceId, targetId) => mutation({ action: 'merge', kind: 'format', sourceId, targetId })
	} satisfies ProgramVocabularySettingsPort);
}

// Structural proof: richer mutation results remain usable by the existing
// `ok/reason` consumer while the source-neutral port retains structured detail.
const mutationOutcomeCompatibility = (
	value: ProgramVocabularySettingsMutationOutcome
): MutationOutcome => value;
void mutationOutcomeCompatibility;
