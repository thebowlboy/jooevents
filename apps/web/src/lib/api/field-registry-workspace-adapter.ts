import type {
	FieldRegistryContexts,
	FieldRegistryDraftRequest,
	StructuredOutcome
} from '@jooevents/contracts';
import {
	inferFieldRegistryAnswerOwner,
	mapFieldRegistryMutation,
	type FieldRegistryMappedField,
	type FieldRegistrySnapshotView
} from './mappers/field-registry';
import type {
	FieldRegistryLiveApplyResult,
	FieldRegistryLiveClient,
	FieldRegistryLiveReadResult
} from './operations/field-registry-live';
import type { SettingsPageFieldsPort } from './settings-page-port';
import type { FieldContext, MutationOutcome, RegistryField } from './types';

export type WorkspaceFieldsApi = SettingsPageFieldsPort;

const fieldContexts = Object.freeze(['apply', 'onboard', 'profile'] as const satisfies readonly FieldContext[]);

const lockedFieldRefusal =
	'Email is how applicants are identified and reached — it cannot be removed from the application';

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** A safe, reviewed-copy failure from the source-neutral adapter boundary. */
export class FieldRegistryWorkspaceAdapterError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'FieldRegistryWorkspaceAdapterError';
		this.code = failure.code;
	}
}

