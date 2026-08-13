import { describe, expect, test } from 'bun:test';
import type { StructuredOutcome } from '@jooevents/contracts';
import {
	classifyReviewResolutionFailure,
	ReviewResolutionError
} from './review-resolution';

function outcome(partial: Partial<StructuredOutcome>): StructuredOutcome {
	return {
		class: 'access_denied',
		kind: 'authority.permission_missing',
		retryable: false,
		subjects: [],
		detail: null,
		detailSchemaVersion: 1,
		...partial
	} as StructuredOutcome;
}

describe('review resolution failure classification', () => {
	test('a non-retryable structured outcome is terminal with refusal copy', () => {
		const error = classifyReviewResolutionFailure({
			kind: 'outcome',
			outcome: outcome({}),
			correlationId: 'corr-1'
		});
		expect(error).toBeInstanceOf(ReviewResolutionError);
		expect(error.terminal).toBe(true);
		expect(error.code).toBe('authority.permission_missing');
		expect(error.message).toBe('You do not have access to the review workspace.');
	});

	test('a retryable structured outcome clears for retry', () => {
		const error = classifyReviewResolutionFailure({
			kind: 'outcome',
			outcome: outcome({
				class: 'conflict',
				kind: 'operation.in_progress',
				retryable: true
			}),
			correlationId: 'corr-2'
		});
		expect(error.terminal).toBe(false);
		expect(error.message).toBe('The review workspace changed while loading. Try again.');
	});

	test('a retryable transport failure offers retry', () => {
		const error = classifyReviewResolutionFailure({
			kind: 'transport_error',
			error: { code: 'network_error', retryable: true }
		});
		expect(error.terminal).toBe(false);
		expect(error.message).toBe('The review workspace could not be loaded. Try again.');
	});

	test('a non-retryable transport failure renders without a retry promise', () => {
		const error = classifyReviewResolutionFailure({
			kind: 'transport_error',
			error: { code: 'invalid_request', retryable: false }
		});
		expect(error.terminal).toBe(true);
	});

	test('an unavailable binding is terminal: the captured manifest cannot change', () => {
		const error = classifyReviewResolutionFailure({
			kind: 'unavailable',
			operation: 'snapshot',
			reason: 'operation_not_registered'
		});
		expect(error.terminal).toBe(true);
		expect(error.code).toBe('operation_not_registered');
		expect(error.message).toBe(
			'The review workspace is not available in this live workspace.'
		);
	});
});
