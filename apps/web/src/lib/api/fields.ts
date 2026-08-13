import type {
	FieldContext,
	FieldGroup,
	FieldOptionSource,
	FormSummary,
	RegistryField,
	SurfaceField,
	SurfaceTemplate
} from './types';

/**
 * The registry → surface derivation seam. An application-form surface template
 * owns its prose (hero, section titles and descriptions, notes); the questions
 * themselves live in the field registry and are projected in whenever the
 * template is served. One registry, projected — a field edited through any
 * door changes the form, and the form can never drift from the registry.
 *
 * Pure functions: callers pass the registry in, nothing here touches state.
 */

/** One vocabulary entry as this seam needs it: identity, name, and whether it is still offered. */
export interface VocabEntry {
	id: string;
	name: string;
	status: 'active' | 'retired';
}

/** The event vocabularies a sourced choice field can draw options from. */
export interface ServeVocab {
	tracks: VocabEntry[];
	formats: VocabEntry[];
}

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

/**
 * A sourced field's live choices: the vocabulary's active entries, optionally
 * narrowed to an exposed subset of ids. Pinning is by id, so renaming a track
 * keeps it exposed and adding one under the live default includes it.
 */
export function resolveOptionChoices(
	source: FieldOptionSource,
	vocab: ServeVocab,
	exposedIds?: string[]
): { id: string; name: string }[] {
	return vocab[source]
		.filter((entry) => entry.status === 'active')
		.filter((entry) => !exposedIds || exposedIds.includes(entry.id))
		.map((entry) => ({ id: entry.id, name: entry.name }));
}

/**
 * One registry field as the flat question shape surface rendering consumes,
 * with requiredness resolved for the asking context and — for sourced choice
 * fields — options resolved from the live vocabulary. Without a vocabulary a
 * sourced field serves no options rather than a stale copy.
 */
export function asSurfaceField(
	field: RegistryField,
	context: FieldContext,
	vocab?: ServeVocab
): SurfaceField {
	const choices = field.optionSource && vocab ? resolveOptionChoices(field.optionSource, vocab) : null;
	const options = choices ? choices.map((choice) => choice.name) : field.options;
	return {
		id: field.id,
		label: field.label,
		kind: field.kind,
		required: field.required[context] === true,
		...(options ? { options } : {}),
		...(field.help ? { help: field.help } : {}),
		group: field.group,
		...(field.formScope ? { formScope: field.formScope } : {}),
		...(field.optionSource ? { optionSource: field.optionSource } : {}),
		...(choices ? { optionChoices: choices } : {})
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
 * pool becomes the registry's apply-context fields — every form's scoped
 * extras included, tagged with their scope, so a per-form view can be derived
 * from one serve — and every `groups`-carrying section's `fieldRefs` are
 * rederived from the shared (unscoped) fields. Sections without `groups` and
 * templates of any other kind pass through untouched.
 */
export function projectApplicationForm(
	surface: SurfaceTemplate,
	registry: RegistryField[],
	vocab?: ServeVocab
): SurfaceTemplate {
	if (surface.kind !== 'application-form') return surface;
	const projected = structuredClone(surface);
	const applyFields = registry
		.filter((field) => field.collectAt.includes('apply'))
		.sort((a, b) => a.position - b.position);
	projected.fields = applyFields.map((field) => asSurfaceField(field, 'apply', vocab));
	for (const block of projected.blocks) {
		if (block.type !== 'form-section' || !block.groups) continue;
		block.fieldRefs = sectionFieldIds(registry, block.groups, 'apply');
	}
	return projected;
}

/**
 * A detached deep copy of served data.
 *
 * `structuredClone` is the obvious tool and the wrong one here: a caller in a
 * Svelte surface holds reactive **proxies**, and `structuredClone` throws
 * `DataCloneError` on one. The lens below is pure and must work on whatever a
 * caller has — the committed copy, a draft, or a working copy read straight out
 * of a rune — so the copy is taken through JSON, which reads a proxy exactly as
 * it reads a plain object.
 *
 * Safe for this data by construction: surface templates are the JSON documents
 * that go over the wire, so they contain no dates, maps, sets, or cycles. Any
 * shape that gains one of those stops being serializable long before it reaches
 * here.
 */
function detached<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A served application-form template as one specific form asks it: shared
 * questions the form excludes drop out of the pool and every section, the
 * form's scoped extras join the sections of their group, per-form requiredness
 * overrides apply, and a sourced field's options narrow to the form's exposed
 * subset. Pure over the served projection — the same lens works on the
 * committed copy, a draft, or an inline working copy, so a preview can switch
 * forms without another serve.
 */
export function applyFormLens(surface: SurfaceTemplate, form: FormSummary): SurfaceTemplate {
	if (surface.kind !== 'application-form') return surface;
	const excluded = new Set(form.composition.excludedFieldIds);
	const lensed = detached(surface);
	const pool = (lensed.fields ?? []).filter(
		(field) => (!field.formScope || field.formScope === form.id) && !excluded.has(field.id)
	);
	for (const field of pool) {
		const override = form.composition.requiredOverrides[field.id];
		if (override !== undefined) field.required = override;
		const exposure = form.composition.optionExposure[field.id];
		if (exposure && field.optionSource && field.optionChoices) {
			const offered = field.optionChoices.filter((choice) => exposure.includes(choice.id));
			field.optionChoices = offered;
			field.options = offered.map((choice) => choice.name);
		}
	}
	lensed.fields = pool;
	const poolIds = new Set(pool.map((field) => field.id));
	for (const block of lensed.blocks) {
		if (block.type !== 'form-section') continue;
		if (block.groups) {
			// Rebuild membership from the lensed pool, which already carries the
			// registry's order: the form's scoped extras join their group here.
			const wanted = new Set(block.groups);
			const inSection = pool.filter((field) => wanted.has(field.group));
			block.fieldRefs = [
				...inSection.filter((field) => field.group !== 'consent'),
				...inSection.filter((field) => field.group === 'consent')
			].map((field) => field.id);
		} else {
			block.fieldRefs = block.fieldRefs.filter((ref) => poolIds.has(ref));
		}
	}
	return lensed;
}
