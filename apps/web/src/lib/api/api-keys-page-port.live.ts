import {
	API_KEY_OPERATION_SCHEMA_REFS,
	apiKeyCreateInputSchema,
	apiKeyCreateOperationResultSchema,
	apiKeyListOperationResultSchema,
	apiKeyRevokeInputSchema,
	apiKeyRevokeOperationResultSchema,
	apiKeyRotateInputSchema,
	apiKeyRotateOperationResultSchema,
	apiKeySecretDeliveryResultSchema,
	type ApiKeyListDataDto,
	type ApiKeyViewDto
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult } from './client';
import type {
	ApiKeyDraft,
	ApiKeyPermissionGroup,
	ApiKeysPagePort,
	ApiKeyView
} from './api-keys-page-port';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation
} from './operations/operator-http-binding';

const expected = Object.freeze({
	list: {
		name: 'workspace.api_key.list', version: 1, effect: 'read', method: 'GET', input: 'query',
		idempotencyRequired: false, ...API_KEY_OPERATION_SCHEMA_REFS.list
	},
	create: {
		name: 'workspace.api_key.create', version: 1, effect: 'commit', method: 'POST', input: 'body',
		idempotencyRequired: true, ...API_KEY_OPERATION_SCHEMA_REFS.create
	},
	rotate: {
		name: 'workspace.api_key.rotate', version: 1, effect: 'commit', method: 'POST', input: 'body',
		idempotencyRequired: true, ...API_KEY_OPERATION_SCHEMA_REFS.rotate
	},
	revoke: {
		name: 'workspace.api_key.revoke', version: 1, effect: 'commit', method: 'POST', input: 'body',
		idempotencyRequired: true, ...API_KEY_OPERATION_SCHEMA_REFS.revoke
	}
} as const satisfies Readonly<Record<string, ExpectedOperatorHttpOperation>>);

interface RequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}
export type ApiKeysPageRequester = (input: RequestInput) => Promise<ApiResult<unknown>>;

function keyView(value: ApiKeyViewDto): ApiKeyView {
	return Object.freeze({
		id: value.id, name: value.name, tokenHint: value.tokenHint,
		proposesChanges: value.proposesChanges, permissionIds: value.permissionIds,
		eventIds: value.eventIds, createdAt: value.createdAt, expiresAt: value.expiresAt,
		lastUsedAt: value.lastUsedAt, standing: value.standing, revokedAt: value.revokedAt,
		revokeReason: value.revokeReason
	});
}

function refusal(result: { readonly kind: string; readonly outcome?: { readonly class: string } }): string {
	if (result.outcome?.class === 'access_denied') return 'You no longer have permission to manage API keys.';
	if (result.outcome?.class === 'stale_revision') return 'That key changed while you were working. Reload and try again.';
	if (result.outcome?.class === 'policy_violation') return 'That key does not fit the workspace API-key policy.';
	return 'The API key change could not be completed.';
}

function transportRefusal(): string {
	return 'API keys could not be reached. Try again.';
}

