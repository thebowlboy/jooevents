import {
	parsePendingGatewayActionRecord,
	pendingGatewayActionIdentitySchema,
	pendingGatewayActionPartitionKey,
	pendingGatewayActionPartitionSchema,
	pendingGatewayActionStorageKey,
	pendingGatewayActionValuesEqual,
	samePendingGatewayActionIdentity,
	samePendingGatewayActionPartition,
	type GatewayScopeKey,
	type GatewaySourceKey,
	type PendingGatewayActionIdentity,
	type PendingGatewayActionPartition,
	type PendingGatewayActionPartitionKey,
	type PendingGatewayActionRecord,
	type PendingGatewayActionStorageKey
} from './pending-gateway-action';
import {
	gatewayAuthorityProjectionSchema,
	gatewayPendingActionResolutionBindingSchema,
	gatewayPendingActionResolutionProofSchema,
	gatewayPrincipalPartitionKeys,
	type GatewayAuthorityProjection,
	type GatewayPendingActionResolutionBinding,
	type GatewayPendingActionResolutionProof,
	type VersionedDefinitionRef
} from '@jooevents/contracts';

export interface PendingGatewayActionStorageRow {
	readonly storageKey: PendingGatewayActionStorageKey;
	readonly partitionKey: PendingGatewayActionPartitionKey;
	readonly revision: number;
	readonly value: unknown;
}

export interface PendingGatewayActionStorageDriver {
	create(row: PendingGatewayActionStorageRow): Promise<'created' | 'exists'>;
	get(storageKey: PendingGatewayActionStorageKey): Promise<PendingGatewayActionStorageRow | null>;
	list(partitionKey: PendingGatewayActionPartitionKey): Promise<readonly PendingGatewayActionStorageRow[]>;
	compareAndSwap(
		storageKey: PendingGatewayActionStorageKey,
		expectedRevision: number,
		next: PendingGatewayActionStorageRow
	): Promise<'advanced' | 'stale' | 'not_found'>;
	deleteIfRevision(
		storageKey: PendingGatewayActionStorageKey,
		expectedRevision: number
	): Promise<'deleted' | 'stale' | 'not_found'>;
	close?(): void;
}

export type PendingGatewayActionStoreUnavailableReason =
	| 'storage_unavailable'
	| 'authority_unavailable'
	| 'invalid_record'
	| 'corrupt_record'
	| 'partition_mismatch'
	| 'concurrent_change'
	| 'resolution_proof_rejected'
	| 'resolution_verifier_unavailable';

export interface PendingGatewayActionResolutionTicket {
	readonly kind: 'requires_server_resolution';
	readonly reason: 'disclosure_epoch_changed';
	readonly binding: GatewayPendingActionResolutionBinding;
}

export type PendingGatewayActionResolutionProofVerification =
	| {
			readonly kind: 'verified';
			readonly proof: GatewayPendingActionResolutionProof;
	  }
	| { readonly kind: 'rejected' };

/**
 * Trusted composition boundary. A production implementation resolves the proof
 * with the server, which authenticates the exact profile and binding, evaluates
 * issue/expiry against server time, and atomically consumes its single-use id.
 */
export interface PendingGatewayActionResolutionProofVerifier {
	readonly verifierProfile: VersionedDefinitionRef;
	verifyAndConsume(input: {
		readonly proof: GatewayPendingActionResolutionProof;
		readonly expectedBinding: GatewayPendingActionResolutionBinding;
	}): Promise<PendingGatewayActionResolutionProofVerification>;
}

type StoreUnavailable = {
	readonly kind: 'unavailable';
	readonly reason: PendingGatewayActionStoreUnavailableReason;
};

export type PendingGatewayActionCreateResult =
	| { readonly kind: 'created'; readonly record: PendingGatewayActionRecord }
	| { readonly kind: 'exists' }
	| StoreUnavailable;

export type PendingGatewayActionLookupResult =
	| { readonly kind: 'recoverable'; readonly record: PendingGatewayActionRecord }
	| PendingGatewayActionResolutionTicket
	| {
			readonly kind: 'terminal';
			readonly identity: PendingGatewayActionIdentity;
			readonly revision: number;
			readonly state: 'completed' | 'abandoned' | 'expired';
	  }
	| { readonly kind: 'not_found' }
	| StoreUnavailable;

