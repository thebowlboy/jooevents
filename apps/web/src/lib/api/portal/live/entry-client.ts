import {
	participantContextSchema,
	signInLinkCallbackResultSchema,
	signInLinkRequestResultSchema,
	type ParticipantContext,
	type SignInLinkCallbackResult,
	type SignInLinkRequestResult
} from '@jooevents/contracts';
import { z } from 'zod';
import { requestJson, type ApiResult } from '../../client';

/**
 * Live participant entry client: the four ceremony calls of the email-proof
 * sign-in lane, each a same-origin request validated against the published
 * contract. The shapes are deliberately method-neutral — nothing here binds
 * portal behavior to link-shaped verification beyond the token exchange the
 * contract already names, so the planned OTP path arrives behind the same
 * calls.
 *
 * Two ceremony rules are visible in the types alone. The link request
 * resolves to the one non-enumerating acknowledgement shape whoever asks, so
 * this client cannot learn whether an address is known. And the callback's
 * failures are named outcomes (`link_expired` / `link_used` /
 * `link_invalid`), never generic errors: a consumed or superseded link is a
 * resolved server answer, not a transport failure.
 *
 * A route that is not served yet fails as an honest transport error the entry
 * surfaces already render; nothing falls back to a fabricated answer.
 */

export const PARTICIPANT_ENTRY_PATHS = Object.freeze({
	context: '/api/me/participant-context',
	requestLink: '/api/portal/entry/link',
	completeLink: '/api/portal/entry/complete',
	signOut: '/api/portal/entry/sign-out'
});

const signedOutSchema = z.object({ signedOut: z.literal(true) });

export interface ParticipantEntryLiveClient {
	readonly getContext: (options?: {
		readonly signal?: AbortSignal;
	}) => Promise<ApiResult<ParticipantContext>>;
	/** One address field serves first arrival and return; the answer never distinguishes them. */
	readonly requestLink: (input: {
		readonly email: string;
	}) => Promise<ApiResult<SignInLinkRequestResult>>;
	/** The clicked link's proof, exchanged exactly once; the token never persists here. */
	readonly completeLink: (input: {
		readonly token: string;
	}) => Promise<ApiResult<SignInLinkCallbackResult>>;
	readonly signOut: () => Promise<ApiResult<{ readonly signedOut: true }>>;
}

export type ParticipantEntryRequester = typeof requestJson;

export function createParticipantEntryLiveClient(
	request: ParticipantEntryRequester = requestJson
): ParticipantEntryLiveClient {
	return Object.freeze({
		getContext: (options: { readonly signal?: AbortSignal } = {}) =>
			request({
				path: PARTICIPANT_ENTRY_PATHS.context,
				schema: participantContextSchema,
				...(options.signal ? { signal: options.signal } : {})
			}),
		requestLink: (input: { readonly email: string }) =>
			request({
				path: PARTICIPANT_ENTRY_PATHS.requestLink,
				schema: signInLinkRequestResultSchema,
				method: 'POST',
				body: input
			}),
		completeLink: (input: { readonly token: string }) =>
			request({
				path: PARTICIPANT_ENTRY_PATHS.completeLink,
				schema: signInLinkCallbackResultSchema,
				method: 'POST',
				body: input
			}),
		signOut: () =>
			request({
				path: PARTICIPANT_ENTRY_PATHS.signOut,
				schema: signedOutSchema,
				method: 'POST',
				body: {}
			})
	});
}
