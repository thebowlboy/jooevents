import {
  operationHttpIdempotencyKeySchema,
  SESSION_SUBMISSION_ROUTE_SCHEMA_REFS,
  sessionSubmissionRouteInputSchema,
  sessionSubmissionRouteOperationResultSchema,
  type OperationReceiptRef,
  type SessionSubmissionRouteInput,
  type SessionSubmissionRouteResultData,
  type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
  resolveOperatorHttpBinding,
  type ExpectedOperatorHttpOperation,
  type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SESSION_SUBMISSION_ROUTE_LIVE_OPERATION = Object.freeze({
  name: 'session.submission.route', version: 1, effect: 'commit', method: 'POST',
  input: 'body', idempotencyRequired: true,
  path: '/api/events/current/session-submission-routes'
} as const);

const EXPECTED = Object.freeze({
  ...SESSION_SUBMISSION_ROUTE_LIVE_OPERATION,
  ...SESSION_SUBMISSION_ROUTE_SCHEMA_REFS
} satisfies ExpectedOperatorHttpOperation & { readonly path: string });

export type SessionSubmissionRouteApplyResult =
  | {
      readonly kind: 'success';
      readonly data: SessionSubmissionRouteResultData;
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

export interface SessionSubmissionRoutePort {
  readonly source: { readonly kind: 'live' };
  apply(
    input: SessionSubmissionRouteInput,
    idempotencyKey: string,
    options?: { readonly signal?: AbortSignal }
  ): Promise<SessionSubmissionRouteApplyResult>;
}

export interface SessionSubmissionRouteRequestInput {
  readonly path: string;
  readonly schema: z.ZodType;
  readonly method: 'POST';
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export type SessionSubmissionRouteRequester = (
  input: SessionSubmissionRouteRequestInput
) => Promise<ApiResult<unknown>>;

const defaultRequester: SessionSubmissionRouteRequester = (input) => requestJson(input);

export function createSessionSubmissionRouteLivePort(input: {
  readonly manifest: unknown;
  readonly request?: SessionSubmissionRouteRequester;
}): SessionSubmissionRoutePort {
  const resolved = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED });
  const binding = resolved.kind === 'available' && resolved.path !== EXPECTED.path
    ? { kind: 'unavailable' as const, reason: 'operation_contract_mismatch' as const }
    : resolved;
  const request = input.request ?? defaultRequester;
  return Object.freeze({
    source: Object.freeze({ kind: 'live' as const }),
    async apply(
      raw: SessionSubmissionRouteInput,
      key: string,
      options: { readonly signal?: AbortSignal } = {}
    ): Promise<SessionSubmissionRouteApplyResult> {
      const author = sessionSubmissionRouteInputSchema.safeParse(raw);
      if (!author.success || !operationHttpIdempotencyKeySchema.safeParse(key).success) {
        return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
      }
      if (binding.kind === 'unavailable') {
        return { kind: 'unavailable' as const, reason: binding.reason };
      }
      const response = await request({
        path: binding.path,
        method: 'POST',
        schema: sessionSubmissionRouteOperationResultSchema,
        body: author.data,
        idempotencyKey: key,
        ...(options.signal ? { signal: options.signal } : {})
      });
      if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
      const parsed = sessionSubmissionRouteOperationResultSchema.safeParse(response.data);
      if (!parsed.success) {
        return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
      }
      if (parsed.data.kind === 'outcome') return parsed.data;
      if (parsed.data.receipt.operationName !== SESSION_SUBMISSION_ROUTE_LIVE_OPERATION.name
          || parsed.data.receipt.operationVersion !== SESSION_SUBMISSION_ROUTE_LIVE_OPERATION.version
          || parsed.data.data.action !== author.data.action) {
        return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
      }
      return parsed.data as SessionSubmissionRouteApplyResult;
    }
  });
}
