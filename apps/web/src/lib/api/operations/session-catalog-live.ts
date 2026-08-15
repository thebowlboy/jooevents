import {
	changesetRevisionSelectorSchema,
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef
} from '@jooevents/contracts';
import {
	SESSION_OPERATION_SCHEMA_REFS,
	sessionAuthorInputSchema,
	sessionCatalogReadResultSchema,
	sessionDraftOperationResultSchema,
	sessionSafeDiffSchema,
	type SessionAuthorInput,
	type SessionDraftData
} from '@jooevents/contracts/sessions';
import type { z } from 'zod';
import {
	CHANGESET_REVIEW_OPERATIONS,
	createChangesetReviewLivePort
} from '../changesets/live';
import type { ChangesetDiffView, ChangesetReviewResult } from '../changesets/port';
import { requestJson, type ApiResult } from '../client';
import { mapSessionCatalog, mapSessionChangeCommit } from '../mappers/session';
import type {
	SessionCatalogCoreOperation,
	SessionCatalogCorePort,
	SessionCatalogReadResult,
	SessionChangeApplyResult
} from '../session-catalog-port';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SESSION_CATALOG_LIVE_OPERATIONS = Object.freeze({
	catalog: Object.freeze({
		name: 'session.catalog.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/events/current/sessions'
	} as const),
	draft: Object.freeze({
		name: 'session.change.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/sessions/drafts'
	} as const)
});

type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

const EXPECTED_OPERATIONS = Object.freeze({
	catalog: Object.freeze({
		...SESSION_CATALOG_LIVE_OPERATIONS.catalog,
		...SESSION_OPERATION_SCHEMA_REFS.catalogRead
	}),
	draft: Object.freeze({
		...SESSION_CATALOG_LIVE_OPERATIONS.draft,
		...SESSION_OPERATION_SCHEMA_REFS.draft
	})
} satisfies Readonly<Record<'catalog' | 'draft', ExactExpectedOperation>>);

const EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS = Object.freeze({
	propose: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.propose,
		path: '/api/changesets/proposals'
	}),
	commit: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.commit,
		path: '/api/changesets/commits'
	})
} satisfies Readonly<Record<'propose' | 'commit', ExactExpectedOperation>>);

export interface SessionCatalogRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type SessionCatalogRequester = (
	input: SessionCatalogRequestInput
) => Promise<ApiResult<unknown>>;

function defaultRequester(input: SessionCatalogRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function resolveExactBinding(
	manifest: unknown,
	expected: ExactExpectedOperation
): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	if (binding.kind === 'available' && binding.path !== expected.path) {
		return { kind: 'unavailable', reason: 'operation_contract_mismatch' };
	}
	return binding;
}

function unavailable(
	operation: SessionCatalogCoreOperation,
	reason: OperatorHttpBindingUnavailableReason
) {
	return { kind: 'unavailable' as const, operation, reason };
}

function invalidRequest(): SessionChangeApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): SessionChangeApplyResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function invalidReadContract(): SessionCatalogReadResult {
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
	return JSON.stringify(left) === JSON.stringify(right);
}

