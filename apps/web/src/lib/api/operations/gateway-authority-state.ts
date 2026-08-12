import {
	accessContextSchema,
	gatewayAuthorityProjectionSchema,
	gatewayPrincipalPartitionKeys,
	type AccessContext,
	type GatewayAuthorityProjection,
	type GatewayPrincipalPartitionKey
} from '@jooevents/contracts';

export type GatewayAuthorityAvailability =
	| { readonly kind: 'available'; readonly projection: GatewayAuthorityProjection }
	| {
			readonly kind: 'unavailable';
			readonly reason: 'not_active' | 'projection_absent' | 'projection_invalid';
	  };

/** Missing or invalid server projection is an explicit disabled state, never a fallback identity. */
export function gatewayAuthorityFromAccessContext(value: unknown): GatewayAuthorityAvailability {
	const parsed = accessContextSchema.safeParse(value);
	if (!parsed.success) return { kind: 'unavailable', reason: 'projection_invalid' };
	if (parsed.data.state !== 'active') return { kind: 'unavailable', reason: 'not_active' };
	if (!parsed.data.gatewayAuthority) {
		return { kind: 'unavailable', reason: 'projection_absent' };
	}
	return {
		kind: 'available',
		projection: gatewayAuthorityProjectionSchema.parse(parsed.data.gatewayAuthority)
	};
}

export type GatewayAuthorityTransition =
	| {
			readonly kind: 'unavailable';
			readonly clearProtectedPresentations: true;
			readonly pendingActionIdentity: 'unavailable';
	  }
	| {
			readonly kind: 'principal_replaced';
			readonly clearProtectedPresentations: true;
			readonly pendingActionIdentity: 'isolated';
	  }
	| {
			readonly kind: 'disclosure_changed';
			readonly clearProtectedPresentations: true;
			readonly pendingActionIdentity: 'preserved_requires_server_resolution';
	  }
	| {
			readonly kind: 'profile_rotated';
			readonly clearProtectedPresentations: true;
			readonly pendingActionIdentity: 'preserved';
	  }
	| {
			readonly kind: 'unchanged';
			readonly clearProtectedPresentations: false;
			readonly pendingActionIdentity: 'preserved';
	  };

function keySet(projection: GatewayAuthorityProjection): ReadonlySet<GatewayPrincipalPartitionKey> {
	return new Set(gatewayPrincipalPartitionKeys(projection));
}

/**
 * Classifies a server-authority replacement for browser-owned metadata. A changed
 * current key counts as compatible rotation only when the two bounded alias sets
 * overlap; no user ID, workspace ID, or local guess substitutes for that overlap.
 */
export function classifyGatewayAuthorityTransition(
	previous: GatewayAuthorityProjection | undefined,
	current: GatewayAuthorityProjection | undefined
): GatewayAuthorityTransition {
	if (!previous || !current) {
		return {
			kind: 'unavailable',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'unavailable'
		};
	}
	const before = gatewayAuthorityProjectionSchema.safeParse(previous);
	const after = gatewayAuthorityProjectionSchema.safeParse(current);
	if (!before.success || !after.success) {
		return {
			kind: 'unavailable',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'unavailable'
		};
	}

	const beforeKeys = keySet(before.data);
	const afterKeys = keySet(after.data);
	const exactCurrent =
		before.data.principalPartition.current === after.data.principalPartition.current;
	const aliasOverlap = [...beforeKeys].some((key) => afterKeys.has(key));
	if (!exactCurrent && !aliasOverlap) {
		return {
			kind: 'principal_replaced',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'isolated'
		};
	}

	if (before.data.disclosureEpoch !== after.data.disclosureEpoch) {
		return {
			kind: 'disclosure_changed',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'preserved_requires_server_resolution'
		};
	}
	if (!exactCurrent) {
		return {
			kind: 'profile_rotated',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'preserved'
		};
	}
	return {
		kind: 'unchanged',
		clearProtectedPresentations: false,
		pendingActionIdentity: 'preserved'
	};
}

export async function applyGatewayAuthorityTransition(input: {
	readonly previous: GatewayAuthorityProjection | undefined;
	readonly current: GatewayAuthorityProjection | undefined;
	readonly clearProtectedPresentations: () => void | Promise<void>;
}): Promise<GatewayAuthorityTransition> {
	const transition = classifyGatewayAuthorityTransition(input.previous, input.current);
	if (transition.clearProtectedPresentations) {
		await input.clearProtectedPresentations();
	}
	return transition;
}

export function activeGatewayAuthority(
	context: AccessContext
): GatewayAuthorityProjection | undefined {
	return context.state === 'active' ? context.gatewayAuthority : undefined;
}