export type PendingGatewayActionListResult =
	| {
			readonly kind: 'success';
			readonly recoverable: readonly PendingGatewayActionRecord[];
			readonly requiresServerResolution: readonly PendingGatewayActionResolutionTicket[];
	  }
	| StoreUnavailable;

export type PendingGatewayActionCompareAndSwapResult =
	| { readonly kind: 'advanced'; readonly record: PendingGatewayActionRecord }
	| { readonly kind: 'stale' }
	| { readonly kind: 'not_found' }
	| { readonly kind: 'invalid_transition' }
	| { readonly kind: 'terminal'; readonly state: 'completed' | 'abandoned' | 'expired' }
	| PendingGatewayActionResolutionTicket
	| StoreUnavailable;

export type PendingGatewayActionRebindResult =
	| { readonly kind: 'rebound'; readonly record: PendingGatewayActionRecord }
	| { readonly kind: 'stale' }
	| { readonly kind: 'not_found' }
	| { readonly kind: 'terminal'; readonly state: 'completed' | 'abandoned' | 'expired' }
	| PendingGatewayActionResolutionTicket
	| StoreUnavailable;

function nowIso(clock: () => Date): string {
	const now = clock();
	if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid PendingGatewayAction clock.');
	return now.toISOString();
}

function rowFor(record: PendingGatewayActionRecord): PendingGatewayActionStorageRow {
	return {
		storageKey: pendingGatewayActionStorageKey(record.identity),
		partitionKey: pendingGatewayActionPartitionKey(record.identity),
		revision: record.revision,
		value: record
	};
}

function parseRow(
	row: PendingGatewayActionStorageRow,
	expectedPartition?: PendingGatewayActionPartition
): PendingGatewayActionRecord | 'corrupt_record' | 'partition_mismatch' {
	let record: PendingGatewayActionRecord;
	try {
		record = parsePendingGatewayActionRecord(row.value);
	} catch {
		return 'corrupt_record';
	}
	if (
		row.revision !== record.revision ||
		row.storageKey !== pendingGatewayActionStorageKey(record.identity) ||
		row.partitionKey !== pendingGatewayActionPartitionKey(record.identity)
	) {
		return 'corrupt_record';
	}
	if (expectedPartition && !samePendingGatewayActionPartition(record.identity, expectedPartition)) {
		return 'partition_mismatch';
	}
	return record;
}

function transitionInstant(record: PendingGatewayActionRecord, requested: string): string {
	const millis = Math.max(Date.parse(requested), Date.parse(record.updatedAt) + 1);
	return new Date(millis).toISOString();
}

function quarantineRecord(
	record: PendingGatewayActionRecord,
	requestedAt: string
): PendingGatewayActionRecord {
	const quarantinedAt = transitionInstant(record, requestedAt);
	return parsePendingGatewayActionRecord({
		...record,
		revision: record.revision + 1,
		updatedAt: quarantinedAt,
		state: {
			kind: 'quarantined',
			reason: 'disclosure_epoch_changed',
			quarantinedAt,
			requiresServerResolution: true
		}
	});
}

function expiredRecord(record: PendingGatewayActionRecord, requestedAt: string): PendingGatewayActionRecord {
	const expiredAt = transitionInstant(record, requestedAt);
	return parsePendingGatewayActionRecord({
		...record,
		revision: record.revision + 1,
		updatedAt: expiredAt,
		state: { kind: 'expired', expiredAt }
	});
}

function resolutionBinding(
	record: PendingGatewayActionRecord,
	authority: GatewayAuthorityProjection
): GatewayPendingActionResolutionBinding {
	return gatewayPendingActionResolutionBindingSchema.parse({
		pendingActionIdentity: record.identity,
		currentPrincipalPartitionKey: authority.principalPartition.current,
		previousDisclosureEpoch: record.disclosureEpoch,
		resolvedDisclosureEpoch: authority.disclosureEpoch,
		pendingActionRevision: record.revision,
		currentStep: {
			stepKey: record.currentStep.stepKey,
			operation: record.currentStep.operation,
			idempotencyKey: record.currentStep.idempotencyKey
		}
	});
}

