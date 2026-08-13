import type { FormTarget } from '@jooevents/contracts';
import type { EventProgramPort } from './event-program/port';
import type { ProgramVocabularySnapshotView } from './view-models/program-vocabulary';

export type ProgramVocabularyReadPort = Pick<EventProgramPort['vocabulary'], 'read'>;

export type CategoryTargetReference =
	| { readonly kind: 'general_pool' }
	| {
			readonly kind: 'category';
			readonly categoryKind: 'track' | 'format';
			readonly categoryId: string;
	  };

export type CategoryTargetVocabularyState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'ready'; readonly snapshot: ProgramVocabularySnapshotView };

export interface CategoryTargetChoice {
	readonly key: string;
	readonly kind: 'general_pool' | 'track' | 'format';
	readonly name: string;
	readonly target: FormTarget;
}

const generalPoolChoice = Object.freeze({
	key: 'general_pool',
	kind: 'general_pool' as const,
	name: 'General pool',
	target: Object.freeze({ kind: 'general_pool' as const })
});

function categoryKindLabel(kind: 'track' | 'format'): 'Track' | 'Format' {
	return kind === 'track' ? 'Track' : 'Format';
}

function categoryChoiceKey(kind: 'track' | 'format', id: string): string {
	return `${kind}:${id}`;
}

/** New assignments may reference only currently active Program Vocabulary entries. */
export function categoryTargetChoices(
	snapshot: ProgramVocabularySnapshotView | null
): readonly CategoryTargetChoice[] {
	if (!snapshot) return Object.freeze([generalPoolChoice]);
	const categoryChoices = [...snapshot.tracks, ...snapshot.formats]
		.filter((item) => item.status === 'active')
		.map((item) => Object.freeze({
			key: categoryChoiceKey(item.kind, item.id),
			kind: item.kind,
			name: item.name,
			target: Object.freeze({
				kind: 'category' as const,
				category: Object.freeze({ kind: item.kind, id: item.id })
			})
		}));
	return Object.freeze([generalPoolChoice, ...categoryChoices]);
}

/** Resolves an opaque select key only through the choices that were actually offered. */
export function targetForCategoryChoice(
	choices: readonly CategoryTargetChoice[],
	key: string
): FormTarget | null {
	return choices.find((choice) => choice.key === key)?.target ?? null;
}

/**
 * Existing references remain nameable after retirement. A missing reference is
 * stated plainly and never falls back to its identifier or a synthetic name.
 */
export function categoryTargetLabel(
	target: CategoryTargetReference,
	vocabulary: CategoryTargetVocabularyState
): string {
	if (target.kind === 'general_pool') return 'General pool';
	const kindLabel = categoryKindLabel(target.categoryKind);
	if (vocabulary.kind === 'loading') return `${kindLabel} name loading…`;
	if (vocabulary.kind === 'unavailable') return `${kindLabel} name unavailable`;

	const family = target.categoryKind === 'track'
		? vocabulary.snapshot.tracks
		: vocabulary.snapshot.formats;
	const item = family.find((candidate) => candidate.id === target.categoryId);
	if (!item) return `${kindLabel} no longer available`;
	return item.status === 'retired'
		? `${kindLabel} · ${item.name} (retired)`
		: `${kindLabel} · ${item.name}`;
}
