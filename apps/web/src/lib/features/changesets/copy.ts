import type { SafeApiError } from '$lib/api/client';
import type { ChangesetReviewOperation } from '$lib/api/changesets/port';
import type { StructuredOutcome } from '@jooevents/contracts';

export interface ChangesetReviewFailureCopy {
	readonly title: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly correlationId?: string;
}

export function changesetOutcomeCopy(
	outcome: StructuredOutcome,
	correlationId: string
): ChangesetReviewFailureCopy {
	const copy = outcome.class === 'access_denied'
		? {
				title: 'Access changed',
				message: 'You no longer have access to review or apply this change.'
			}
		: outcome.class === 'stale_revision'
			? {
					title: 'The draft changed',
					message: 'Reload the diff before continuing. The reviewed revision has been preserved.'
				}
			: outcome.class === 'idempotency_conflict'
				? {
						title: 'The request changed',
						message: 'Reload the diff before trying this action again.'
					}
				: outcome.class === 'policy_violation'
					? {
							title: 'This action needs another step',
							message: 'The current policy does not allow this revision to continue here.'
						}
					: outcome.class === 'conflict'
						? {
								title: 'This change cannot continue yet',
								message: 'Reload the diff to review the current state before trying again.'
							}
						: outcome.class === 'quota_exceeded'
							? {
									title: 'A limit was reached',
									message: 'This change cannot continue until the applicable limit is resolved.'
								}
							: outcome.class === 'provider_not_ready'
								? {
										title: 'A required service is not ready',
										message: 'The change remains uncommitted. Complete setup before trying again.'
									}
								: {
										title: 'The change could not continue',
										message: 'The change remains uncommitted. Review it and try again.'
									};
	return Object.freeze({ ...copy, retryable: outcome.retryable, correlationId });
}

export function changesetTransportCopy(error: SafeApiError): ChangesetReviewFailureCopy {
	const access = error.code === 'unauthenticated' || error.code === 'forbidden';
	const copy = access
		? {
				title: 'Access changed',
				message: 'Sign in again or ask an organizer to check your access.'
			}
		: error.retryable
			? {
					title: 'JooEvents could not finish the request',
					message: 'Your draft is still available. Check the connection and try again.'
				}
			: {
					title: 'The request could not be sent',
					message: 'Reload the diff before trying this action again.'
				};
	return Object.freeze({
		...copy,
		retryable: error.retryable,
		...(error.correlationId ? { correlationId: error.correlationId } : {})
	});
}

export function changesetUnavailableCopy(
	_operation: ChangesetReviewOperation
): ChangesetReviewFailureCopy {
	return Object.freeze({
		title: 'Changeset review is not available',
		message: 'This build does not provide the complete review and commit capability.',
		retryable: false
	});
}