function resolutionTicket(
	record: PendingGatewayActionRecord,
	authority: GatewayAuthorityProjection
): PendingGatewayActionResolutionTicket {
	return Object.freeze({
		kind: 'requires_server_resolution',
		reason: 'disclosure_epoch_changed',
		binding: resolutionBinding(record, authority)
	});
}

function terminalResult(record: PendingGatewayActionRecord): PendingGatewayActionLookupResult {
	if (
		record.state.kind !== 'completed' &&
		record.state.kind !== 'abandoned' &&
		record.state.kind !== 'expired'
	) {
		throw new TypeError('Pending action is not terminal.');
	}
	return {
		kind: 'terminal',
		identity: record.identity,
		revision: record.revision,
		state: record.state.kind
	};
}

function completedStepMatchesCurrent(
	completed: PendingGatewayActionRecord['completedSteps'][number],
	current: PendingGatewayActionRecord['currentStep']
): boolean {
	return (
		completed.stepKey === current.stepKey &&
		completed.operation.name === current.operation.name &&
		completed.operation.version === current.operation.version
	);
}

function validStateTransition(
	current: PendingGatewayActionRecord,
	next: PendingGatewayActionRecord
): boolean {
	if (current.state.kind === 'active') {
		return (
			next.state.kind === 'active' ||
			next.state.kind === 'completed' ||
			next.state.kind === 'abandoned' ||
			next.state.kind === 'quarantined' ||
			next.state.kind === 'expired'
		);
	}
	if (current.state.kind === 'quarantined') {
		return next.state.kind === 'abandoned' || next.state.kind === 'expired';
	}
	return false;
}

function validReplacement(
	current: PendingGatewayActionRecord,
	next: PendingGatewayActionRecord,
	expectedRevision: number,
	currentTime: string
): boolean {
	if (
		current.revision !== expectedRevision ||
		next.revision !== expectedRevision + 1 ||
		!samePendingGatewayActionIdentity(current.identity, next.identity) ||
		current.schemaVersion !== next.schemaVersion ||
		current.disclosureEpoch !== next.disclosureEpoch ||
		!pendingGatewayActionValuesEqual(current.choreography, next.choreography) ||
		current.createdAt !== next.createdAt ||
		current.expiresAt !== next.expiresAt ||
		current.retainUntil !== next.retainUntil ||
		Date.parse(next.updatedAt) <= Date.parse(current.updatedAt) ||
		Date.parse(next.updatedAt) > Date.parse(currentTime) ||
		!validStateTransition(current, next)
	) {
		return false;
	}

	if (next.completedSteps.length < current.completedSteps.length) return false;
	for (let index = 0; index < current.completedSteps.length; index += 1) {
		if (!pendingGatewayActionValuesEqual(current.completedSteps[index], next.completedSteps[index])) {
			return false;
		}
	}

	const sameStep = pendingGatewayActionValuesEqual(current.currentStep, next.currentStep);
	if (next.state.kind === 'completed') {
		if (
			current.state.kind !== 'active' ||
			!sameStep ||
			next.completedSteps.length !== current.completedSteps.length + 1
		) {
			return false;
		}
		const completion = next.completedSteps.at(-1);
		return completion !== undefined && completedStepMatchesCurrent(completion, current.currentStep);
	}
	if (sameStep) return next.completedSteps.length === current.completedSteps.length;
	if (
		current.state.kind !== 'active' ||
		next.state.kind !== 'active' ||
		next.completedSteps.length !== current.completedSteps.length + 1
	) {
		return false;
	}
	const completion = next.completedSteps.at(-1);
	return completion !== undefined && completedStepMatchesCurrent(completion, current.currentStep);
}

interface StoreOptions {
	readonly driver: PendingGatewayActionStorageDriver;
	readonly resolutionProofVerifier: PendingGatewayActionResolutionProofVerifier;
	readonly clock?: () => Date;
}

