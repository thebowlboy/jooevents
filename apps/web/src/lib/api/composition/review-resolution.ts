import type { StructuredOutcome } from '@jooevents/contracts';
import type { SafeApiError } from '../client';
import type { ReviewCoreReadResult } from '../review-core-port';

/**
 * Typed failure of the one snapshot read that constructs the tuned Review
 * page port. The composition memoizes that construction, so every failure
 * must declare which of two very different surfaces it deserves:
 *
 * - `terminal: true` — the server answered and refused, or the composed
 *   manifest cannot carry the operation at all. Retrying the same read from
 *   the same session cannot change the answer, so the memo is kept and the
 *   page renders the typed refusal without a retry affordance. Flattening
 *   these into "try again" would promise a recovery that cannot happen and
 *   re-issue a read whose refusal is already known.
 * - `terminal: false` — the read did not land (transport) or the server
 *   said the state moved (retryable outcome). The memo clears so the next
 *   visit or an explicit retry re-reads.
 */
export class ReviewResolutionError extends Error {
	readonly code: string;
	readonly terminal: boolean;

	constructor(failure: { readonly code: string; readonly reason: string; readonly terminal: boolean }) {
		super(failure.reason);
		this.name = 'ReviewResolutionError';
		this.code = failure.code;
		this.terminal = failure.terminal;
	}
}

const RETRY_COPY = 'The review workspace could not be loaded. Try again.';

function outcomeCopy(outcome: StructuredOutcome): string {
	if (outcome.class === 'access_denied') {
		return 'You do not have access to the review workspace.';
	}
	if (outcome.class === 'conflict' || outcome.class === 'stale_revision') {
		return outcome.retryable
			? 'The review workspace changed while loading. Try again.'
			: 'The review workspace cannot be served in its current state.';
	}
	return outcome.retryable
		? RETRY_COPY
		: 'This review workspace request could not be completed.';
}

/**
 * One classification for every non-success shape the Review core snapshot
 * read can produce. The `retryable` verdict is the server's own (structured
 * outcomes carry it; transport errors carry the client's), never a guess:
 * an unavailable binding is terminal because the composition captures its
 * manifest once, so no retry inside this composition can mount the missing
 * operation.
 */
export function classifyReviewResolutionFailure(
	result: Exclude<ReviewCoreReadResult<unknown>, { readonly kind: 'success' }>
): ReviewResolutionError {
	if (result.kind === 'unavailable') {
		return new ReviewResolutionError({
			code: result.reason,
			reason: 'The review workspace is not available in this live workspace.',
			terminal: true
		});
	}
	if (result.kind === 'transport_error') {
		return transportFailure(result.error);
	}
	return new ReviewResolutionError({
		code: result.outcome.kind,
		reason: outcomeCopy(result.outcome),
		terminal: !result.outcome.retryable
	});
}

function transportFailure(error: SafeApiError): ReviewResolutionError {
	return new ReviewResolutionError({
		code: error.code,
		reason: error.retryable ? RETRY_COPY : 'This review workspace request is not valid.',
		// A non-retryable transport error is a malformed request — a defect,
		// not a served refusal — but retrying the identical request cannot
		// repair it either, so it renders without a retry affordance.
		terminal: !error.retryable
	});
}