function detailCode(outcome: StructuredOutcome): string | undefined {
	if (typeof outcome.detail !== 'object' || outcome.detail === null) return undefined;
	const code = (outcome.detail as { readonly code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function outcomeFailure(outcome: StructuredOutcome): AdapterFailure {
	const code = detailCode(outcome);
	if (code === 'locked_field') {
		return { code: outcome.kind, reason: lockedFieldRefusal };
	}
	if (code === 'field_missing' || code === 'field_removed') {
		return { code: outcome.kind, reason: 'This field no longer exists' };
	}
	if (code === 'invalid_options') {
		return { code: outcome.kind, reason: 'These choices are no longer valid. Review them and try again.' };
	}
	if (code === 'invalid_position') {
		return { code: outcome.kind, reason: 'That position is no longer available. Reload the fields and try again.' };
	}
	if (outcome.class === 'stale_revision'
		|| code === 'stale_registry'
		|| code === 'stale_field'
		|| code === 'form_changed'
		|| code === 'policy_changed') {
		return { code: outcome.kind, reason: 'Speaker fields changed while you were working. Reload and try again.' };
	}
	if (outcome.class === 'access_denied') {
		return { code: outcome.kind, reason: 'You no longer have permission to change speaker fields.' };
	}
	if (outcome.kind === 'field_registry.event_required') {
		return { code: outcome.kind, reason: 'Create or select an event before changing speaker fields.' };
	}
	if (outcome.class === 'idempotency_conflict') {
		return { code: outcome.kind, reason: 'This action changed before it finished. Reload and try it again.' };
	}
	return { code: outcome.kind, reason: 'This speaker-field change could not be applied.' };
}

function readFailure(result: Exclude<FieldRegistryLiveReadResult, { readonly kind: 'success' }>): AdapterFailure {
	if (result.kind === 'outcome') return outcomeFailure(result.outcome);
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Speaker fields are not available in this live workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Speaker fields could not be reached. Try again.'
			: 'This speaker-field request is not valid.'
	};
}

function applyFailure(result: Exclude<FieldRegistryLiveApplyResult, { readonly kind: 'success' }>): AdapterFailure {
	if (result.kind === 'outcome') return outcomeFailure(result.outcome);
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Speaker-field changes are not available in this live workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'The speaker-field change could not be confirmed. Try again.'
			: 'This speaker-field change is not valid.'
	};
}

function contextsFor(input: {
	readonly collectAt: readonly FieldContext[];
	readonly required: Partial<Record<FieldContext, boolean>>;
}): FieldRegistryContexts {
	return {
		apply: {
			visible: input.collectAt.includes('apply'),
			required: input.collectAt.includes('apply') && input.required.apply === true
		},
		onboard: {
			visible: input.collectAt.includes('onboard'),
			required: input.collectAt.includes('onboard') && input.required.onboard === true
		},
		profile: {
			visible: input.collectAt.includes('profile'),
			required: input.collectAt.includes('profile') && input.required.profile === true
		}
	};
}

function cloneFields(snapshot: FieldRegistrySnapshotView): RegistryField[] {
	return snapshot.fields.map(({ field }) => structuredClone(field));
}

function defaultIdempotencyKey(): string {
	return `je.field-registry.action.${globalThis.crypto.randomUUID()}`;
}

/**
 * Adapts the versioned operation workflow to the exact field methods already
 * consumed by the tuned Settings, Forms, and template interactions. It owns no
 * sample fallback and never asks a component to manufacture canonical guards.
 */
export function createFieldRegistryWorkspaceAdapter(input: {
	readonly client: FieldRegistryLiveClient;
	readonly newIdempotencyKey?: () => string;
}): WorkspaceFieldsApi {
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const removedVersions = new Map<string, number>();

	async function readSnapshot(): Promise<FieldRegistrySnapshotView> {
		const result = await input.client.read();
		if (result.kind !== 'success') throw new FieldRegistryWorkspaceAdapterError(readFailure(result));
		return result.data;
	}

	async function apply(
		request: FieldRegistryDraftRequest,
		current: FieldRegistrySnapshotView
	) {
		const result = await input.client.apply(request, newIdempotencyKey());
		if (result.kind !== 'success') throw new FieldRegistryWorkspaceAdapterError(applyFailure(result));
		return mapFieldRegistryMutation(result.data.safeDiff, cloneFields(current));
	}

	async function guardedFailure(
		work: () => Promise<void>
	): Promise<MutationOutcome> {
		try {
			await work();
			return { ok: true };
		} catch (error) {
			if (error instanceof FieldRegistryWorkspaceAdapterError) {
				return { ok: false, reason: error.message };
			}
			throw error;
		}
	}

	function find(snapshot: FieldRegistrySnapshotView, id: string): FieldRegistryMappedField | undefined {
		return snapshot.fields.find(({ field }) => field.id === id);
	}

	const adapter: WorkspaceFieldsApi = {
		async list(): Promise<RegistryField[]> {
			return cloneFields(await readSnapshot());
		},

		async add(addInput) {
			const snapshot = await readSnapshot();
			const required = Object.fromEntries(
				fieldContexts.map((context) => [context, addInput.requiredIn?.includes(context) === true])
			) as Record<FieldContext, boolean>;
			const choiceKind = addInput.kind === 'select' || addInput.kind === 'multiselect';
			const request: FieldRegistryDraftRequest = {
				action: 'add',
				request: {
					expectedRegistryVersion: snapshot.version,
					field: {
						kind: addInput.kind,
						label: addInput.label,
						...(addInput.help === undefined ? {} : { help: addInput.help || null }),
						answerOwner: inferFieldRegistryAnswerOwner(addInput),
						scope: addInput.formScope
							? { kind: 'form', formId: addInput.formScope }
							: { kind: 'shared' },
						contexts: contextsFor({ collectAt: addInput.collectAt, required }),
						options: choiceKind
							? { kind: 'custom', labels: addInput.options ?? [] }
							: { kind: 'none' }
					}
				}
			};
			const mutation = await apply(request, snapshot);
			if (!mutation.field || !mutation.placement) {
				throw new FieldRegistryWorkspaceAdapterError({
					code: 'invalid_contract',
					reason: 'The speaker-field change returned an invalid result.'
				});
			}
			return {
				field: structuredClone(mutation.field),
				placement: { ...mutation.placement }
			};
		},

		async update(id, patch): Promise<MutationOutcome> {
			return guardedFailure(async () => {
				const snapshot = await readSnapshot();
				const current = find(snapshot, id);
				if (!current) {
					throw new FieldRegistryWorkspaceAdapterError({
						code: 'field_missing', reason: 'This field no longer exists'
					});
				}
				const changes: {
					label?: string;
					help?: string | null;
					contexts?: FieldRegistryContexts;
					customOptionLabels?: string[];
				} = {};
				if (patch.label !== undefined) changes.label = patch.label;
				if (patch.help !== undefined) changes.help = patch.help || null;
				if (patch.options !== undefined) changes.customOptionLabels = [...patch.options];
				if (patch.collectAt !== undefined || patch.required !== undefined) {
					changes.contexts = contextsFor({
						collectAt: patch.collectAt ?? current.field.collectAt,
						required: patch.required ?? current.field.required
					});
				}
				if (Object.keys(changes).length === 0) return;
				await apply({
					action: 'edit',
					request: {
						fieldId: current.field.id,
						expectedFieldVersion: current.version,
						expectedRegistryVersion: snapshot.version,
						changes
					}
				}, snapshot);
			});
		},

		async remove(id): Promise<MutationOutcome> {
			return guardedFailure(async () => {
				const snapshot = await readSnapshot();
				const current = find(snapshot, id);
				if (!current) return;
				await apply({
					action: 'remove',
					request: {
						fieldId: current.field.id,
						expectedFieldVersion: current.version,
						expectedRegistryVersion: snapshot.version
					}
				}, snapshot);
				removedVersions.set(current.field.id, current.version);
			});
		},

		async move(id, toIndex): Promise<MutationOutcome> {
			return guardedFailure(async () => {
				const snapshot = await readSnapshot();
				const current = find(snapshot, id);
				if (!current) {
					throw new FieldRegistryWorkspaceAdapterError({
						code: 'field_missing', reason: 'This field no longer exists'
					});
				}
				await apply({
					action: 'move',
					request: {
						fieldId: current.field.id,
						expectedFieldVersion: current.version,
						expectedRegistryVersion: snapshot.version,
						toIndex
					}
				}, snapshot);
			});
		},

		async restore(field, index): Promise<void> {
			const snapshot = await readSnapshot();
			if (find(snapshot, field.id)) return;
			const fieldVersion = removedVersions.get(field.id);
			if (fieldVersion === undefined) {
				throw new FieldRegistryWorkspaceAdapterError({
					code: 'restore_version_unavailable',
					reason: 'This removed field can no longer be restored from this page. Reload the history and try again.'
				});
			}
			await apply({
				action: 'restore',
				request: {
					fieldId: field.id,
					expectedFieldVersion: fieldVersion,
					expectedRegistryVersion: snapshot.version,
					toIndex: index
				}
			}, snapshot);
			removedVersions.delete(field.id);
		}
	};
	return Object.freeze(adapter);
}
