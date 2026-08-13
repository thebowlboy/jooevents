import type {
	AccessContext,
	ParticipantContext,
	SignInLinkCallbackResult,
	SignInLinkRequestResult
} from '@jooevents/contracts';
import type { ApiResult } from '../client';

/**
 * The API calls the entry controllers make, as injected dependencies. One
 * composition supplies both lanes so a build selects its fulfillment once, and
 * neither controller reaches for a transport itself.
 */
export interface OperatorEntryDependencies {
	readonly getContext: (options?: {
		readonly signal?: AbortSignal;
	}) => Promise<ApiResult<AccessContext>>;
	readonly startGoogle: (input: {
		readonly provider: 'google';
		readonly returnTo: string;
	}) => Promise<ApiResult<{ readonly redirecting: true }>>;
	readonly signOut: () => Promise<ApiResult<{ readonly signedOut: true }>>;
	/** Registered addresses only; the acknowledgement is identical either way. */
	readonly requestSignInLink: (input: {
		readonly email: string;
	}) => Promise<ApiResult<SignInLinkRequestResult>>;
}

export interface ParticipantEntryDependencies {
	readonly getContext: (options?: {
		readonly signal?: AbortSignal;
	}) => Promise<ApiResult<ParticipantContext>>;
	/** One address field serves both first arrival and return; the answer never distinguishes them. */
	readonly requestLink: (input: {
		readonly email: string;
	}) => Promise<ApiResult<SignInLinkRequestResult>>;
	readonly completeLink: (input: {
		readonly token: string;
	}) => Promise<ApiResult<SignInLinkCallbackResult>>;
	readonly signOut: () => Promise<ApiResult<{ readonly signedOut: true }>>;
}

export interface EntryDependencies {
	readonly operator: OperatorEntryDependencies;
	readonly participant: ParticipantEntryDependencies;
}
