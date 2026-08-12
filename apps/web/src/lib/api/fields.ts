import type { FieldContext, FieldGroup, RegistryField, SurfaceField, SurfaceTemplate } from './types';

/**
 * The registry → surface derivation seam. An application-form surface template
 * owns its prose (hero, section titles and descriptions, notes); the questions
 * themselves live in the field registry and are projected in whenever the
 * template is served. One registry, projected — a field edited through any
 * door changes the form, and the form can never drift from the registry.
 *
 * Pure functions: callers pass the registry in, nothing here touches state.
 */

/** The fields a context asks, in user-owned position order. Form-scoped fields are excluded unless `formScope` names their form. */
export function contextFields(
	registry: RegistryField[],
	context: FieldContext,
	formScope?: string
): RegistryField[] {
	return registry
		.filter((field) => field.collectAt.includes(context))
		.filter((field) => !field.formScope || field.formScope === formScope)
		.sort((a, b) => a.position - b.position);
}

/** One registry field as the flat question shape surface rendering consumes, with requiredness resolved for the asking context. */
export function asSurfaceField(field: RegistryField, context: FieldContext): SurfaceField {
	return {
		id: field.id,
		label: field.label,
		kind: field.kind,
		required: field.required[context] === true,
		...(field.options ? { options: field.options } : {}),
		...(field.help ? { help: field.help } : {})
	};
}

/**
 * The ids a groups-declaring form section asks: the context's fields belonging
 * to those groups, in position order, except consent fields, which always
 * render at the section's end.
 */
export function sectionFieldIds(
	registry: RegistryField[],
	groups: FieldGroup[],
	context: FieldContext,
	formScope?: string
): string[] {
	const wanted = new Set(groups);
	const inSection = contextFields(registry, context, formScope).filter((field) =>
		wanted.has(field.group)
	);
	return [
		...inSection.filter((field) => field.group !== 'consent'),
		...inSection.filter((field) => field.group === 'consent')
	].map((field) => field.id);
}

/**
 * An application-form surface re-served over the current registry: the field
 * pool becomes the registry's apply-context fields, and every `groups`-carrying
 * section's `fieldRefs` are rederived. Sections without `groups` and templates
 * of any other kind pass through untouched.
 */
export function projectApplicationForm(
	surface: SurfaceTemplate,
	registry: RegistryField[]
): SurfaceTemplate {
	if (surface.kind !== 'application-form') return surface;
	const projected = structuredClone(surface);
	projected.fields = contextFields(registry, 'apply').map((field) =>
		asSurfaceField(field, 'apply')
	);
	for (const block of projected.blocks) {
		if (block.type !== 'form-section' || !block.groups) continue;
		block.fieldRefs = sectionFieldIds(registry, block.groups, 'apply');
	}
	return projected;
}
