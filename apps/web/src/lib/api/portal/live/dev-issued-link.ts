import { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../../client';

/**
 * Development-only access to the most recently issued sign-in link, following
 * the existing fixture-control pattern: exactly as the sample switcher's
 * "open the emailed link" affordance exists only behind `import.meta.env.DEV`,
 * this module answers only in a Vite dev build and is otherwise inert.
 *
 * Under D4 the portal is built against the outbox with the deterministic fake
 * provider, so a dev build has no real mailbox to open. The dev fixture
 * control is how the issued link is reached in that posture — served only by
 * the dev/ephemeral server composition, never mounted in `http/app.ts`, and
 * never a production path. Delivery history still records the send honestly
 * as terminal not-delivered; this control does not touch that ledger.
 *
 * The endpoint is a deliberate dev-only oracle (it answers whether a live
 * challenge exists for an address), which is exactly why the production lane
 * must never serve it and this client must never call it outside a dev build.
 */

export const DEV_ISSUED_LINK_PATH = '/api/portal/entry/dev/issued-link';

export const devIssuedLinkResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('issued'),
		/** Same-origin completion URL carrying the raw token; never logged here. */
		url: z.string().min(1),
		expiresAt: z.iso.datetime({ offset: true })
	}),
	/** No live challenge for that address — expired, consumed, superseded, or never requested. */
	z.strictObject({ kind: z.literal('none') })
]);

export type DevIssuedLinkDto = z.infer<typeof devIssuedLinkResultSchema>;

export type DevIssuedLinkResult =
	| DevIssuedLinkDto
	| { readonly kind: 'unavailable'; readonly reason: 'not_dev_build' }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

export type DevIssuedLinkRequester = (input: {
	readonly path: string;
	readonly schema: z.ZodType<DevIssuedLinkDto>;
	readonly method: 'POST';
	readonly body: unknown;
}) => Promise<ApiResult<DevIssuedLinkDto>>;

function inDevBuild(): boolean {
	return typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;
}

/**
 * Whether an issued link may be followed from the dev affordance: only a
 * same-origin, relative completion path ever qualifies, so a compromised or
 * misconfigured control can never send the browser off-origin.
 */
export function isPortalCompletionPath(url: string): boolean {
	return url.startsWith('/portal/auth/complete?') && !url.startsWith('//');
}

/**
 * Reads the newest still-live issued link for an address. Structurally inert
 * outside a dev build: the guard answers before any request exists, so no
 * production bundle path can reach the endpoint even if a served route were
 * mistakenly left mounted.
 */
export async function fetchDevIssuedLink(
	input: { readonly email: string },
	dependencies: {
		readonly request?: DevIssuedLinkRequester;
		/** Test seam only; the default is the build's own flag. */
		readonly isDevBuild?: () => boolean;
	} = {}
): Promise<DevIssuedLinkResult> {
	const guard = dependencies.isDevBuild ?? inDevBuild;
	if (!guard()) return { kind: 'unavailable', reason: 'not_dev_build' };
	const request = dependencies.request ?? requestJson;
	const response = await request({
		path: DEV_ISSUED_LINK_PATH,
		schema: devIssuedLinkResultSchema,
		method: 'POST',
		body: { email: input.email }
	});
	if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
	return response.data;
}
