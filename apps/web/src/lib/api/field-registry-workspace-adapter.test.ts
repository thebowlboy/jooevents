import { describe, expect, test } from 'bun:test';
import type {
	FieldRegistryDraftRequest,
	FieldRegistryFieldDefinitionDto,
	FieldRegistrySafeDiff
} from '@jooevents/contracts';
import {
	createFieldRegistryWorkspaceAdapter,
	FieldRegistryWorkspaceAdapterError
} from './field-registry-workspace-adapter';
import type { FieldRegistrySnapshotView } from './mappers/field-registry';
import type {
	FieldRegistryLiveApplyResult,
	FieldRegistryLiveClient,
	FieldRegistryLiveReadResult
} from './operations/field-registry-live';
import type { RegistryField } from './types';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const fieldId = id(3);
const changesetId = id(4);
const revisionId = id(5);
const correlationId = id(900);
const receipt = Object.freeze({
	id: id(901),
	operationName: 'changeset.commit',
	operationVersion: 1
});

const field: RegistryField = Object.freeze({
	id: fieldId,
	kind: 'text',
	label: 'Company',
	help: 'Where you work.',
	required: { apply: true },
	collectAt: ['apply', 'onboard'] as RegistryField['collectAt'],
	group: 'identity',
	position: 0
});

function snapshot(
	version: number,
	fields: readonly { readonly field: RegistryField; readonly version: number }[] = [
		{ field, version: 2 }
	]
): FieldRegistrySnapshotView {
	return Object.freeze({ workspaceId, eventId, version, fields: Object.freeze([...fields]) });
}

function definition(overrides: Partial<FieldRegistryFieldDefinitionDto> = {}): FieldRegistryFieldDefinitionDto {
	return {
		id: fieldId,
		key: 'person.company',
		version: 2,
		kind: 'text',
		label: 'Company',
		help: 'Where you work.',
		mapsTo: null,
		purpose: { kind: 'ordinary' },
		answerOwner: 'person',
		scope: { kind: 'shared' },
		group: 'identity',
		position: 0,
		contexts: {
			apply: { visible: true, required: true },
			onboard: { visible: true, required: false },
			profile: { visible: false, required: false }
		},
		options: { kind: 'none' },
		constraints: { removal: 'allowed', applyVisibility: 'editable' },
		fileUpload: 'not_applicable',
		...overrides
	};
}

function applied(diff: FieldRegistrySafeDiff): FieldRegistryLiveApplyResult {
	return {
		kind: 'success',
		data: {
			action: diff.action,
			changesetId,
			revisionId,
			revisionDigest: 'a'.repeat(64),
			committedHeadVersion: 3,
			safeDiff: diff
		},
		receipt,
		correlationId
	};
}

function liveClient(input: {
	readonly reads: readonly FieldRegistryLiveReadResult[];
	readonly apply?: (
		request: FieldRegistryDraftRequest,
		idempotencyKey: string
	) => FieldRegistryLiveApplyResult | Promise<FieldRegistryLiveApplyResult>;
}): FieldRegistryLiveClient {
	let readIndex = 0;
	return {
		async read() {
			const result = input.reads[Math.min(readIndex, input.reads.length - 1)];
			readIndex += 1;
			if (!result) throw new TypeError('missing_read_fixture');
			return result;
		},
		async apply(request, key) {
			if (!input.apply) throw new TypeError('unexpected_apply');
			return input.apply(request, key);
		}
	};
}

function readSuccess(data: FieldRegistrySnapshotView): FieldRegistryLiveReadResult {
	return { kind: 'success', data, correlationId };
}

