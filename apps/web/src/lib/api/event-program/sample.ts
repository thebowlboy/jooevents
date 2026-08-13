import {
	changesetDiffDataSchema,
	changesetRevisionSelectorSchema,
	committedChangesetDataSchema,
	currentEventProjectionSchema,
	deriveProgramTrackAccent,
	eventCreateInputSchema,
	programVocabularyDraftDataSchema,
	programVocabularySnapshotSchema,
	type ChangesetRevisionSelector,
	type EventCreateInput,
	type ProgramVocabularyItemDto,
	type ProgramVocabularySafeDiff,
	type ProgramVocabularySnapshotDto
} from '@jooevents/contracts';
import { mapChangesetCommit, mapChangesetDiff } from '../changesets/mapper';
import type {
	ChangesetCommitView,
	ChangesetDiffView,
	ChangesetReviewEffectInput,
	ChangesetReviewPort,
	ChangesetReviewResult
} from '../changesets/port';
import { mapCurrentEvent, mapEvent } from '../mappers/event';
import {
	mapProgramVocabularyDraft,
	mapProgramVocabularySnapshot
} from '../mappers/program-vocabulary';
import type {
	EventProgramDraftRequest,
	EventProgramEffectResult,
	EventProgramPort,
	ResettableEventProgramSample
} from './port';
import type { EventProgramSampleFixture } from './fixtures';

interface ReplayEntry {
	readonly fingerprint: string;
	readonly result: EventProgramEffectResult<unknown>;
}

interface PendingVocabularyChange {
	readonly request: EventProgramDraftRequest;
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly riskTier: 'low' | 'normal';
	readonly safeDiff: ProgramVocabularySafeDiff;
	status: 'draft' | 'proposed' | 'committed';
	headVersion: number;
}

export interface ResettableEventProgramSampleComposition extends ResettableEventProgramSample {
	readonly changesets: ChangesetReviewPort & {
		readonly source: { readonly kind: 'sample'; readonly label: 'Sample data' };
	};
}

function defaultId(): string {
	return crypto.randomUUID();
}

function fingerprint(value: unknown): string {
	return JSON.stringify(value);
}

function digest(id: string): string {
	return id.replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}

function safeItem(item: ProgramVocabularyItemDto) {
	if (item.kind === 'room') {
		return {
				kind: item.kind,
				id: item.id,
				name: item.name,
				status: item.status,
				capacity: item.capacity,
				version: item.version
			};
	}
	if (item.kind === 'track') {
		return {
			kind: item.kind,
			id: item.id,
			name: item.name,
			accent: item.accent,
			status: item.status,
			version: item.version
		};
	}
	return {
				kind: item.kind,
				id: item.id,
				name: item.name,
				status: item.status,
				version: item.version
			};
}

function itemFrom(
	snapshot: ProgramVocabularySnapshotDto,
	kind: EventProgramDraftRequest['input']['kind'],
	id: string
): ProgramVocabularyItemDto | undefined {
	const collection =
		kind === 'room' ? snapshot.rooms : kind === 'track' ? snapshot.tracks : snapshot.formats;
	return collection.find((item) => item.id === id);
}

function conflict(
	kind: string,
	correlationId: string,
	className: 'conflict' | 'stale_revision' | 'idempotency_conflict' = 'conflict'
): EventProgramEffectResult<never> {
	return {
		kind: 'outcome',
		terminal: false,
		correlationId,
		outcome: {
			class: className,
			kind,
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		}
	};
}

