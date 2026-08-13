import type {
	FieldRegistryAnswerOwner,
	FieldRegistryFieldViewDto,
	FieldRegistryGroup,
	FieldRegistrySafeDiff,
	FieldRegistrySnapshotDto
} from '@jooevents/contracts';
import { classifyField, type PlacementSuggestion } from '../placement';
import type { FieldContext, RegistryField } from '../types';

const contexts = Object.freeze(['apply', 'onboard', 'profile'] as const satisfies readonly FieldContext[]);

const groupNouns = Object.freeze({
	identity: 'identity',
	contact: 'contact',
	presence: 'links & social',
	talk: 'talk',
	logistics: 'logistics',
	materials: 'materials',
	other: 'general',
	consent: 'consent'
} as const satisfies Readonly<Record<FieldRegistryGroup, string>>);

function unreachable(value: never): never {
	throw new TypeError(`unsupported_field_registry_group:${String(value)}`);
}

/**
 * The tuned add control asks for kind and label rather than exposing the
 * storage-owner distinction. Its existing deterministic classifier therefore
 * owns the source-neutral translation: talk-group answers belong to the talk;
 * every other declared group belongs to the person.
 */
export function inferFieldRegistryAnswerOwner(input: {
	readonly kind: RegistryField['kind'];
	readonly label: string;
}): FieldRegistryAnswerOwner {
	const group = classifyField(input.kind, input.label);
	switch (group) {
		case 'talk':
			return 'talk';
		case 'identity':
		case 'contact':
		case 'presence':
		case 'logistics':
		case 'materials':
		case 'other':
		case 'consent':
			return 'person';
		default:
			return unreachable(group);
	}
}

export interface FieldRegistryMappedField {
	readonly field: RegistryField;
	readonly version: number;
}

export interface FieldRegistrySnapshotView {
	readonly workspaceId: string;
	readonly eventId: string;
	readonly version: number;
	readonly fields: readonly FieldRegistryMappedField[];
}

/** Maps one canonical definition onto the already-tuned browser field model. */
export function mapFieldRegistryField(field: FieldRegistryFieldViewDto): RegistryField {
	const collectAt = contexts.filter((context) => field.contexts[context].visible);
	const required: Partial<Record<FieldContext, boolean>> = {};
	for (const context of contexts) {
		if (field.contexts[context].required) required[context] = true;
	}

	const options = field.options.kind === 'custom'
		? field.options.choices.map((choice) => choice.label)
		: field.options.kind === 'program_vocabulary'
			? (field.resolvedOptions ?? []).map((choice) => choice.label)
			: undefined;

	return {
		id: field.id,
		kind: field.kind,
		label: field.label,
		...(field.help === null ? {} : { help: field.help }),
		required,
		collectAt: [...collectAt],
		...(options === undefined ? {} : { options: [...options] }),
		...(field.options.kind === 'program_vocabulary'
			? { optionSource: field.options.source }
			: {}),
		group: field.group,
		position: field.position,
		...(field.scope.kind === 'form' ? { formScope: field.scope.formId } : {}),
		...(field.constraints.removal === 'forbidden'
			|| field.constraints.applyVisibility === 'required_visible'
			? { locked: true }
			: {})
	};
}

export function mapFieldRegistrySnapshot(snapshot: FieldRegistrySnapshotDto): FieldRegistrySnapshotView {
	return Object.freeze({
		workspaceId: snapshot.scope.workspaceId,
		eventId: snapshot.scope.eventId,
		version: snapshot.version,
		fields: Object.freeze(snapshot.fields.map((field) => Object.freeze({
			field: mapFieldRegistryField(field),
			version: field.version
		})))
	});
}

function placementReason(
	placement: { readonly index: number; readonly group: FieldRegistryGroup; readonly reasonKey: string },
	current: readonly RegistryField[]
): string {
	const noun = groupNouns[placement.group];
	if (placement.reasonKey === 'field_registry.placement.first') {
		return 'Placed as the first question.';
	}
	if (placement.reasonKey === `field_registry.placement.after_${placement.group}`) {
		const anchor = current[placement.index - 1];
		return anchor
			? `Placed with the other ${noun} questions, after “${anchor.label}”.`
			: `Placed with the other ${noun} questions.`;
	}
	if (placement.reasonKey.startsWith('field_registry.placement.before_')) {
		const following = current[placement.index];
		return following
			? `First ${noun} question — placed just before the ${groupNouns[following.group]} questions.`
			: `First ${noun} question — placed in its suggested group.`;
	}
	if (placement.reasonKey === 'field_registry.placement.consent_last') {
		return 'Placed at the end — consent always comes last.';
	}
	if (placement.reasonKey === 'field_registry.placement.end') {
		return `First ${noun} question — placed at the end of the list.`;
	}
	if (placement.reasonKey === 'field_registry.placement.restore') {
		return 'Restored to its previous place.';
	}
	return 'Placed in the suggested position.';
}

export interface FieldRegistryMutationView {
	readonly action: FieldRegistrySafeDiff['action'];
	readonly registryVersionBefore: number;
	readonly registryVersionAfter: number;
	readonly fieldId: string;
	readonly fieldVersion: number;
	readonly position: number | null;
	readonly field?: RegistryField;
	readonly placement?: PlacementSuggestion;
}

/** A compact browser projection of the exact prepared change that committed. */
export function mapFieldRegistryMutation(
	diff: FieldRegistrySafeDiff,
	current: readonly RegistryField[]
): FieldRegistryMutationView {
	const base = {
		action: diff.action,
		registryVersionBefore: diff.registryVersionBefore,
		registryVersionAfter: diff.registryVersionAfter
	};
	if (diff.action === 'move') {
		return Object.freeze({
			...base,
			fieldId: diff.fieldId,
			fieldVersion: diff.fieldVersion,
			position: diff.afterIndex
		});
	}

	const definition = diff.action === 'remove' ? diff.before : diff.after;
	const field = mapFieldRegistryField({
		...definition,
		resolvedOptions: definition.options.kind === 'program_vocabulary' ? [] : null
	});
	const placement = diff.action === 'add' || diff.action === 'restore'
		? {
				index: diff.placement.index,
				group: diff.placement.group,
				reason: placementReason(diff.placement, current)
			}
		: undefined;
	return Object.freeze({
		...base,
		fieldId: definition.id,
		fieldVersion: definition.version,
		position: diff.action === 'remove' ? null : definition.position,
		field,
		...(placement ? { placement: Object.freeze(placement) } : {})
	});
}