describe('source-neutral Field Registry Workspace fields adapter', () => {
	test('lists detached canonical fields without consulting sample state', async () => {
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({ reads: [readSuccess(snapshot(4))] })
		});
		const listed = await api.list();
		expect(listed).toEqual([field]);
		listed[0]!.label = 'Changed only in the consumer';
		expect(field.label).toBe('Company');
	});

	test('translates the tuned add input into a guarded canonical draft and returns compact placement', async () => {
		let captured: { request: FieldRegistryDraftRequest; key: string } | undefined;
		const after = definition({
			version: 1,
			key: 'custom.talk_topic_00000000',
			label: 'Talk topic',
			help: null,
			answerOwner: 'talk',
			group: 'talk',
			contexts: {
				apply: { visible: true, required: true },
				onboard: { visible: false, required: false },
				profile: { visible: false, required: false }
			}
		});
		const diff: FieldRegistrySafeDiff = {
			action: 'add',
			registryVersionBefore: 1,
			registryVersionAfter: 2,
			before: null,
			after,
			placement: {
				index: 0,
				group: 'talk',
				reasonKey: 'field_registry.placement.first'
			}
		};
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess(snapshot(1, []))],
				apply(request, key) {
					captured = { request, key };
					return applied(diff);
				}
			}),
			newIdempotencyKey: () => 'field-add-1'
		});

		expect(await api.add({
			kind: 'text',
			label: 'Talk topic',
			collectAt: ['apply'],
			requiredIn: ['apply']
		})).toMatchObject({
			field: { id: fieldId, label: 'Talk topic', group: 'talk' },
			placement: { index: 0, group: 'talk', reason: 'Placed as the first question.' }
		});
		expect(captured).toEqual({
			key: 'field-add-1',
			request: {
				action: 'add',
				request: {
					expectedRegistryVersion: 1,
					field: {
						kind: 'text',
						label: 'Talk topic',
						answerOwner: 'talk',
						scope: { kind: 'shared' },
						contexts: {
							apply: { visible: true, required: true },
							onboard: { visible: false, required: false },
							profile: { visible: false, required: false }
						},
						options: { kind: 'none' }
					}
				}
			}
		});
	});

	test('recovers hidden versions for edit and clears requiredness when a context is hidden', async () => {
		let captured: FieldRegistryDraftRequest | undefined;
		const diff: FieldRegistrySafeDiff = {
			action: 'edit',
			registryVersionBefore: 4,
			registryVersionAfter: 5,
			before: definition(),
			after: definition({
				version: 3,
				help: null,
				contexts: {
					apply: { visible: false, required: false },
					onboard: { visible: true, required: false },
					profile: { visible: false, required: false }
				}
			})
		};
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess(snapshot(4))],
				apply(request) {
					captured = request;
					return applied(diff);
				}
			}),
			newIdempotencyKey: () => 'field-edit-1'
		});
		expect(await api.update(fieldId, { collectAt: ['onboard'], help: '' })).toEqual({ ok: true });
		expect(captured).toEqual({
			action: 'edit',
			request: {
				fieldId,
				expectedFieldVersion: 2,
				expectedRegistryVersion: 4,
				changes: {
					help: null,
					contexts: {
						apply: { visible: false, required: false },
						onboard: { visible: true, required: false },
						profile: { visible: false, required: false }
					}
				}
			}
		});
	});

	test('translates the tuned drag target into an exact guarded move', async () => {
		let captured: FieldRegistryDraftRequest | undefined;
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess(snapshot(8))],
				apply(request) {
					captured = request;
					return applied({
						action: 'move',
						registryVersionBefore: 8,
						registryVersionAfter: 9,
						fieldId,
						fieldVersion: 2,
						beforeIndex: 0,
						afterIndex: 0
					});
				}
			}),
			newIdempotencyKey: () => 'field-move-1'
		});
		expect(await api.move(fieldId, 0)).toEqual({ ok: true });
		expect(captured).toEqual({
			action: 'move',
			request: {
				fieldId,
				expectedFieldVersion: 2,
				expectedRegistryVersion: 8,
				toIndex: 0
			}
		});
	});

	test('retains the removed field version only for the existing receipt restore path', async () => {
		const requests: FieldRegistryDraftRequest[] = [];
		const removeDiff: FieldRegistrySafeDiff = {
			action: 'remove',
			registryVersionBefore: 5,
			registryVersionAfter: 6,
			before: definition(),
			after: null
		};
		const restoreDiff: FieldRegistrySafeDiff = {
			action: 'restore',
			registryVersionBefore: 6,
			registryVersionAfter: 7,
			before: null,
			after: definition({ version: 3 }),
			placement: {
				index: 0,
				group: 'identity',
				reasonKey: 'field_registry.placement.restore'
			}
		};
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess(snapshot(5)), readSuccess(snapshot(6, []))],
				apply(request) {
					requests.push(request);
					return applied(request.action === 'remove' ? removeDiff : restoreDiff);
				}
			}),
			newIdempotencyKey: () => `field-action-${requests.length}`
		});
		expect(await api.remove(fieldId)).toEqual({ ok: true });
		await api.restore(field, 0);
		expect(requests).toEqual([{
			action: 'remove',
			request: { fieldId, expectedFieldVersion: 2, expectedRegistryVersion: 5 }
		}, {
			action: 'restore',
			request: { fieldId, expectedFieldVersion: 2, expectedRegistryVersion: 6, toIndex: 0 }
		}]);
	});

	test('maps canonical lock and authority refusals into the existing tuned mutation outcome', async () => {
		const lockedOutcome: FieldRegistryLiveApplyResult = {
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: {
				class: 'policy_violation',
				kind: 'field_registry.change_refused',
				retryable: false,
				subjects: [],
				detail: { code: 'locked_field', action: 'remove', fieldId },
				detailSchemaVersion: 1
			}
		};
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [readSuccess(snapshot(1))],
				apply: () => lockedOutcome
			}),
			newIdempotencyKey: () => 'locked-field'
		});
		expect(await api.remove(fieldId)).toEqual({
			ok: false,
			reason: 'Email is how applicants are identified and reached — it cannot be removed from the application'
		});
	});

	test('fails pure live reads visibly instead of falling back to a sample registry', async () => {
		const api = createFieldRegistryWorkspaceAdapter({
			client: liveClient({
				reads: [{
					kind: 'unavailable',
					operation: 'snapshot',
					reason: 'operation_not_registered'
				}]
			})
		});
		await expect(api.list()).rejects.toEqual(expect.objectContaining({
			name: 'FieldRegistryWorkspaceAdapterError',
			code: 'operation_not_registered'
		}));
		try {
			await api.list();
		} catch (error) {
			expect(error).toBeInstanceOf(FieldRegistryWorkspaceAdapterError);
		}
	});
});
