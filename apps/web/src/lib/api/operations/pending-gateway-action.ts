import {
	definitionKeySchema,
	gatewayActionKeySchema,
	gatewayDisclosureEpochSchema,
	gatewayPendingActionIdentitySchema,
	gatewayPrincipalPartitionKeySchema,
	gatewayScopeKeySchema,
	gatewaySourceKeySchema,
	gatewayStageIdempotencyKeySchema,
	operationNameSchema,
	operationVersionSchema,
	parseGatewayDisclosureEpoch,
	parseGatewayPrincipalPartitionKey,
	safeSchemaManifestRefSchema,
	versionedDefinitionRefSchema,
	type GatewayActionKey,
	type GatewayDisclosureEpoch,
	type GatewayPrincipalPartitionKey,
	type GatewayScopeKey,
	type GatewaySourceKey,
	type GatewayStageIdempotencyKey
} from '@jooevents/contracts';
import { z } from 'zod';

export {
	gatewayDisclosureEpochSchema,
	gatewayPrincipalPartitionKeySchema,
	gatewayActionKeySchema,
	gatewayScopeKeySchema,
	gatewaySourceKeySchema,
	gatewayStageIdempotencyKeySchema,
	parseGatewayDisclosureEpoch,
	parseGatewayPrincipalPartitionKey
} from '@jooevents/contracts';
export type {
	GatewayActionKey,
	GatewayDisclosureEpoch,
	GatewayPrincipalPartitionKey,
	GatewayScopeKey,
	GatewaySourceKey,
	GatewayStageIdempotencyKey
} from '@jooevents/contracts';

export const PENDING_GATEWAY_ACTION_LIMITS = Object.freeze({
	maximumRecordBytes: 64 * 1024,
	maximumInlineBytes: 16 * 1024,
	maximumServerReferenceBytes: 2 * 1024,
	maximumCompletedSteps: 32,
	maximumLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
	maximumRetentionAfterExpiryMs: 7 * 24 * 60 * 60 * 1_000
});

const opaqueBody = '[A-Za-z0-9_-]{16,240}';

/** Opaque values arrive from trusted gateway/server composition; this module never derives authority. */
function opaqueKey<Brand extends string>(prefix: string, brand: Brand) {
	return z
		.string()
		.min(prefix.length + 16)
		.max(prefix.length + 240)
		.regex(new RegExp(`^${prefix}${opaqueBody}$`))
		.brand<Brand>();
}

export const gatewayServerReferenceSchema = opaqueKey('gsr_', 'GatewayServerReference');
export const gatewayCompletionReferenceSchema = opaqueKey(
	'gcr_',
	'GatewayCompletionReference'
);

export type GatewayServerReference = z.infer<typeof gatewayServerReferenceSchema>;
export type GatewayCompletionReference = z.infer<typeof gatewayCompletionReferenceSchema>;

export function parseGatewaySourceKey(value: unknown): GatewaySourceKey {
	return gatewaySourceKeySchema.parse(value);
}

export function parseGatewayScopeKey(value: unknown): GatewayScopeKey {
	return gatewayScopeKeySchema.parse(value);
}

export function parseGatewayActionKey(value: unknown): GatewayActionKey {
	return gatewayActionKeySchema.parse(value);
}

export function parseGatewayStageIdempotencyKey(value: unknown): GatewayStageIdempotencyKey {
	return gatewayStageIdempotencyKeySchema.parse(value);
}

export function parseGatewayServerReference(value: unknown): GatewayServerReference {
	return gatewayServerReferenceSchema.parse(value);
}

export function parseGatewayCompletionReference(value: unknown): GatewayCompletionReference {
	return gatewayCompletionReferenceSchema.parse(value);
}

function canonicalJsonText(value: z.infer<ReturnType<typeof z.json>>): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'number') {
		return JSON.stringify(value);
	}
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJsonText(value[key]!)}`)
		.join(',')}}`;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

const safeInlineRequestSchema = z
	.strictObject({
		kind: z.literal('safe_inline'),
		classificationPolicy: versionedDefinitionRefSchema,
		inputSchema: safeSchemaManifestRefSchema,
		maximumCanonicalBytes: z
			.number()
			.int()
			.positive()
			.max(PENDING_GATEWAY_ACTION_LIMITS.maximumInlineBytes),
		value: z.json()
	})
	.superRefine((request, context) => {
		if (utf8Bytes(canonicalJsonText(request.value)) > request.maximumCanonicalBytes) {
			context.addIssue({
				code: 'custom',
				path: ['value'],
				message: 'Safe inline input exceeds its registered canonical byte bound.'
			});
		}
	});

const serverReferenceRequestSchema = z
	.strictObject({
		kind: z.literal('server_ref'),
		referenceSchema: safeSchemaManifestRefSchema,
		requestCodec: versionedDefinitionRefSchema,
		maximumReferenceBytes: z
			.number()
			.int()
			.positive()
			.max(PENDING_GATEWAY_ACTION_LIMITS.maximumServerReferenceBytes),
		reference: gatewayServerReferenceSchema
	})
	.superRefine((request, context) => {
		if (utf8Bytes(request.reference) > request.maximumReferenceBytes) {
			context.addIssue({
				code: 'custom',
				path: ['reference'],
				message: 'Server reference exceeds its registered byte bound.'
			});
		}
	});

