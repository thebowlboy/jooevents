/**
 * Presentation joins for reviewer scope refs. A scope ref is a typed reference
 * to a governed record — a track, a format, a session — so everything a chip
 * needs (name, accent, lifecycle) is read from the referenced entity rather
 * than stored on the ref. One resolver serves the roster chips, the scope
 * editor, the coverage panel, and the `?scope=` address filter, so the same
 * ref can never render under two names.
 */

import type { Format, ScopeRef, ScopeRefKind, SessionItem, Track } from '$lib/api/types';

/** The records a scope ref resolves against. */
export interface ScopeEntities {
	tracks: readonly Track[];
	formats: readonly Format[];
	sessions: readonly SessionItem[];
}

/** One scope ref joined to the entity it references, ready to render. */
export interface ScopeDisplay {
	ref: ScopeRef;
	/** Stable render/address key, `kind:id` — also the `?scope=` wire format. */
	key: string;
	label: string;
	/** The track's own accent; formats and sessions stay neutral. */
	accent: 'lavender' | 'sea' | 'neutral';
	/** The referenced entry is retired: it keeps rendering, flagged quietly. */
	retired: boolean;
	/** The referenced session is still collecting applicants. */
	collecting: boolean;
}

export function scopeKey(ref: ScopeRef): string {
	return `${ref.kind}:${ref.id}`;
}

/**
 * The `?scope=` parameter, parsed. A hand-edited or stale value degrades to
 * null — the unfiltered list — never to a broken filter.
 */
export function parseScopeParam(value: string | null): ScopeRef | null {
	if (!value) return null;
	const split = value.indexOf(':');
	if (split <= 0) return null;
	const kind = value.slice(0, split);
	const id = value.slice(split + 1);
	if (!id) return null;
	if (kind !== 'track' && kind !== 'format' && kind !== 'session') return null;
	return { kind: kind as ScopeRefKind, id };
}

/**
 * One ref joined to its entity. A ref that resolves to nothing (the API
 * refuses to store one, so this is a transient race at worst) falls back to
 * its id so the row still renders something identifiable.
 */
export function resolveRef(ref: ScopeRef, entities: ScopeEntities): ScopeDisplay {
	const base = { ref, key: scopeKey(ref), accent: 'neutral' as const, retired: false, collecting: false };
	if (ref.kind === 'track') {
		const track = entities.tracks.find((entry) => entry.id === ref.id);
		return {
			...base,
			label: track?.name ?? ref.id,
			accent: track?.accent === 'lavender' || track?.accent === 'sea' ? track.accent : 'neutral',
			retired: track?.status === 'retired'
		};
	}
	if (ref.kind === 'format') {
		const format = entities.formats.find((entry) => entry.id === ref.id);
		return { ...base, label: format?.name ?? ref.id, retired: format?.status === 'retired' };
	}
	const session = entities.sessions.find((entry) => entry.id === ref.id);
	return { ...base, label: session?.title ?? ref.id, collecting: session?.state === 'collecting' };
}

export function resolveScope(
	scope: readonly ScopeRef[],
	entities: ScopeEntities
): ScopeDisplay[] {
	return scope.map((ref) => resolveRef(ref, entities));
}
