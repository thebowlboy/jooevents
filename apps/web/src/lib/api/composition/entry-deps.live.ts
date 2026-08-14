import { signInLinkRequestResultSchema } from '@jooevents/contracts';
import { getAccessContext } from '../access';
import { signOut, startExternalSignIn } from '../auth';
import { requestJson } from '../client';
import { createParticipantEntryLiveClient } from '../portal/live/entry-client';
import type { EntryDependencies } from './entry-dependencies';

/**
 * Live entry fulfillment: every call is a request to this origin's own API,
 * validated against the published contract. A route that is not served yet
 * fails as a transport error the entry surfaces already render — it never
 * falls back to a fabricated answer. The participant arm is the lane's own
 * client, byte-identical paths and schemas, stated once.
 */

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
	participant: createParticipantEntryLiveClient()
};
