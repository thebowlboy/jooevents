import { describe, expect, test } from 'bun:test';
import {
	fieldRegistryFieldViewSchema,
	fieldRegistrySafeDiffSchema,
	fieldRegistrySnapshotSchema
} from '@jooevents/contracts';
import {
	inferFieldRegistryAnswerOwner,
	mapFieldRegistryField,
	mapFieldRegistryMutation,
	mapFieldRegistrySnapshot
} from './field-registry';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789ab';
const fieldId = '018f7d5a-4b3c-7abc-8def-0123456789b0';
const choiceId = '018f7d5a-4b3c-7abc-8def-0123456789b1';
const formId = '018f7d5a-4b3c-7abc-8def-0123456789b2';

const hidden = Object.freeze({ visible: false, required: false });
const optional = Object.freeze({ visible: true, required: false });
const required = Object.freeze({ visible: true, required: true });

function field(overrides: Record<string, unknown> = {}) {
	return fieldRegistryFieldViewSchema.parse({
		id: fieldId,
		key: 'person.company',
		version: 3,
		kind: 'select',
		label: 'Company',
		help: 'Where you work.',
		answerOwner: 'person',
		mapsTo: null,
		purpose: { kind: 'ordinary' },
		scope: { kind: 'form', formId },
		group: 'identity',
		position: 0,
		contexts: { apply: required, onboard: hidden, profile: hidden },
		options: {
			kind: 'custom',
			choices: [{ id: choiceId, key: 'independent', label: 'Independent', position: 0 }]
		},
		constraints: { removal: 'forbidden', applyVisibility: 'required_visible' },
		fileUpload: 'not_applicable',
		resolvedOptions: null,
		...overrides
	});
}

describe('Field Registry browser mapper', () => {
	test('uses the tuned deterministic classifier for answer ownership across every group', () => {
		const cases = [
			{ kind: 'text' as const, label: 'Your name', owner: 'person' as const },
			{ kind: 'email' as const, label: 'Topic', owner: 'person' as const },
			{ kind: 'url' as const, label: 'Session', owner: 'person' as const },
			{ kind: 'text' as const, label: 'Talk topic', owner: 'talk' as const },
			{ kind: 'date' as const, label: 'Session', owner: 'person' as const },
			{ kind: 'file' as const, label: 'Talk title', owner: 'person' as const },
			{ kind: 'text' as const, label: 'Unfamiliar question', owner: 'person' as const },
			{ kind: 'checkbox' as const, label: 'I consent to recording', owner: 'person' as const }
		];
		expect(cases.map(({ kind, label }) => inferFieldRegistryAnswerOwner({ kind, label })))
			.toEqual(cases.map(({ owner }) => owner));
	});

	test('maps canonical contexts, custom choices, form scope, versions, and lock constraints', () => {
		expect(mapFieldRegistryField(field())).toEqual({
			id: fieldId,
			kind: 'select',
			label: 'Company',
			help: 'Where you work.',
			required: { apply: true },
			collectAt: ['apply'],
			options: ['Independent'],
			group: 'identity',
			position: 0,
			formScope: formId,
			locked: true
		});

		const snapshot = mapFieldRegistrySnapshot(fieldRegistrySnapshotSchema.parse({
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			version: 7,
			registryDigestSha256: 'a'.repeat(64),
			fields: [field()]
		}));
		expect(snapshot).toMatchObject({
			workspaceId,
			eventId,
			version: 7,
			fields: [{ version: 3, field: { id: fieldId, formScope: formId } }]
		});
	});

	test('projects live vocabulary options and keeps the source identity', () => {
		const mapped = mapFieldRegistryField(field({
			key: 'talk.track',
			answerOwner: 'talk',
			scope: { kind: 'shared' },
			group: 'talk',
			options: { kind: 'program_vocabulary', source: 'tracks' },
			constraints: { removal: 'allowed', applyVisibility: 'editable' },
			resolvedOptions: [{ id: choiceId, label: 'Infrastructure', version: 2 }]
		}));
		expect(mapped).toMatchObject({
			optionSource: 'tracks',
			options: ['Infrastructure']
		});
		expect(mapped.locked).toBeUndefined();
	});

	test('maps the exact add diff into the compact placement result used by the tuned composer', () => {
		const added = field({
			scope: { kind: 'shared' },
			constraints: { removal: 'allowed', applyVisibility: 'editable' },
			position: 1
		});
		const diff = fieldRegistrySafeDiffSchema.parse({
			action: 'add',
			registryVersionBefore: 7,
			registryVersionAfter: 8,
			before: null,
			after: Object.fromEntries(Object.entries(added).filter(([key]) => key !== 'resolvedOptions')),
			placement: {
				index: 1,
				group: 'identity',
				reasonKey: 'field_registry.placement.after_identity'
			}
		});
		expect(mapFieldRegistryMutation(diff, [{
			id: '018f7d5a-4b3c-7abc-8def-0123456789bf',
			kind: 'text',
			label: 'Your name',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'identity',
			position: 0
		}])).toMatchObject({
			action: 'add',
			registryVersionBefore: 7,
			registryVersionAfter: 8,
			fieldId,
			fieldVersion: 3,
			position: 1,
			placement: {
				index: 1,
				group: 'identity',
				reason: 'Placed with the other identity questions, after “Your name”.'
			}
		});
	});
});