function draftMatchesRequest(draft: SessionDraftData, request: SessionAuthorInput): boolean {
	const diff = draft.safeDiff;
	if (draft.action !== request.action || diff.action !== request.action) return false;
	if (request.action === 'create') {
		return diff.before === null
			&& diff.after !== null
			&& diff.after.version === 1
			&& diff.after.title === request.title
			&& diff.after.plannedDurationMinutes === request.plannedDurationMinutes
			&& diff.after.lifecycle === request.lifecycle
			&& diff.after.programTarget.format.id === request.formatId
			// A null request means "use the deterministic event default": the
			// domain preserves null for drafts/track-free events and resolves the
			// sole active track for operational sessions.
			&& (request.trackId === null
				|| diff.after.programTarget.track?.id === request.trackId);
	}
	if (request.action === 'roster_visibility') {
		return diff.before !== null
			&& diff.after !== null
			&& diff.before.id === request.sessionId
			&& diff.before.version === request.expectedSessionVersion
			&& diff.before.digestSha256 === request.expectedSessionDigestSha256
			&& diff.after.id === diff.before.id
			&& diff.after.version === diff.before.version + 1
			&& diff.after.lifecycle === diff.before.lifecycle
			&& diff.after.roster.participants.some(
				(participant) =>
					participant.personId === request.personId
					&& participant.publiclyVisible === request.publiclyVisible
			);
	}
	if (request.action === 'retarget') {
		return diff.before !== null
			&& diff.after !== null
			&& diff.before.id === request.sessionId
			&& diff.before.version === request.expectedSessionVersion
			&& diff.before.digestSha256 === request.expectedSessionDigestSha256
			&& diff.after.id === diff.before.id
			&& diff.after.version === diff.before.version + 1
			&& diff.after.lifecycle === diff.before.lifecycle
			&& diff.after.programTarget.format.id === request.formatId
			&& (request.trackId === null
				|| diff.after.programTarget.track?.id === request.trackId);
	}
	return diff.before !== null
		&& diff.after !== null
		&& diff.before.id === request.sessionId
		&& diff.before.version === request.expectedSessionVersion
		&& diff.before.digestSha256 === request.expectedSessionDigestSha256
		&& diff.after.id === diff.before.id
		&& diff.after.version === diff.before.version + 1
		&& diff.after.lifecycle === request.to
		&& diff.after.title === diff.before.title
		&& diff.after.plannedDurationMinutes === diff.before.plannedDurationMinutes;
}

function proposedDiffMatchesDraft(
	proposed: ChangesetDiffView,
	draft: SessionDraftData
): boolean {
	if (proposed.selector.changesetId !== draft.changesetId
		|| proposed.selector.revisionId !== draft.revision.id
		|| proposed.selector.revisionDigest !== draft.revision.digestSha256
		|| proposed.headVersion !== draft.headVersion + 1
		|| proposed.status.value !== 'proposed'
		|| proposed.revisionNumber !== draft.revision.number
		|| proposed.risk.value !== 'normal'
		|| proposed.approval.requirement !== 'none'
		|| proposed.operationCount !== 1
		|| proposed.groups.length !== 1) {
		return false;
	}
	const group = proposed.groups[0];
	const operation = group?.operations[0];
	if (!group
		|| group.key !== 'session'
		|| group.operations.length !== 1
		|| group.risk.value !== 'normal'
		|| !operation
		|| operation.kind !== 'session.mutate'
		|| operation.version !== 1
		|| operation.risk.value !== 'normal'
		|| operation.dependencyGroup !== 'session'
		|| operation.consequences.length !== 1
		|| operation.consequences[0] !== 'session_changed') {
		return false;
	}
	const parsed = sessionSafeDiffSchema.safeParse(operation.safeDiff);
	return parsed.success && sameJson(parsed.data, draft.safeDiff);
}

async function workflowIdempotencyKeys(
	rawKey: string
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
		draft: `je.session.change.draft.${anchor}`,
		propose: `je.session.change.propose.${anchor}`,
		commit: `je.session.change.commit.${anchor}`
	});
}

function mapChangesetFailure(
	result: Exclude<ChangesetReviewResult<unknown>, { readonly kind: 'success' }>,
	operation: 'propose' | 'commit'
): SessionChangeApplyResult {
	if (result.kind === 'unavailable') return unavailable(operation, result.reason);
	if (result.kind === 'transport_error') return result;
	const expected = CHANGESET_REVIEW_OPERATIONS[operation];
	if (typeof result.terminal !== 'boolean'
		|| (result.terminal && !receiptMatches(result.receipt, expected))
		|| (!result.terminal && result.receipt !== undefined)) {
		return invalidContract();
	}
	return {
		kind: 'outcome',
		outcome: result.outcome,
		terminal: result.terminal,
		...(result.receipt ? { receipt: result.receipt } : {}),
		correlationId: result.correlationId
	};
}

/**
 * Pure-live Session catalog client. It invokes only exact manifest-pinned
 * operations and applies one authored change through the inert Session draft
 * followed by the generic changeset propose and commit lifecycle. The author
 * schema alone carries the forward-only domain rule: a transition target can
 * only be 'collecting' or 'programmed', so no request that asks for 'draft'
 * (or the internal 'restore') ever leaves this port.
 */
