import {
	participantContextSchema,
	signInLinkCallbackResultSchema,
	signInLinkRequestResultSchema
} from '@jooevents/contracts';
import { z } from 'zod';
import { getAccessContext } from '../access';
import { signOut, startExternalSignIn } from '../auth';
import { requestJson } from '../client';
import type { EntryDependencies } from './entry-dependencies';

/**
 * Live entry fulfillment: every call is a request to this origin's own API,
 * validated against the published contract. A route that is not served yet
 * fails as a transport error the entry surfaces already render — it never
 * falls back to a fabricated answer.
 */

const signedOutSchema = z.object({ signedOut: z.literal(true) });

export const entryDependencies: EntryDependencies = {
	operator: {
		getContext: getAccessContext,
		startGoogle: startExternalSignIn,
		signOut,
		requestSignInLink: (input) =>
			requestJson({
				path: '/api/entry/sign-in-link',
				schema: signInLinkRequestResultSchema,
				method: 'POST',
				body: input
			})
	},
	participant: {
		getContext: (options = {}) =>
			requestJson({
				path: '/api/me/participant-context',
				schema: participantContextSchema,
				...(options.signal ? { signal: options.signal } : {})
			}),
		requestLink: (input) =>
			requestJson({
				path: '/api/portal/entry/link',
				schema: signInLinkRequestResultSchema,
				method: 'POST',
				body: input
			}),
		completeLink: (input) =>
			requestJson({
				path: '/api/portal/entry/complete',
				schema: signInLinkCallbackResultSchema,
				method: 'POST',
				body: input
			}),
		signOut: () =>
			requestJson({
				path: '/api/portal/entry/sign-out',
				schema: signedOutSchema,
				method: 'POST',
				body: {}
			})
	}
};