export function createLiveApiKeysPagePort(input: {
	readonly manifest: unknown;
	readonly request?: ApiKeysPageRequester;
}): ApiKeysPagePort {
	const request = input.request ?? ((value: RequestInput) => requestJson(value));
	const bindings = Object.fromEntries(Object.entries(expected).map(([name, operation]) => [
		name, resolveOperatorHttpBinding({ manifest: input.manifest, expected: operation })
	])) as Record<keyof typeof expected, ReturnType<typeof resolveOperatorHttpBinding>>;
	const versions = new Map<string, number>();
	let snapshot: ApiKeyListDataDto | undefined;

	function remember(values: readonly ApiKeyViewDto[]): void {
		for (const value of values) versions.set(value.id, value.version);
	}

	async function load() {
		const binding = bindings.list;
		if (binding.kind !== 'available') return undefined;
		const response = await request({ path: binding.path, method: 'GET', schema: apiKeyListOperationResultSchema });
		if (response.kind !== 'success') return undefined;
		const parsed = apiKeyListOperationResultSchema.safeParse(response.data);
		if (!parsed.success || parsed.data.kind !== 'success') return undefined;
		snapshot = parsed.data.data;
		remember(snapshot.keys);
		return snapshot;
	}

	async function deliver(handle: string): Promise<string | undefined> {
		const result = await request({
			path: `/api/workspace/api-key-secrets/${encodeURIComponent(handle)}`,
			method: 'POST', schema: apiKeySecretDeliveryResultSchema
		});
		if (result.kind !== 'success') return undefined;
		const parsed = apiKeySecretDeliveryResultSchema.safeParse(result.data);
		return parsed.success && parsed.data.kind === 'delivered' ? parsed.data.secret : undefined;
	}

	const initial = (() => {
		const empty = { timezone: 'UTC', permissions: [], profiles: [], events: [], expiry: {
			defaultDays: 90, maxDays: 365, rotationGraceHours: 168
		} };
		return empty;
	})();

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		get timezone() { return snapshot?.timezone ?? initial.timezone; },
		get catalog(): readonly ApiKeyPermissionGroup[] {
			const groups = new Map<string, ApiKeyPermissionGroup>();
			for (const permission of snapshot?.permissions ?? initial.permissions) {
				const current = groups.get(permission.group);
				const item = Object.freeze({
					id: permission.id, label: permission.label, description: permission.description,
					risk: permission.risk, held: permission.held
				});
				groups.set(permission.group, Object.freeze({
					key: permission.group, label: permission.groupLabel,
					permissions: Object.freeze([...(current?.permissions ?? []), item])
				}));
			}
			return Object.freeze([...groups.values()]);
		},
		get profiles() { return snapshot?.profiles ?? initial.profiles; },
		get events() { return snapshot?.events ?? initial.events; },
		get expiry() {
			const policy = snapshot?.expiry ?? initial.expiry;
			return Object.freeze({
				defaultDays: policy.defaultDays, maxDays: policy.maxDays,
				rotationGraceDays: policy.rotationGraceHours / 24
			});
		},
		async list() {
			const data = await load();
			return data?.keys.map(keyView) ?? [];
		},
		async create(draft: ApiKeyDraft) {
			const binding = bindings.create;
			if (binding.kind !== 'available') return { kind: 'refused' as const, reason: transportRefusal() };
			const body = apiKeyCreateInputSchema.safeParse({
				name: draft.name, mayRead: true, maySubmitPlans: draft.proposesChanges,
				permissionIds: [...new Set(draft.permissionIds)].sort(),
				eventIds: [...new Set(draft.eventIds)].sort(), expiresInDays: draft.expiresInDays
			});
			if (!body.success) return { kind: 'refused' as const, reason: 'Choose at least one valid permission for this key.' };
			const response = await request({
				path: binding.path, method: 'POST', schema: apiKeyCreateOperationResultSchema,
				body: body.data, idempotencyKey: crypto.randomUUID()
			});
			if (response.kind !== 'success') return { kind: 'refused' as const, reason: transportRefusal() };
			const parsed = apiKeyCreateOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return { kind: 'refused' as const, reason: transportRefusal() };
			if (parsed.data.kind !== 'success') return { kind: 'refused' as const, reason: refusal(parsed.data) };
			remember([parsed.data.data.key]);
			const secret = await deliver(parsed.data.data.secretHandle);
			return secret === undefined
				? { kind: 'refused' as const, reason: 'The key was created, but its one-time value could not be shown. Rotate it to get a replacement.' }
				: { kind: 'created' as const, key: keyView(parsed.data.data.key), secret };
		},
		async rotate(id: string) {
			const binding = bindings.rotate;
			if (binding.kind !== 'available') return { kind: 'refused' as const, reason: transportRefusal() };
			if (!versions.has(id)) await load();
			const body = apiKeyRotateInputSchema.safeParse({ apiKeyId: id, expectedVersion: versions.get(id) });
			if (!body.success) return { kind: 'refused' as const, reason: 'That key is no longer available. Reload and try again.' };
			const response = await request({
				path: binding.path, method: 'POST', schema: apiKeyRotateOperationResultSchema,
				body: body.data, idempotencyKey: crypto.randomUUID()
			});
			if (response.kind !== 'success') return { kind: 'refused' as const, reason: transportRefusal() };
			const parsed = apiKeyRotateOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return { kind: 'refused' as const, reason: transportRefusal() };
			if (parsed.data.kind !== 'success') return { kind: 'refused' as const, reason: refusal(parsed.data) };
			remember([parsed.data.data.predecessor, parsed.data.data.successor]);
			const secret = await deliver(parsed.data.data.secretHandle);
			return secret === undefined
				? { kind: 'refused' as const, reason: 'The key was rotated, but its one-time value could not be shown. Rotate the replacement again.' }
				: {
					kind: 'rotated' as const, predecessor: keyView(parsed.data.data.predecessor),
					successor: keyView(parsed.data.data.successor), secret
				};
		},
		async revoke(id: string) {
			const binding = bindings.revoke;
			if (binding.kind !== 'available') return { kind: 'refused' as const, reason: transportRefusal() };
			if (!versions.has(id)) await load();
			const body = apiKeyRevokeInputSchema.safeParse({
				apiKeyId: id, expectedVersion: versions.get(id), reason: 'owner_request'
			});
			if (!body.success) return { kind: 'refused' as const, reason: 'That key is no longer available. Reload and try again.' };
			const response = await request({
				path: binding.path, method: 'POST', schema: apiKeyRevokeOperationResultSchema,
				body: body.data, idempotencyKey: crypto.randomUUID()
			});
			if (response.kind !== 'success') return { kind: 'refused' as const, reason: transportRefusal() };
			const parsed = apiKeyRevokeOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return { kind: 'refused' as const, reason: transportRefusal() };
			if (parsed.data.kind !== 'success') return { kind: 'refused' as const, reason: refusal(parsed.data) };
			remember([parsed.data.data]);
			return { kind: 'revoked' as const, key: keyView(parsed.data.data) };
		}
	});
}