export function createSampleEventProgramPort(input: {
	readonly fixture: EventProgramSampleFixture;
	readonly workspaceId?: string;
	readonly createId?: () => string;
	readonly createCorrelationId?: () => string;
}): ResettableEventProgramSampleComposition {
	const createId = input.createId ?? defaultId;
	const createCorrelationId = input.createCorrelationId ?? defaultId;
	const workspaceId = input.workspaceId ?? '550e8400-e29b-41d4-a716-446655440000';
	let currentEvent = currentEventProjectionSchema.parse(input.fixture.currentEvent);
	let vocabulary = input.fixture.vocabulary
		? programVocabularySnapshotSchema.parse(input.fixture.vocabulary)
		: null;
	const replay = new Map<string, ReplayEntry>();
	const pending = new Map<string, PendingVocabularyChange>();
	const reviewReplay = new Map<string, {
		readonly fingerprint: string;
		readonly result: ChangesetReviewResult<unknown>;
	}>();
	const approvalPolicy = Object.freeze({
		reference: Object.freeze({ key: 'approval.program_vocabulary.default', version: 1 }),
		definitionDigestSha256: 'b'.repeat(64),
		requirement: 'none' as const
	});

	function withIdempotency<T>(
		operation: string,
		key: string,
		businessInput: unknown,
		run: (correlationId: string) => EventProgramEffectResult<T>
	): EventProgramEffectResult<T> {
		const replayKey = `${operation}:${key}`;
		const bodyFingerprint = fingerprint(businessInput);
		const prior = replay.get(replayKey);
		if (prior) {
			return prior.fingerprint === bodyFingerprint
				? (prior.result as EventProgramEffectResult<T>)
				: conflict('operation.idempotency_conflict', createCorrelationId(), 'idempotency_conflict');
		}
		const result = run(createCorrelationId());
		replay.set(replayKey, { fingerprint: bodyFingerprint, result });
		return result;
	}

	function createEvent(
		businessInput: EventCreateInput,
		idempotencyKey: string
	): EventProgramEffectResult<{
		readonly eventSetVersion: number;
		readonly event: ReturnType<typeof mapEvent>;
	}> {
		return withIdempotency<{
			readonly eventSetVersion: number;
			readonly event: ReturnType<typeof mapEvent>;
		}>('event.create', idempotencyKey, businessInput, (correlationId) => {
			const parsed = eventCreateInputSchema.safeParse(businessInput);
			if (!parsed.success) return conflict('operation.invalid_input', correlationId);
			if (parsed.data.expectedEventSetVersion !== currentEvent.eventSetVersion) {
				return conflict('event.event_set_changed', correlationId, 'stale_revision');
			}
			if (currentEvent.kind === 'current_event') {
				return conflict('event.current_already_exists', correlationId);
			}

			const event = {
				id: createId(),
				name: parsed.data.name,
				timezone: parsed.data.timezone,
				startDate: parsed.data.startDate,
				endDate: parsed.data.endDate,
				version: 1
			};
			const eventSetVersion = currentEvent.eventSetVersion + 1;
			currentEvent = currentEventProjectionSchema.parse({
				schemaVersion: 1,
				kind: 'current_event',
				eventSetVersion,
				event
			});
			vocabulary = programVocabularySnapshotSchema.parse({
				schemaVersion: 1,
				scope: { workspaceId, eventId: event.id },
				setVersion: 1,
				rooms: [], tracks: [], formats: []
			});
			return {
				kind: 'success',
				data: Object.freeze({ eventSetVersion, event: mapEvent(event) }),
				receipt: { id: createId(), operationName: 'changeset.commit', operationVersion: 1 },
				correlationId
			};
		});
	}

	function buildSafeDiff(
		request: EventProgramDraftRequest,
		correlationId: string
	): ProgramVocabularySafeDiff | EventProgramEffectResult<never> {
		if (!vocabulary) return conflict('program_vocabulary.event_required', correlationId);
		if (request.input.expectedSetVersion !== vocabulary.setVersion) {
			return conflict('program_vocabulary.set_changed', correlationId, 'stale_revision');
		}

		switch (request.action) {
			case 'create': {
				const id = createId();
				const after = request.input.kind === 'room'
					? { kind: 'room' as const, id, name: request.input.name, status: 'active' as const,
						capacity: request.input.capacity, version: 1 }
					: request.input.kind === 'track'
						? { kind: 'track' as const, id, name: request.input.name,
							accent: deriveProgramTrackAccent(id), status: 'active' as const, version: 1 }
						: { kind: 'format' as const, id, name: request.input.name,
							status: 'active' as const, version: 1 };
				return { action: 'create', before: null, after };
			}
			case 'edit': {
				const before = itemFrom(vocabulary, request.input.kind, request.input.id);
				if (!before) return conflict('program_vocabulary.item_not_found', correlationId);
				if (before.version !== request.input.expectedItemVersion) {
					return conflict('program_vocabulary.item_changed', correlationId, 'stale_revision');
				}
				const after = before.kind === 'room' && request.input.kind === 'room'
					? { ...safeItem(before), name: request.input.changes.name,
						capacity: request.input.changes.capacity, version: before.version + 1 }
					: { ...safeItem(before), name: request.input.changes.name, version: before.version + 1 };
				return { action: 'edit', before: safeItem(before), after };
			}
			case 'retire':
			case 'restore': {
				const before = itemFrom(vocabulary, request.input.kind, request.input.id);
				if (!before) return conflict('program_vocabulary.item_not_found', correlationId);
				if (before.version !== request.input.expectedItemVersion) {
					return conflict('program_vocabulary.item_changed', correlationId, 'stale_revision');
				}
				return {
					action: request.action,
					before: safeItem(before),
					after: { ...safeItem(before),
						status: request.action === 'retire' ? 'retired' : 'active',
						version: before.version + 1 }
				};
			}
			case 'delete': {
				const before = itemFrom(vocabulary, request.input.kind, request.input.id);
				if (!before) return conflict('program_vocabulary.item_not_found', correlationId);
				if (before.version !== request.input.expectedItemVersion) {
					return conflict('program_vocabulary.item_changed', correlationId, 'stale_revision');
				}
				if (before.deleteEligibility.kind === 'blocked') {
					return conflict('program_vocabulary.delete_referenced', correlationId);
				}
				return { action: 'delete', before: safeItem(before), after: null, usage: before.usage };
			}
			case 'merge': {
				const source = itemFrom(vocabulary, request.input.kind, request.input.sourceId);
				const target = itemFrom(vocabulary, request.input.kind, request.input.targetId);
				if (!source || !target) return conflict('program_vocabulary.item_not_found', correlationId);
				if (
					source.version !== request.input.expectedSourceVersion ||
					target.version !== request.input.expectedTargetVersion
				) return conflict('program_vocabulary.item_changed', correlationId, 'stale_revision');
				return {
					action: 'merge',
					sourceBefore: safeItem(source),
					sourceAfter: { ...safeItem(source), status: 'retired', version: source.version + 1 },
					target: safeItem(target),
					liveRepoints: source.usage.current,
					historicalPinsPreserved: source.usage.historicalPins
				};
			}
	}
	}

	function draftVocabulary(
		request: EventProgramDraftRequest,
		idempotencyKey: string
	): EventProgramEffectResult<ReturnType<typeof mapProgramVocabularyDraft>> {
		return withIdempotency<ReturnType<typeof mapProgramVocabularyDraft>>(
			`program_vocabulary.${request.action}.draft`,
			idempotencyKey,
			request.input,
			(correlationId) => {
				const safeDiff = buildSafeDiff(request, correlationId);
				if ('kind' in safeDiff) return safeDiff;
				const changesetId = createId();
				const revisionId = createId();
				const riskTier = request.action === 'delete' || request.action === 'merge'
					? 'normal' as const
					: 'low' as const;
				const data = programVocabularyDraftDataSchema.parse({
					schemaVersion: 1,
					action: request.action,
					changesetId,
					headVersion: 1,
					status: 'draft',
					revision: { id: revisionId, number: 1, digestSha256: digest(revisionId) },
					riskTier,
					approvalPolicy,
					safeDiff
				});
				pending.set(changesetId, {
					request,
					changesetId,
					revisionId,
					revisionDigest: data.revision.digestSha256,
					riskTier,
					safeDiff,
					status: 'draft',
					headVersion: 1
				});
				return {
					kind: 'success',
					data: mapProgramVocabularyDraft(data),
					receipt: {
						id: createId(),
						operationName: `program_vocabulary.${request.action}.draft`,
						operationVersion: 1
					},
					correlationId
				};
			}
		);
	}

	function readPending(selector: ChangesetRevisionSelector): PendingVocabularyChange | null {
		const parsed = changesetRevisionSelectorSchema.safeParse({
			changesetId: selector.changesetId,
			revisionId: selector.revisionId,
			revisionDigest: selector.revisionDigest
		});
		if (!parsed.success) return null;
		const change = pending.get(parsed.data.changesetId);
		return change
			&& change.revisionId === parsed.data.revisionId
			&& change.revisionDigest === parsed.data.revisionDigest
			? change
			: null;
	}

	function reviewOutcome<Data>(kind: string, changesetId: string): ChangesetReviewResult<Data> {
		return {
			kind: 'outcome',
			terminal: false,
			correlationId: createCorrelationId(),
			outcome: {
				class: 'stale_revision',
				kind,
				retryable: false,
				subjects: [{ type: 'changeset', id: changesetId }],
				detail: null,
				detailSchemaVersion: 1
			}
		};
	}

	function mappedDiff(change: PendingVocabularyChange) {
		return mapChangesetDiff(changesetDiffDataSchema.parse({
			changesetId: change.changesetId,
			headVersion: change.headVersion,
			status: change.status,
			revisionId: change.revisionId,
			revisionNumber: 1,
			revisionDigest: change.revisionDigest,
			riskTier: change.riskTier,
			approvalPolicy,
			operations: [{
				kind: 'program.vocabulary.mutate',
				version: 1,
				riskTier: change.riskTier,
				dependencyGroup: 'program_vocabulary',
				safeDiff: change.safeDiff,
				consequences: ['program_vocabulary_changed']
			}]
		}));
	}

	function deleteEligibility(current: number, historicalPins: number) {
		return current === 0 && historicalPins === 0
			? { kind: 'eligible' as const }
			: { kind: 'blocked' as const, currentReferences: current, historicalPins };
	}

	function replaceItem(
		snapshot: ProgramVocabularySnapshotDto,
		item: ProgramVocabularyItemDto
	): ProgramVocabularySnapshotDto {
		const collection = item.kind === 'room' ? 'rooms' : item.kind === 'track' ? 'tracks' : 'formats';
		return programVocabularySnapshotSchema.parse({
			...snapshot,
			setVersion: snapshot.setVersion + 1,
			[collection]: snapshot[collection]
				.map((candidate) => candidate.id === item.id ? item : candidate)
				.sort((left, right) => left.id.localeCompare(right.id))
		});
	}

	function applyChange(change: PendingVocabularyChange): boolean {
		if (!vocabulary || vocabulary.setVersion !== change.request.input.expectedSetVersion) return false;
		const diff = change.safeDiff;
		switch (diff.action) {
			case 'create': {
				const created = diff.after.kind === 'room'
					? { ...diff.after, usage: { current: 0, historicalPins: 0 },
						deleteEligibility: { kind: 'eligible' as const } }
					: { ...diff.after, usage: { current: 0, historicalPins: 0 },
						deleteEligibility: { kind: 'eligible' as const } };
				const collection = created.kind === 'room' ? 'rooms' : created.kind === 'track' ? 'tracks' : 'formats';
				vocabulary = programVocabularySnapshotSchema.parse({
					...vocabulary,
					setVersion: vocabulary.setVersion + 1,
					[collection]: [...vocabulary[collection], created]
						.sort((left, right) => left.id.localeCompare(right.id))
				});
				return true;
			}
			case 'edit':
			case 'retire':
			case 'restore': {
				const before = itemFrom(vocabulary, diff.before.kind, diff.before.id);
				if (!before || before.kind !== diff.after.kind) return false;
				const after = before.kind === 'room' && diff.after.kind === 'room'
					? { ...before, ...diff.after }
					: before.kind !== 'room' && diff.after.kind !== 'room'
						? { ...before, ...diff.after }
						: null;
				if (!after) return false;
				vocabulary = replaceItem(vocabulary, after);
				return true;
			}
			case 'delete': {
				const collection = diff.before.kind === 'room'
					? 'rooms' : diff.before.kind === 'track' ? 'tracks' : 'formats';
				if (!vocabulary[collection].some((item) => item.id === diff.before.id)) return false;
				vocabulary = programVocabularySnapshotSchema.parse({
					...vocabulary,
					setVersion: vocabulary.setVersion + 1,
					[collection]: vocabulary[collection].filter((item) => item.id !== diff.before.id)
				});
				return true;
			}
			case 'merge': {
				const source = itemFrom(vocabulary, diff.sourceBefore.kind, diff.sourceBefore.id);
				const target = itemFrom(vocabulary, diff.target.kind, diff.target.id);
				if (!source || !target || source.kind !== target.kind) return false;
				const sourceUsage = { current: 0, historicalPins: source.usage.historicalPins };
				const targetUsage = {
					current: target.usage.current + diff.liveRepoints,
					historicalPins: target.usage.historicalPins
				};
				const updatedSource = {
					...source,
					status: 'retired' as const,
					version: source.version + 1,
					usage: sourceUsage,
					deleteEligibility: deleteEligibility(sourceUsage.current, sourceUsage.historicalPins)
				};
				const updatedTarget = {
					...target,
					usage: targetUsage,
					deleteEligibility: deleteEligibility(targetUsage.current, targetUsage.historicalPins)
				};
				const collection = source.kind === 'room' ? 'rooms' : source.kind === 'track' ? 'tracks' : 'formats';
				vocabulary = programVocabularySnapshotSchema.parse({
					...vocabulary,
					setVersion: vocabulary.setVersion + 1,
					[collection]: vocabulary[collection].map((item) =>
						item.id === source.id ? updatedSource : item.id === target.id ? updatedTarget : item
					)
				});
				return true;
			}
			case 'merge_compensation':
				return false;
		}
	}

	function reviewEffectReplay<Data>(
		action: 'propose' | 'commit',
		key: string,
		businessInput: ChangesetReviewEffectInput,
		run: () => ChangesetReviewResult<Data>
	): ChangesetReviewResult<Data> {
		const slot = `${action}:${key}`;
		const requestFingerprint = fingerprint(businessInput);
		const prior = reviewReplay.get(slot);
		if (prior) {
			return prior.fingerprint === requestFingerprint
				? prior.result as ChangesetReviewResult<Data>
				: reviewOutcome('operation.idempotency_conflict', businessInput.changesetId);
		}
		const result = run();
		reviewReplay.set(slot, { fingerprint: requestFingerprint, result });
		return result;
	}

	const changesets: ResettableEventProgramSampleComposition['changesets'] = Object.freeze({
		source: Object.freeze({ kind: 'sample' as const, label: 'Sample data' as const }),
		async readDiff(
			selector: ChangesetRevisionSelector,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ChangesetReviewResult<ChangesetDiffView>> {
			options.signal?.throwIfAborted();
			const change = readPending(selector);
			return change
				? { kind: 'success' as const, data: mappedDiff(change), correlationId: createCorrelationId() }
				: reviewOutcome('changeset.revision_missing', selector.changesetId);
		},
		async propose(
			effectInput: ChangesetReviewEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ChangesetReviewResult<ChangesetDiffView>> {
			options.signal?.throwIfAborted();
			return reviewEffectReplay<ChangesetDiffView>('propose', key, effectInput, () => {
				const change = readPending(effectInput);
				if (!change || change.status !== 'draft' || change.headVersion !== effectInput.expectedHeadVersion) {
					return reviewOutcome('changeset.lifecycle_refused', effectInput.changesetId);
				}
				change.status = 'proposed';
				change.headVersion += 1;
				return {
					kind: 'success',
					data: mappedDiff(change),
					correlationId: createCorrelationId(),
					receipt: { id: createId(), operationName: 'changeset.propose', operationVersion: 1 }
				};
			});
		},
		async commit(
			effectInput: ChangesetReviewEffectInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ChangesetReviewResult<ChangesetCommitView>> {
			options.signal?.throwIfAborted();
			return reviewEffectReplay<ChangesetCommitView>('commit', key, effectInput, () => {
				const change = readPending(effectInput);
				if (!change || change.status !== 'proposed' || change.headVersion !== effectInput.expectedHeadVersion
					|| !applyChange(change)) {
					return reviewOutcome('changeset.lifecycle_refused', effectInput.changesetId);
				}
				change.status = 'committed';
				change.headVersion += 1;
				const data = committedChangesetDataSchema.parse({
					schemaVersion: 1,
					action: 'commit',
					changesetId: change.changesetId,
					expectedHeadVersion: effectInput.expectedHeadVersion,
					committedHeadVersion: change.headVersion,
					revisionId: change.revisionId,
					revisionDigest: change.revisionDigest
				});
				return {
					kind: 'success',
					data: mapChangesetCommit(data),
					correlationId: createCorrelationId(),
					receipt: { id: createId(), operationName: 'changeset.commit', operationVersion: 1 }
				};
			});
		}
	}) satisfies ChangesetReviewPort;

	const port = Object.freeze({
		source: Object.freeze({ kind: 'sample' as const, label: input.fixture.label, resettable: true as const }),
		event: Object.freeze({
			async read(options: { readonly signal?: AbortSignal } = {}) {
				options.signal?.throwIfAborted();
				return {
					kind: 'success' as const,
					data: mapCurrentEvent(currentEvent),
					correlationId: createCorrelationId()
				};
			},
			async create(
				businessInput: EventCreateInput,
				options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
			) {
				options.signal?.throwIfAborted();
				return createEvent(businessInput, options.idempotencyKey);
			}
		}),
		vocabulary: Object.freeze({
			async read(options: { readonly signal?: AbortSignal } = {}) {
				options.signal?.throwIfAborted();
				const correlationId = createCorrelationId();
				return vocabulary
					? { kind: 'success' as const, data: mapProgramVocabularySnapshot(vocabulary), correlationId }
					: {
							kind: 'outcome' as const,
							correlationId,
							outcome: {
								class: 'conflict' as const,
								kind: 'program_vocabulary.event_required',
								retryable: false,
								subjects: [],
								detail: null,
								detailSchemaVersion: 1
							}
						};
			},
			async draft(
				request: EventProgramDraftRequest,
				options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
			) {
				options.signal?.throwIfAborted();
				return draftVocabulary(request, options.idempotencyKey);
			}
		})
	}) satisfies EventProgramPort & {
		readonly source: { readonly kind: 'sample'; readonly label: string; readonly resettable: true };
	};

	return Object.freeze({
		port,
		changesets,
		reset() {
			currentEvent = currentEventProjectionSchema.parse(input.fixture.currentEvent);
			vocabulary = input.fixture.vocabulary
				? programVocabularySnapshotSchema.parse(input.fixture.vocabulary)
				: null;
			replay.clear();
			pending.clear();
			reviewReplay.clear();
		}
	});
}