export const pendingGatewayActionRequestSchema = z.discriminatedUnion('kind', [
	safeInlineRequestSchema,
	serverReferenceRequestSchema
]);

export const pendingGatewayActionStepSchema = z.strictObject({
	stepKey: definitionKeySchema,
	operation: z.strictObject({
		name: operationNameSchema,
		version: operationVersionSchema
	}),
	idempotencyKey: gatewayStageIdempotencyKeySchema,
	request: pendingGatewayActionRequestSchema
});

export const completedGatewayActionStepSchema = z.strictObject({
	stepKey: definitionKeySchema,
	operation: z.strictObject({
		name: operationNameSchema,
		version: operationVersionSchema
	}),
	completionReference: gatewayCompletionReferenceSchema
});

export const pendingGatewayActionIdentitySchema = gatewayPendingActionIdentitySchema;

export const pendingGatewayActionPartitionSchema = z.strictObject({
	sourceKey: gatewaySourceKeySchema,
	scopeKey: gatewayScopeKeySchema,
	principalPartitionKey: gatewayPrincipalPartitionKeySchema
});

const pendingGatewayActionStateSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('active') }),
	z.strictObject({
		kind: z.literal('completed'),
		completedAt: z.iso.datetime({ offset: true })
	}),
	z.strictObject({
		kind: z.literal('abandoned'),
		abandonedAt: z.iso.datetime({ offset: true })
	}),
	z.strictObject({
		kind: z.literal('expired'),
		expiredAt: z.iso.datetime({ offset: true })
	}),
	z.strictObject({
		kind: z.literal('quarantined'),
		reason: z.literal('disclosure_epoch_changed'),
		quarantinedAt: z.iso.datetime({ offset: true }),
		requiresServerResolution: z.literal(true)
	})
]);

function unreachable(value: never): never {
	throw new TypeError(`Unsupported PendingGatewayAction variant: ${JSON.stringify(value)}`);
}

function stateInstant(
	state: z.infer<typeof pendingGatewayActionStateSchema>,
	activeFallback: number
): number {
	switch (state.kind) {
		case 'active':
			return activeFallback;
		case 'completed':
			return Date.parse(state.completedAt);
		case 'abandoned':
			return Date.parse(state.abandonedAt);
		case 'expired':
			return Date.parse(state.expiredAt);
		case 'quarantined':
			return Date.parse(state.quarantinedAt);
		default:
			return unreachable(state);
	}
}

const pendingGatewayActionRecordBaseSchema = z.strictObject({
	schemaVersion: z.literal(1),
	identity: pendingGatewayActionIdentitySchema,
	disclosureEpoch: gatewayDisclosureEpochSchema,
	choreography: versionedDefinitionRefSchema,
	createdAt: z.iso.datetime({ offset: true }),
	updatedAt: z.iso.datetime({ offset: true }),
	expiresAt: z.iso.datetime({ offset: true }),
	retainUntil: z.iso.datetime({ offset: true }),
	revision: z.number().int().positive(),
	state: pendingGatewayActionStateSchema,
	currentStep: pendingGatewayActionStepSchema,
	completedSteps: z
		.array(completedGatewayActionStepSchema)
		.max(PENDING_GATEWAY_ACTION_LIMITS.maximumCompletedSteps)
});