export function createSessionCatalogLivePort(input: {
	readonly manifest: unknown;
	readonly request?: SessionCatalogRequester;
}): SessionCatalogCorePort {
	const catalogBinding = resolveExactBinding(input.manifest, EXPECTED_OPERATIONS.catalog);
	const draftBinding = resolveExactBinding(input.manifest, EXPECTED_OPERATIONS.draft);
	const proposeBinding = resolveExactBinding(
		input.manifest,
		EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS.propose
	);
	const commitBinding = resolveExactBinding(
		input.manifest,
		EXPECTED_CHANGESET_LIFECYCLE_OPERATIONS.commit
	);
	const request = input.request ?? defaultRequester;
	const changesets = createChangesetReviewLivePort({
		manifest: input.manifest,
		request: (requestInput) => request(requestInput)
	});

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readCatalog(options = {}) {
			if (catalogBinding.kind === 'unavailable') {
				return unavailable('catalog', catalogBinding.reason);
			}
			const response = await request({
				path: catalogBinding.path,
				method: 'GET',
				schema: sessionCatalogReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = sessionCatalogReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidReadContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			try {
				return {
					kind: 'success',
					data: mapSessionCatalog(parsed.data.data),
					correlationId: parsed.data.correlationId
				};
			} catch {
				return invalidReadContract();
			}
		},

		async applyChange(rawRequest, rawIdempotencyKey, options = {}) {
			const parsedRequest = sessionAuthorInputSchema.safeParse(rawRequest);
			const keys = await workflowIdempotencyKeys(rawIdempotencyKey);
			if (!parsedRequest.success || !keys) return invalidRequest();
			if (draftBinding.kind === 'unavailable') {
				return unavailable('draft', draftBinding.reason);
			}
			if (proposeBinding.kind === 'unavailable') {
				return unavailable('propose', proposeBinding.reason);
			}
			if (commitBinding.kind === 'unavailable') {
				return unavailable('commit', commitBinding.reason);
			}

			const draftedResponse = await request({
				path: draftBinding.path,
				method: 'POST',
				schema: sessionDraftOperationResultSchema,
				body: parsedRequest.data,
				idempotencyKey: keys.draft,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (draftedResponse.kind === 'error') {
				return { kind: 'transport_error', error: draftedResponse.error };
			}
			const drafted = sessionDraftOperationResultSchema.safeParse(draftedResponse.data);
			if (!drafted.success) return invalidContract();
			if (drafted.data.kind === 'outcome') {
				if (drafted.data.terminal
					&& !receiptMatches(drafted.data.receipt, SESSION_CATALOG_LIVE_OPERATIONS.draft)) {
					return invalidContract();
				}
				return drafted.data;
			}
			if (!receiptMatches(drafted.data.receipt, SESSION_CATALOG_LIVE_OPERATIONS.draft)
				|| !draftMatchesRequest(drafted.data.data, parsedRequest.data)) {
				return invalidContract();
			}

			const parsedSelector = changesetRevisionSelectorSchema.safeParse({
				changesetId: drafted.data.data.changesetId,
				revisionId: drafted.data.data.revision.id,
				revisionDigest: drafted.data.data.revision.digestSha256
			});
			if (!parsedSelector.success) return invalidContract();
			const selector = Object.freeze(parsedSelector.data);
			const proposed = await changesets.propose({
				...selector,
				expectedHeadVersion: drafted.data.data.headVersion
			}, keys.propose, options);
			if (proposed.kind !== 'success') return mapChangesetFailure(proposed, 'propose');
			if (!receiptMatches(proposed.receipt, CHANGESET_REVIEW_OPERATIONS.propose)
				|| !proposedDiffMatchesDraft(proposed.data, drafted.data.data)) {
				return invalidContract();
			}

			const committed = await changesets.commit({
				...selector,
				expectedHeadVersion: proposed.data.headVersion
			}, keys.commit, options);
			if (committed.kind !== 'success') return mapChangesetFailure(committed, 'commit');
			if (!receiptMatches(committed.receipt, CHANGESET_REVIEW_OPERATIONS.commit)) {
				return invalidContract();
			}
			try {
				return {
					kind: 'success',
					data: mapSessionChangeCommit({
						draft: drafted.data.data,
						proposedHeadVersion: proposed.data.headVersion,
						committedHeadVersion: committed.data.committedHeadVersion
					}),
					receipt: committed.receipt,
					correlationId: committed.correlationId ?? drafted.data.correlationId
				};
			} catch {
				return invalidContract();
			}
		}
	} satisfies SessionCatalogCorePort);
}