export interface PendingGatewayActionStore {
	create(input: {
		readonly record: unknown;
		readonly authority: GatewayAuthorityProjection;
	}): Promise<PendingGatewayActionCreateResult>;
	get(input: {
		readonly identity: PendingGatewayActionIdentity;
		readonly authority: GatewayAuthorityProjection;
	}): Promise<PendingGatewayActionLookupResult>;
	list(input: {
		readonly sourceKey: GatewaySourceKey;
		readonly scopeKey: GatewayScopeKey;
		readonly authority: GatewayAuthorityProjection;
	}): Promise<PendingGatewayActionListResult>;
	compareAndSwap(input: {
		readonly identity: PendingGatewayActionIdentity;
		readonly authority: GatewayAuthorityProjection;
		readonly expectedRevision: number;
		readonly next: unknown;
	}): Promise<PendingGatewayActionCompareAndSwapResult>;
	rebindDisclosureEpoch(input: {
		readonly identity: PendingGatewayActionIdentity;
		readonly authority: GatewayAuthorityProjection;
		readonly expectedRevision: number;
		readonly resolutionProof: GatewayPendingActionResolutionProof;
	}): Promise<PendingGatewayActionRebindResult>;
}

/** Durable browser metadata only: this store neither grants authority nor activates a gateway. */
export function createPendingGatewayActionStore(options: StoreOptions): PendingGatewayActionStore {
	const clock = options.clock ?? (() => new Date());

	function parseAuthority(value: unknown): GatewayAuthorityProjection | undefined {
		const parsed = gatewayAuthorityProjectionSchema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	}

	function identityBelongsToAuthority(
		identity: PendingGatewayActionIdentity,
		authority: GatewayAuthorityProjection
	): boolean {
		return gatewayPrincipalPartitionKeys(authority)
			.includes(identity.principalPartitionKey);
	}

	async function assess(
		record: PendingGatewayActionRecord,
		authority: GatewayAuthorityProjection,
		currentTime: string
	): Promise<PendingGatewayActionLookupResult> {
		const row = rowFor(record);
		if (Date.parse(currentTime) >= Date.parse(record.retainUntil)) {
			const removed = await options.driver.deleteIfRevision(row.storageKey, record.revision);
			return removed === 'stale'
				? { kind: 'unavailable', reason: 'concurrent_change' }
				: { kind: 'not_found' };
		}

		if (
			Date.parse(currentTime) >= Date.parse(record.expiresAt) &&
			record.state.kind !== 'completed' &&
			record.state.kind !== 'abandoned' &&
			record.state.kind !== 'expired'
		) {
			const expired = expiredRecord(record, currentTime);
			const advanced = await options.driver.compareAndSwap(
				row.storageKey,
				record.revision,
				rowFor(expired)
			);
			if (advanced !== 'advanced') {
				return { kind: 'unavailable', reason: 'concurrent_change' };
			}
			return terminalResult(expired);
		}

		if (
			record.state.kind === 'completed' ||
			record.state.kind === 'abandoned' ||
			record.state.kind === 'expired'
		) {
			return terminalResult(record);
		}

		if (record.state.kind === 'quarantined') return resolutionTicket(record, authority);
		if (record.disclosureEpoch !== authority.disclosureEpoch) {
			const quarantined = quarantineRecord(record, currentTime);
			const advanced = await options.driver.compareAndSwap(
				row.storageKey,
				record.revision,
				rowFor(quarantined)
			);
			if (advanced !== 'advanced') {
				return { kind: 'unavailable', reason: 'concurrent_change' };
			}
			return resolutionTicket(quarantined, authority);
		}
		return { kind: 'recoverable', record };
	}

	const store: PendingGatewayActionStore = {
		async create(input: {
			readonly record: unknown;
			readonly authority: GatewayAuthorityProjection;
		}): Promise<PendingGatewayActionCreateResult> {
			let record: PendingGatewayActionRecord;
			let authority: GatewayAuthorityProjection;
			let currentTime: string;
			try {
				record = parsePendingGatewayActionRecord(input.record);
				const parsedAuthority = parseAuthority(input.authority);
				if (!parsedAuthority) return { kind: 'unavailable', reason: 'authority_unavailable' };
				authority = parsedAuthority;
				currentTime = nowIso(clock);
			} catch {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			if (
				record.identity.principalPartitionKey !== authority.principalPartition.current ||
				record.disclosureEpoch !== authority.disclosureEpoch ||
				record.revision !== 1 ||
				record.state.kind !== 'active' ||
				record.createdAt !== record.updatedAt ||
				Date.parse(record.createdAt) > Date.parse(currentTime) ||
				Date.parse(record.expiresAt) <= Date.parse(currentTime)
			) {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			try {
				const created = await options.driver.create(rowFor(record));
				return created === 'created' ? { kind: 'created', record } : { kind: 'exists' };
			} catch {
				return { kind: 'unavailable', reason: 'storage_unavailable' };
			}
		},

		async get(input: {
			readonly identity: PendingGatewayActionIdentity;
			readonly authority: GatewayAuthorityProjection;
		}): Promise<PendingGatewayActionLookupResult> {
			let authority: GatewayAuthorityProjection;
			let identity: PendingGatewayActionIdentity;
			let currentTime: string;
			try {
				identity = pendingGatewayActionIdentitySchema.parse(input.identity);
				const parsedAuthority = parseAuthority(input.authority);
				if (!parsedAuthority) return { kind: 'unavailable', reason: 'authority_unavailable' };
				authority = parsedAuthority;
				currentTime = nowIso(clock);
			} catch {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			try {
				if (!identityBelongsToAuthority(identity, authority)) {
					return { kind: 'unavailable', reason: 'partition_mismatch' };
				}
				const row = await options.driver.get(pendingGatewayActionStorageKey(identity));
				if (!row) return { kind: 'not_found' };
				const parsed = parseRow(row);
				if (typeof parsed === 'string') return { kind: 'unavailable', reason: parsed };
				if (!samePendingGatewayActionIdentity(parsed.identity, identity)) {
					return { kind: 'unavailable', reason: 'partition_mismatch' };
				}
				return await assess(parsed, authority, currentTime);
			} catch {
				return { kind: 'unavailable', reason: 'storage_unavailable' };
			}
		},

		async list(input: {
			readonly sourceKey: GatewaySourceKey;
			readonly scopeKey: GatewayScopeKey;
			readonly authority: GatewayAuthorityProjection;
		}): Promise<PendingGatewayActionListResult> {
			let authority: GatewayAuthorityProjection;
			let partitions: readonly PendingGatewayActionPartition[];
			let currentTime: string;
			try {
				const parsedAuthority = parseAuthority(input.authority);
				if (!parsedAuthority) return { kind: 'unavailable', reason: 'authority_unavailable' };
				authority = parsedAuthority;
				partitions = gatewayPrincipalPartitionKeys(authority).map(principalPartitionKey =>
					pendingGatewayActionPartitionSchema.parse({
						sourceKey: input.sourceKey,
						scopeKey: input.scopeKey,
						principalPartitionKey
					})
				);
				currentTime = nowIso(clock);
			} catch {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			try {
				const rows: PendingGatewayActionStorageRow[] = [];
				for (const partition of partitions) {
					rows.push(...await options.driver.list(pendingGatewayActionPartitionKey(partition)));
				}
				if (new Set(rows.map(row => row.storageKey)).size !== rows.length) {
					return { kind: 'unavailable', reason: 'corrupt_record' };
				}
				const records: PendingGatewayActionRecord[] = [];
				for (const row of rows) {
					const parsed = parseRow(row);
					if (typeof parsed === 'string') return { kind: 'unavailable', reason: parsed };
					if (!partitions.some(partition =>
						samePendingGatewayActionPartition(parsed.identity, partition)
					)) {
						return { kind: 'unavailable', reason: 'partition_mismatch' };
					}
					records.push(parsed);
				}

				records.sort(
					(left, right) =>
						left.createdAt.localeCompare(right.createdAt) ||
						left.identity.actionKey.localeCompare(right.identity.actionKey)
				);
				const recoverable: PendingGatewayActionRecord[] = [];
				const requiresServerResolution: PendingGatewayActionResolutionTicket[] = [];
				for (const record of records) {
					const result = await assess(record, authority, currentTime);
					if (result.kind === 'unavailable') return result;
					if (result.kind === 'recoverable') recoverable.push(result.record);
					if (result.kind === 'requires_server_resolution') {
						requiresServerResolution.push(result);
					}
				}
				return Object.freeze({
					kind: 'success' as const,
					recoverable: Object.freeze(recoverable),
					requiresServerResolution: Object.freeze(requiresServerResolution)
				});
			} catch {
				return { kind: 'unavailable', reason: 'storage_unavailable' };
			}
		},

		async compareAndSwap(input: {
			readonly identity: PendingGatewayActionIdentity;
			readonly authority: GatewayAuthorityProjection;
			readonly expectedRevision: number;
			readonly next: unknown;
		}): Promise<PendingGatewayActionCompareAndSwapResult> {
			if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
				return { kind: 'invalid_transition' };
			}
			let authority: GatewayAuthorityProjection;
			let identity: PendingGatewayActionIdentity;
			let currentTime: string;
			try {
				identity = pendingGatewayActionIdentitySchema.parse(input.identity);
				const parsedAuthority = parseAuthority(input.authority);
				if (!parsedAuthority) return { kind: 'unavailable', reason: 'authority_unavailable' };
				authority = parsedAuthority;
				currentTime = nowIso(clock);
			} catch {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			try {
				if (!identityBelongsToAuthority(identity, authority)) {
					return { kind: 'unavailable', reason: 'partition_mismatch' };
				}
				const storageKey = pendingGatewayActionStorageKey(identity);
				const row = await options.driver.get(storageKey);
				if (!row) return { kind: 'not_found' };
				const parsed = parseRow(row);
				if (typeof parsed === 'string') return { kind: 'unavailable', reason: parsed };
				if (!samePendingGatewayActionIdentity(parsed.identity, identity)) {
					return { kind: 'unavailable', reason: 'partition_mismatch' };
				}
				if (parsed.revision !== input.expectedRevision) return { kind: 'stale' };

				const assessed = await assess(parsed, authority, currentTime);
				if (assessed.kind !== 'recoverable') {
					if (assessed.kind === 'terminal') {
						return { kind: 'terminal', state: assessed.state };
					}
					return assessed;
				}

				let next: PendingGatewayActionRecord;
				try {
					next = parsePendingGatewayActionRecord(input.next);
				} catch {
					return { kind: 'invalid_transition' };
				}
				if (!validReplacement(parsed, next, input.expectedRevision, currentTime)) {
					return { kind: 'invalid_transition' };
				}
				const advanced = await options.driver.compareAndSwap(
					storageKey,
					input.expectedRevision,
					rowFor(next)
				);
				return advanced === 'advanced'
					? { kind: 'advanced', record: next }
					: { kind: advanced };
			} catch {
				return { kind: 'unavailable', reason: 'storage_unavailable' };
			}
		},

		async rebindDisclosureEpoch(input: {
			readonly identity: PendingGatewayActionIdentity;
			readonly authority: GatewayAuthorityProjection;
			readonly expectedRevision: number;
			readonly resolutionProof: GatewayPendingActionResolutionProof;
		}): Promise<PendingGatewayActionRebindResult> {
			if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			let identity: PendingGatewayActionIdentity;
			let authority: GatewayAuthorityProjection;
			let proof: GatewayPendingActionResolutionProof;
			let currentTime: string;
			try {
				identity = pendingGatewayActionIdentitySchema.parse(input.identity);
				const parsedAuthority = parseAuthority(input.authority);
				if (!parsedAuthority) return { kind: 'unavailable', reason: 'authority_unavailable' };
				authority = parsedAuthority;
				currentTime = nowIso(clock);
			} catch {
				return { kind: 'unavailable', reason: 'invalid_record' };
			}
			const parsedProof = gatewayPendingActionResolutionProofSchema.safeParse(
				input.resolutionProof
			);
			if (!parsedProof.success) {
				return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
			}
			proof = parsedProof.data;
			if (!identityBelongsToAuthority(identity, authority)) {
				return { kind: 'unavailable', reason: 'partition_mismatch' };
			}

			try {
				const storageKey = pendingGatewayActionStorageKey(identity);
				const row = await options.driver.get(storageKey);
				if (!row) return { kind: 'not_found' };
				const record = parseRow(row);
				if (typeof record === 'string') return { kind: 'unavailable', reason: record };
				if (!samePendingGatewayActionIdentity(record.identity, identity)) {
					return { kind: 'unavailable', reason: 'partition_mismatch' };
				}
				if (record.revision !== input.expectedRevision) return { kind: 'stale' };
				if (
					record.state.kind === 'completed' ||
					record.state.kind === 'abandoned' ||
					record.state.kind === 'expired'
				) {
					return { kind: 'terminal', state: record.state.kind };
				}
				if (Date.parse(currentTime) >= Date.parse(record.expiresAt)) {
					const assessed = await assess(record, authority, currentTime);
					if (assessed.kind === 'terminal') return { kind: 'terminal', state: assessed.state };
					return assessed.kind === 'not_found'
						? assessed
						: { kind: 'unavailable', reason: 'concurrent_change' };
				}
				if (record.state.kind === 'active') {
					const assessed = await assess(record, authority, currentTime);
					if (assessed.kind === 'requires_server_resolution') return assessed;
					if (assessed.kind === 'terminal') {
						return { kind: 'terminal', state: assessed.state };
					}
					return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
				}
				if (record.state.kind !== 'quarantined') {
					return { kind: 'unavailable', reason: 'invalid_record' };
				}

				let expectedBinding: GatewayPendingActionResolutionBinding;
				try {
					expectedBinding = resolutionBinding(record, authority);
				} catch {
					return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
				}
				if (
					!pendingGatewayActionValuesEqual(
						proof.verifierProfile,
						options.resolutionProofVerifier.verifierProfile
					) ||
					!pendingGatewayActionValuesEqual(proof.binding, expectedBinding)
				) {
					return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
				}

				let verification: PendingGatewayActionResolutionProofVerification;
				try {
					verification = await options.resolutionProofVerifier.verifyAndConsume({
						proof,
						expectedBinding
					});
				} catch {
					return { kind: 'unavailable', reason: 'resolution_verifier_unavailable' };
				}
				if (verification.kind !== 'verified') {
					return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
				}
				const verifiedProof = gatewayPendingActionResolutionProofSchema.safeParse(
					verification.proof
				);
				if (
					!verifiedProof.success ||
					!pendingGatewayActionValuesEqual(verifiedProof.data, proof) ||
					!pendingGatewayActionValuesEqual(verifiedProof.data.binding, expectedBinding)
				) {
					return { kind: 'unavailable', reason: 'resolution_proof_rejected' };
				}

				const updatedAt = new Date(Math.max(
					Date.parse(currentTime),
					Date.parse(record.updatedAt)
				)).toISOString();
				const rebound = parsePendingGatewayActionRecord({
					...record,
					disclosureEpoch: authority.disclosureEpoch,
					revision: record.revision + 1,
					updatedAt,
					state: { kind: 'active' }
				});
				const advanced = await options.driver.compareAndSwap(
					storageKey,
					record.revision,
					rowFor(rebound)
				);
				return advanced === 'advanced'
					? { kind: 'rebound', record: rebound }
					: { kind: advanced };
			} catch {
				return { kind: 'unavailable', reason: 'storage_unavailable' };
			}
		}
	};
	return Object.freeze(store);
}

const DEFAULT_DATABASE_NAME = 'jooevents-pending-gateway-actions';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'pending_gateway_actions_v1';
const PARTITION_INDEX_NAME = 'partition_key';

interface IndexedDbDriverOptions {
	readonly indexedDB?: IDBFactory;
	readonly databaseName?: string;
}

export function createIndexedDbPendingGatewayActionDriver(
	options: IndexedDbDriverOptions = {}
): PendingGatewayActionStorageDriver {
	const factory = options.indexedDB ?? globalThis.indexedDB;
	const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
	let databasePromise: Promise<IDBDatabase> | undefined;

	function openDatabase(): Promise<IDBDatabase> {
		if (!factory) return Promise.reject(new Error('IndexedDB is unavailable.'));
		if (databasePromise) return databasePromise;
		databasePromise = new Promise((resolve, reject) => {
			const request = factory.open(databaseName, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (database.objectStoreNames.contains(OBJECT_STORE_NAME)) return;
				const store = database.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'storageKey' });
				store.createIndex(PARTITION_INDEX_NAME, 'partitionKey', { unique: false });
			};
			request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
			request.onblocked = () => reject(new Error('IndexedDB open was blocked.'));
			request.onsuccess = () => {
				request.result.onversionchange = () => request.result.close();
				resolve(request.result);
			};
		});
		return databasePromise;
	}

	async function read(storageKey: PendingGatewayActionStorageKey) {
		const database = await openDatabase();
		return await new Promise<PendingGatewayActionStorageRow | null>((resolve, reject) => {
			const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
			const request = transaction.objectStore(OBJECT_STORE_NAME).get(storageKey);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
			request.onsuccess = () =>
				resolve((request.result as PendingGatewayActionStorageRow | undefined) ?? null);
			transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read aborted.'));
		});
	}

	const driver: PendingGatewayActionStorageDriver = {
		async create(row: PendingGatewayActionStorageRow) {
			const database = await openDatabase();
			return await new Promise<'created' | 'exists'>((resolve, reject) => {
				const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
				const store = transaction.objectStore(OBJECT_STORE_NAME);
				let result: 'created' | 'exists' = 'exists';
				const get = store.get(row.storageKey);
				get.onsuccess = () => {
					if (get.result !== undefined) return;
					result = 'created';
					store.add(row);
				};
				get.onerror = () => transaction.abort();
				transaction.oncomplete = () => resolve(result);
				transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB create failed.'));
				transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB create aborted.'));
			});
		},
		get: read,
		async list(partitionKey: PendingGatewayActionPartitionKey) {
			const database = await openDatabase();
			return await new Promise<readonly PendingGatewayActionStorageRow[]>((resolve, reject) => {
				const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
				const request = transaction
					.objectStore(OBJECT_STORE_NAME)
					.index(PARTITION_INDEX_NAME)
					.getAll(partitionKey);
				request.onerror = () => reject(request.error ?? new Error('IndexedDB list failed.'));
				request.onsuccess = () =>
					resolve(request.result as readonly PendingGatewayActionStorageRow[]);
				transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB list aborted.'));
			});
		},
		async compareAndSwap(
			storageKey: PendingGatewayActionStorageKey,
			expectedRevision: number,
			next: PendingGatewayActionStorageRow
		) {
			const database = await openDatabase();
			return await new Promise<'advanced' | 'stale' | 'not_found'>((resolve, reject) => {
				const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
				const store = transaction.objectStore(OBJECT_STORE_NAME);
				let result: 'advanced' | 'stale' | 'not_found' = 'not_found';
				const get = store.get(storageKey);
				get.onsuccess = () => {
					const current = get.result as PendingGatewayActionStorageRow | undefined;
					if (!current) return;
					if (current.revision !== expectedRevision) {
						result = 'stale';
						return;
					}
					result = 'advanced';
					store.put(next);
				};
				get.onerror = () => transaction.abort();
				transaction.oncomplete = () => resolve(result);
				transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB CAS failed.'));
				transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB CAS aborted.'));
			});
		},
		async deleteIfRevision(
			storageKey: PendingGatewayActionStorageKey,
			expectedRevision: number
		) {
			const database = await openDatabase();
			return await new Promise<'deleted' | 'stale' | 'not_found'>((resolve, reject) => {
				const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
				const store = transaction.objectStore(OBJECT_STORE_NAME);
				let result: 'deleted' | 'stale' | 'not_found' = 'not_found';
				const get = store.get(storageKey);
				get.onsuccess = () => {
					const current = get.result as PendingGatewayActionStorageRow | undefined;
					if (!current) return;
					if (current.revision !== expectedRevision) {
						result = 'stale';
						return;
					}
					result = 'deleted';
					store.delete(storageKey);
				};
				get.onerror = () => transaction.abort();
				transaction.oncomplete = () => resolve(result);
				transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed.'));
				transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB delete aborted.'));
			});
		},
		close() {
			void databasePromise?.then((database) => database.close()).catch(() => undefined);
			databasePromise = undefined;
		}
	};
	return Object.freeze(driver);
}