export const pendingGatewayActionRecordSchema = pendingGatewayActionRecordBaseSchema.superRefine(
	(record, context) => {
		const createdAt = Date.parse(record.createdAt);
		const updatedAt = Date.parse(record.updatedAt);
		const expiresAt = Date.parse(record.expiresAt);
		const retainUntil = Date.parse(record.retainUntil);
		if (updatedAt < createdAt || updatedAt > retainUntil) {
			context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Update time is outside retention.' });
		}
		if (
			expiresAt <= createdAt ||
			expiresAt - createdAt > PENDING_GATEWAY_ACTION_LIMITS.maximumLifetimeMs
		) {
			context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Action lifetime is invalid.' });
		}
		if (
			retainUntil < expiresAt ||
			retainUntil - expiresAt >
				PENDING_GATEWAY_ACTION_LIMITS.maximumRetentionAfterExpiryMs
		) {
			context.addIssue({ code: 'custom', path: ['retainUntil'], message: 'Retention window is invalid.' });
		}

		const completedKeys = record.completedSteps.map((step) => step.stepKey);
		if (new Set(completedKeys).size !== completedKeys.length) {
			context.addIssue({
				code: 'custom',
				path: ['completedSteps'],
				message: 'Completed step keys must be unique.'
			});
		}
		const finalCompletion = record.completedSteps.at(-1);
		const currentStepIsFinalCompletion =
			finalCompletion?.stepKey === record.currentStep.stepKey &&
			finalCompletion.operation.name === record.currentStep.operation.name &&
			finalCompletion.operation.version === record.currentStep.operation.version;
		if (record.state.kind === 'completed' && !currentStepIsFinalCompletion) {
			context.addIssue({
				code: 'custom',
				path: ['completedSteps'],
				message: 'A completed action must end with completion evidence for its current step.'
			});
		}
		if (
			record.state.kind !== 'completed' &&
			completedKeys.includes(record.currentStep.stepKey)
		) {
			context.addIssue({
				code: 'custom',
				path: ['currentStep', 'stepKey'],
				message: 'Only a terminal completed record may include its current step as completed.'
			});
		}

		if (record.state.kind === 'expired' && Date.parse(record.state.expiredAt) < expiresAt) {
			context.addIssue({
				code: 'custom',
				path: ['state', 'expiredAt'],
				message: 'An action cannot expire before its declared expiry.'
			});
		}
		if (stateInstant(record.state, updatedAt) > updatedAt) {
			context.addIssue({
				code: 'custom',
				path: ['state'],
				message: 'State evidence cannot be newer than the record update.'
			});
		}
		if (record.state.kind === 'completed' && Date.parse(record.state.completedAt) < createdAt) {
			context.addIssue({ code: 'custom', path: ['state'], message: 'Completion predates creation.' });
		}
		if (record.state.kind === 'abandoned' && Date.parse(record.state.abandonedAt) < createdAt) {
			context.addIssue({ code: 'custom', path: ['state'], message: 'Abandonment predates creation.' });
		}
		if (
			record.state.kind === 'quarantined' &&
			Date.parse(record.state.quarantinedAt) < createdAt
		) {
			context.addIssue({ code: 'custom', path: ['state'], message: 'Quarantine predates creation.' });
		}

		if (
			utf8Bytes(
				canonicalJsonText(record as z.infer<ReturnType<typeof z.json>>)
			) > PENDING_GATEWAY_ACTION_LIMITS.maximumRecordBytes
		) {
			context.addIssue({ code: 'custom', message: 'Pending action exceeds its storage byte bound.' });
		}
	}
);

type DeepReadonly<Value> = Value extends string | number | boolean | null
	? Value
	: Value extends (...args: never[]) => unknown
		? Value
		: Value extends readonly (infer Item)[]
			? readonly DeepReadonly<Item>[]
			: Value extends object
				? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
				: Value;

export type PendingGatewayActionRequest = DeepReadonly<
	z.infer<typeof pendingGatewayActionRequestSchema>
>;
export type PendingGatewayActionStep = DeepReadonly<
	z.infer<typeof pendingGatewayActionStepSchema>
>;
export type PendingGatewayActionIdentity = DeepReadonly<
	z.infer<typeof pendingGatewayActionIdentitySchema>
>;
export type PendingGatewayActionPartition = DeepReadonly<
	z.infer<typeof pendingGatewayActionPartitionSchema>
>;
export type PendingGatewayActionRecord = DeepReadonly<
	z.infer<typeof pendingGatewayActionRecordSchema>
>;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value as DeepReadonly<Value>;
}

export function parsePendingGatewayActionRecord(value: unknown): PendingGatewayActionRecord {
	return deepFreeze(pendingGatewayActionRecordSchema.parse(value));
}

export type PendingGatewayActionStorageKey = string & {
	readonly __brand: 'PendingGatewayActionStorageKey';
};
export type PendingGatewayActionPartitionKey = string & {
	readonly __brand: 'PendingGatewayActionPartitionKey';
};

export function pendingGatewayActionStorageKey(
	identity: PendingGatewayActionIdentity
): PendingGatewayActionStorageKey {
	return JSON.stringify([
		identity.sourceKey,
		identity.scopeKey,
		identity.principalPartitionKey,
		identity.actionKey
	]) as PendingGatewayActionStorageKey;
}

export function pendingGatewayActionPartitionKey(
	partition: PendingGatewayActionPartition
): PendingGatewayActionPartitionKey {
	return JSON.stringify([
		partition.sourceKey,
		partition.scopeKey,
		partition.principalPartitionKey
	]) as PendingGatewayActionPartitionKey;
}

export function samePendingGatewayActionIdentity(
	left: PendingGatewayActionIdentity,
	right: PendingGatewayActionIdentity
): boolean {
	return pendingGatewayActionStorageKey(left) === pendingGatewayActionStorageKey(right);
}

export function samePendingGatewayActionPartition(
	identity: PendingGatewayActionIdentity,
	partition: PendingGatewayActionPartition
): boolean {
	return (
		identity.sourceKey === partition.sourceKey &&
		identity.scopeKey === partition.scopeKey &&
		identity.principalPartitionKey === partition.principalPartitionKey
	);
}

export function pendingGatewayActionRecordBytes(record: PendingGatewayActionRecord): number {
	return utf8Bytes(
		canonicalJsonText(record as unknown as z.infer<ReturnType<typeof z.json>>)
	);
}

export function pendingGatewayActionValuesEqual(left: unknown, right: unknown): boolean {
	const leftParsed = z.json().safeParse(left);
	const rightParsed = z.json().safeParse(right);
	return (
		leftParsed.success &&
		rightParsed.success &&
		canonicalJsonText(leftParsed.data) === canonicalJsonText(rightParsed.data)
	);
}
