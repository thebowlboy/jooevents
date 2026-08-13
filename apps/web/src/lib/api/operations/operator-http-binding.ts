import {
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeSchemaManifestRef
} from '@jooevents/contracts';

export type OperatorHttpBindingUnavailableReason =
	| 'invalid_operation_manifest'
	| 'operation_not_registered'
	| 'operation_registration_ambiguous'
	| 'operation_not_active'
	| 'operation_contract_mismatch'
	| 'operator_http_binding_not_registered'
	| 'operator_http_binding_ambiguous'
	| 'operator_http_binding_unsupported';

export type OperatorHttpBindingResolution =
	| { readonly kind: 'available'; readonly path: string }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export interface ExpectedOperatorHttpOperation {
	readonly name: string;
	readonly version: number;
	readonly effect: OperationEffect;
	readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	readonly input: 'query' | 'body';
	readonly idempotencyRequired: boolean;
	readonly inputSchema: SafeSchemaManifestRef;
	readonly resultSchema: SafeSchemaManifestRef;
}

function sameSchemaRef(left: SafeSchemaManifestRef, right: SafeSchemaManifestRef): boolean {
	return left.key === right.key
		&& left.version === right.version
		&& left.digestSha256 === right.digestSha256;
}

/**
 * Resolves one exact active operator HTTP binding from the browser-safe manifest.
 * A client never guesses a path or chooses between competing registrations.
 */
export function resolveOperatorHttpBinding(input: {
	readonly manifest: unknown;
	readonly expected: ExpectedOperatorHttpOperation;
}): OperatorHttpBindingResolution {
	const parsed = safeOperationManifestSchema.safeParse(input.manifest);
	if (!parsed.success) return { kind: 'unavailable', reason: 'invalid_operation_manifest' };

	const operations = parsed.data.operations.filter(
		(operation) =>
			operation.name === input.expected.name && operation.version === input.expected.version
	);
	if (operations.length === 0) {
		return { kind: 'unavailable', reason: 'operation_not_registered' };
	}
	if (operations.length !== 1) {
		return { kind: 'unavailable', reason: 'operation_registration_ambiguous' };
	}

	const operation = operations[0]!;
	if (operation.lifecycle.status !== 'active') {
		return { kind: 'unavailable', reason: 'operation_not_active' };
	}
	if (
		operation.effect !== input.expected.effect ||
		operation.idempotency.required !== input.expected.idempotencyRequired ||
		!sameSchemaRef(operation.inputSchema, input.expected.inputSchema)
	) {
		return { kind: 'unavailable', reason: 'operation_contract_mismatch' };
	}

	const bindings = operation.enabledBindings.filter(
		(binding) => binding.surface === 'operator_http'
	);
	if (bindings.length === 0) {
		return { kind: 'unavailable', reason: 'operator_http_binding_not_registered' };
	}
	if (bindings.length !== 1) {
		return { kind: 'unavailable', reason: 'operator_http_binding_ambiguous' };
	}

	const binding = bindings[0]!;
	if (
		binding.method !== input.expected.method ||
		binding.input !== input.expected.input ||
		binding.browserResumption.kind !== 'none' ||
		!sameSchemaRef(binding.resultSchema, input.expected.resultSchema)
	) {
		return {
			kind: 'unavailable',
			reason: sameSchemaRef(binding.resultSchema, input.expected.resultSchema)
				? 'operator_http_binding_unsupported'
				: 'operation_contract_mismatch'
		};
	}

	return { kind: 'available', path: binding.path };
}
