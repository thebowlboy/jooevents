import {
	CALENDAR_NOTICE_OPERATION_SCHEMA_REFS,
	calendarNoticeGenerationControlInputSchema,
	calendarNoticeGenerationControlOperationResultSchema,
	calendarNoticeGenerationListOperationResultSchema,
	type CalendarNoticeGenerationControlInput,
	type CalendarNoticeGenerationDto
} from '@jooevents/contracts/calendar';
import type { OperationReceiptRef, StructuredOutcome } from '@jooevents/contracts';
import { requestJson, type SafeApiError } from '../client';
import { resolveOperatorHttpBinding } from './operator-http-binding';

type ReadResult =
	| { readonly kind: 'success'; readonly data: readonly CalendarNoticeGenerationDto[] }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: string };

type ControlResult =
	| { readonly kind: 'success'; readonly data: CalendarNoticeGenerationDto; readonly receipt: OperationReceiptRef }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: string };

export interface CalendarNoticesLiveClient {
	list(): Promise<ReadResult>;
	control(input: CalendarNoticeGenerationControlInput): Promise<ControlResult>;
}

export function createCalendarNoticesLiveClient(input: {
	readonly manifest: unknown;
}): CalendarNoticesLiveClient {
	const list = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			name: 'calendar.notice-generations.list', version: 1, effect: 'read',
			method: 'GET', input: 'query', idempotencyRequired: false,
			...CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.list
		}
	});
	const control = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			name: 'calendar.notice-generations.control', version: 1, effect: 'commit',
			method: 'POST', input: 'body', idempotencyRequired: true,
			...CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.control
		}
	});
	return Object.freeze({
		async list(): Promise<ReadResult> {
			if (list.kind === 'unavailable') return { kind: 'unavailable', reason: list.reason };
			const response = await requestJson({
				path: list.path, method: 'GET', schema: calendarNoticeGenerationListOperationResultSchema
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = calendarNoticeGenerationListOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return {
				kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
			};
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data.rows }
				: { kind: 'outcome', outcome: parsed.data.outcome };
		},
		async control(raw: CalendarNoticeGenerationControlInput): Promise<ControlResult> {
			const command = calendarNoticeGenerationControlInputSchema.safeParse(raw);
			if (!command.success) return {
				kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
			};
			if (control.kind === 'unavailable') return { kind: 'unavailable', reason: control.reason };
			const response = await requestJson({
				path: control.path, method: 'POST',
				schema: calendarNoticeGenerationControlOperationResultSchema,
				body: command.data,
				idempotencyKey: `je.calendar-notice.${globalThis.crypto.randomUUID()}`
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = calendarNoticeGenerationControlOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return {
				kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
			};
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data.generation, receipt: parsed.data.receipt }
				: { kind: 'outcome', outcome: parsed.data.outcome };
		}
	});
}
