import type { AccessContext, SafeUser, SafeWorkspace } from '@jooevents/contracts';
import type { ApiResult, SafeApiError } from '../client';

export type OperatorAccessResolution =
	| {
			readonly kind: 'active';
			readonly user: SafeUser;
			readonly workspace: SafeWorkspace;
	  }
	| { readonly kind: 'redirect'; readonly path: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

function returnPath(pathname: string, search: string): string {
	const path = `${pathname}${search}`;
	return pathname === '/app' || pathname.startsWith('/app/') ? path : '/app';
}

function entryPath(path: string, returnTo: string): string {
	return `${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Maps server-owned access state without deriving authority in the browser. */
export function resolveOperatorAccess(input: {
	readonly result: ApiResult<AccessContext>;
	readonly pathname: string;
	readonly search: string;
}): OperatorAccessResolution {
	if (input.result.kind === 'error') {
		return { kind: 'transport_error', error: input.result.error };
	}
	const returnTo = returnPath(input.pathname, input.search);
	switch (input.result.data.state) {
		case 'active':
			return {
				kind: 'active',
				user: input.result.data.user,
				workspace: input.result.data.workspace
			};
		case 'anonymous':
			return { kind: 'redirect', path: entryPath('/sign-in', returnTo) };
		case 'provisioning':
			return { kind: 'redirect', path: entryPath('/auth/complete', returnTo) };
		case 'pending_review':
			return { kind: 'redirect', path: entryPath('/access/pending', returnTo) };
		case 'blocked':
			return { kind: 'redirect', path: entryPath('/access/blocked', returnTo) };
	}
}
