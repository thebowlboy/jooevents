import {
	ENGAGEMENT_OPERATION_SCHEMA_REFS,
	engagementAuthorInputSchema,
	engagementChangeOperationResultSchema,
	engagementSnapshotReadResultSchema,
	speakerPersonHistoryInputSchema,
	speakerPersonHistoryReadResultSchema,
	speakerLineupAuthorInputSchema,
	speakerLineupChangeOperationResultSchema,
	speakerLineupSnapshotReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type EngagementAuthorInput,
	type EngagementChangeData,
	type EngagementSnapshotDto,
	type SpeakerLineupAuthorInput,
	type SpeakerLineupChangeData,
	type SpeakerLineupSnapshotDto,
	type SpeakerPersonHistoryPageDto,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { resolveOperatorHttpBinding, type ExpectedOperatorHttpOperation, type OperatorHttpBindingUnavailableReason } from './operator-http-binding';

export const ENGAGEMENTS_LIVE_OPERATIONS = Object.freeze({
	read: { name: 'engagement.snapshot.read', version: 1 },
	change: { name: 'engagement.change', version: 1 },
	lineupRead: { name: 'speaker-lineup.snapshot.read', version: 1 },
	personHistoryRead: { name: 'speaker.person-history.read', version: 1 },
	lineupChange: { name: 'speaker-lineup.change', version: 1 }
} as const);
const EXPECTED_OPERATIONS = Object.freeze({
	read: { ...ENGAGEMENTS_LIVE_OPERATIONS.read, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead },
	change: { ...ENGAGEMENTS_LIVE_OPERATIONS.change, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.change },
	lineupRead: { ...ENGAGEMENTS_LIVE_OPERATIONS.lineupRead, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.lineupSnapshotRead },
	personHistoryRead: { ...ENGAGEMENTS_LIVE_OPERATIONS.personHistoryRead, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead },
	lineupChange: { ...ENGAGEMENTS_LIVE_OPERATIONS.lineupChange, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.lineupChange }
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);
export type EngagementsLiveOperation = keyof typeof EXPECTED_OPERATIONS;
type Unavailable = { readonly kind: 'unavailable'; readonly operation: EngagementsLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
export type EngagementsLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type EngagementsCommittedResponse = EngagementChangeData;
export type SpeakerLineupCommittedResponse = SpeakerLineupChangeData;
export type EngagementsLiveRespondResult =
	| { readonly kind: 'success'; readonly data: EngagementsCommittedResponse; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SpeakerLineupLiveChangeResult =
	| { readonly kind: 'success'; readonly data: SpeakerLineupCommittedResponse; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface EngagementsLiveRequestInput { readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST'; readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal }
export type EngagementsLiveRequester = (input: EngagementsLiveRequestInput) => Promise<ApiResult<unknown>>;
export interface EngagementsLiveClient {
	readSnapshot(options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>>;
	respond(input: EngagementAuthorInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveRespondResult>;
	readLineup(options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveReadResult<SpeakerLineupSnapshotDto>>;
	changeLineup(input: SpeakerLineupAuthorInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerLineupLiveChangeResult>;
}
export interface EngagementsWithPersonHistoryLiveClient extends EngagementsLiveClient {
	readPersonHistory(personId: string, options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveReadResult<readonly SpeakerPersonHistoryPageDto['entries'][number][]>>;
}
const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createEngagementsLiveClient(input: { readonly manifest: unknown; readonly request?: EngagementsLiveRequester }): EngagementsWithPersonHistoryLiveClient {
	const request = input.request ?? ((value: EngagementsLiveRequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.read });
	const change = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.change });
	const lineupRead = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.lineupRead });
	const personHistoryRead = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.personHistoryRead });
	const lineupChange = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.lineupChange });
	return Object.freeze({
		async readSnapshot(options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>> {
			if (read.kind === 'unavailable') return { kind: 'unavailable', operation: 'read', reason: read.reason };
			const response = await request({ path: read.path, method: 'GET', schema: engagementSnapshotReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementSnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async respond(raw: EngagementAuthorInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveRespondResult> {
			const body = engagementAuthorInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (change.kind === 'unavailable') return { kind: 'unavailable', operation: 'change', reason: change.reason };
			const response = await request({ path: change.path, method: 'POST', schema: engagementChangeOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementChangeOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== ENGAGEMENTS_LIVE_OPERATIONS.change.name || parsed.data.data.action !== body.data.action) return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		},
		async readLineup(options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveReadResult<SpeakerLineupSnapshotDto>> {
			if (lineupRead.kind === 'unavailable') return { kind: 'unavailable', operation: 'lineupRead', reason: lineupRead.reason };
			const response = await request({ path: lineupRead.path, method: 'GET', schema: speakerLineupSnapshotReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = speakerLineupSnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async readPersonHistory(personId: string, options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveReadResult<readonly SpeakerPersonHistoryPageDto['entries'][number][]>> {
			if (personHistoryRead.kind === 'unavailable') return { kind: 'unavailable', operation: 'personHistoryRead', reason: personHistoryRead.reason };
			const entries: SpeakerPersonHistoryPageDto['entries'][number][] = [];
			let cursor: SpeakerPersonHistoryPageDto['next'] = null;
			let correlationId = '';
			do {
				const businessInput = speakerPersonHistoryInputSchema.safeParse({
					personId,
					...(cursor ? { beforeOccurredAt: cursor.occurredAt, beforeId: cursor.id } : {})
				});
				if (!businessInput.success) return invalidRequest();
				const query = new URLSearchParams(businessInput.data as Record<string, string>);
				const response = await request({
					path: `${personHistoryRead.path}?${query.toString()}`,
					method: 'GET', schema: speakerPersonHistoryReadResultSchema,
					...(options.signal ? { signal: options.signal } : {})
				});
				if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
				const parsed = speakerPersonHistoryReadResultSchema.safeParse(response.data);
				if (!parsed.success) return invalidContract();
				if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
				correlationId = parsed.data.correlationId;
				const page = parsed.data.data;
				if (entries.length > 0 && page.entries.length > 0) {
					const previous = entries.at(-1)!;
					const current = page.entries[0]!;
					if (previous.occurredAt < current.occurredAt
						|| (previous.occurredAt === current.occurredAt && previous.id <= current.id)) return invalidContract();
				}
				entries.push(...page.entries);
				if (page.next !== null && cursor !== null
					&& (page.next.occurredAt > cursor.occurredAt
						|| (page.next.occurredAt === cursor.occurredAt && page.next.id >= cursor.id))) return invalidContract();
				cursor = page.next;
			} while (cursor !== null);
			return { kind: 'success', data: Object.freeze(entries), correlationId };
		},
		async changeLineup(raw: SpeakerLineupAuthorInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<SpeakerLineupLiveChangeResult> {
			const body = speakerLineupAuthorInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (lineupChange.kind === 'unavailable') return { kind: 'unavailable', operation: 'lineupChange', reason: lineupChange.reason };
			const response = await request({ path: lineupChange.path, method: 'POST', schema: speakerLineupChangeOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = speakerLineupChangeOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== ENGAGEMENTS_LIVE_OPERATIONS.lineupChange.name || parsed.data.data.action !== body.data.action) return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
