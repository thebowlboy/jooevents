/**
 * How a tuned page states a page-port failure it caught: the reviewed copy the
 * port threw, plus whether retrying the same request could ever change the
 * answer. Live page-port errors declare `retryable` themselves (server-stated
 * for structured outcomes, client-stated for transport); an error that does
 * not declare it is an unclassified defect and stays retryable rather than
 * freezing the surface behind a terminal claim nobody made.
 */
export interface PortFailureView {
	readonly message: string;
	readonly retryable: boolean;
}

const FALLBACK_COPY = 'This request could not be completed.';

export function describePortFailure(error: unknown, fallback = FALLBACK_COPY): PortFailureView {
	const message =
		error instanceof Error && error.message.length > 0 ? error.message : fallback;
	const declared =
		typeof error === 'object' && error !== null && 'retryable' in error
			? (error as { readonly retryable?: unknown }).retryable
			: undefined;
	return { message, retryable: declared !== false };
}
