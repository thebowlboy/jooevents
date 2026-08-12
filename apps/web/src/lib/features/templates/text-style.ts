import type { TextStyle } from '../../api/types';

/**
 * Style tags compiled to literal pixels, per unit kind.
 *
 * Template previews render the artifact at its own absolute scale (16px body,
 * independent of the app's density tokens), and a style tag must survive into
 * artifact HTML with no stylesheet behind it — mail clients render inline px
 * or nothing. A size is stored as the pixel number itself, clamped to one
 * bounded integer range; what differs per unit kind is its *ladder*: the base
 * the unit renders at unstyled, and the recommended steps its picker leads
 * with. Per-unit ladders are the point: a heading's recommendations are not a
 * paragraph's, so "bigger" always lands sensibly.
 */
export type StyleUnitKind = 'heading' | 'paragraph' | 'hero-title' | 'hero-intro' | 'note';

/** One unit kind's size ladder: its unstyled base and the recommended steps. */
export interface SizeLadder {
	/** The px the unit renders at with no tag; picking it stores nothing. */
	base: number;
	/** The picker's leading tier, ascending, base included. */
	recommended: number[];
}

/** The bounded size range every numeric entry clamps into. */
export const SIZE_MIN = 10;
export const SIZE_MAX = 72;

const ladders: Record<StyleUnitKind, SizeLadder> = {
	heading: { base: 24, recommended: [20, 24, 28, 32] },
	paragraph: { base: 16, recommended: [14, 16, 18, 20] },
	'hero-title': { base: 28, recommended: [24, 28, 32, 36] },
	'hero-intro': { base: 16, recommended: [14, 16, 18, 20] },
	note: { base: 14, recommended: [12, 14, 16, 18] }
};

/** The ladder one unit kind's size picker offers. */
export function sizeLadder(kind: StyleUnitKind): SizeLadder {
	return ladders[kind];
}

/** A size forced into the bounded range: integer, never below 10 or above 72. */
export function clampSize(value: number): number {
	if (!Number.isFinite(value)) return SIZE_MIN;
	return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(value)));
}

/**
 * The full bounded range as the picker's dense second tier: every integer
 * through 40 — the span text actually lives in — then coarser 4px strides up
 * to 72, where a step of one is imperceptible at display size.
 */
export function allSizes(): number[] {
	const sizes: number[] = [];
	for (let px = SIZE_MIN; px <= 40; px += 1) sizes.push(px);
	for (let px = 44; px <= SIZE_MAX; px += 4) sizes.push(px);
	return sizes;
}

/**
 * The inline `style` attribute a unit's style tag compiles to. Only declared
 * properties emit a declaration; no tag (or an empty one) emits no attribute,
 * so an untagged unit renders exactly as before. Sizes clamp on the way out —
 * whatever a stored tag claims, the artifact never leaves the bounded range.
 */
export function compileTextStyle(kind: StyleUnitKind, style?: TextStyle): string | undefined {
	if (!style) return undefined;
	const parts: string[] = [];
	if (typeof style.size === 'number' && Number.isFinite(style.size)) {
		parts.push(`font-size: ${clampSize(style.size)}px`);
	}
	if (style.weight) parts.push(`font-weight: ${style.weight === 'semibold' ? 600 : 400}`);
	if (style.align) parts.push(`text-align: ${style.align}`);
	return parts.length > 0 ? parts.join('; ') : undefined;
}

/** The style a unit renders: absent properties filled with the kind's defaults. */
export function filledTextStyle(kind: StyleUnitKind, style?: TextStyle): Required<TextStyle> {
	return {
		size: typeof style?.size === 'number' ? clampSize(style.size) : ladders[kind].base,
		weight: style?.weight ?? 'regular',
		align: style?.align ?? 'start'
	};
}

/**
 * A style tag with default values dropped — defaults are identity, so storing
 * them would make an untouched unit read as styled. The kind's base size is
 * the size default. Undefined when nothing non-default remains.
 */
export function normalizeTextStyle(kind: StyleUnitKind, style: TextStyle): TextStyle | undefined {
	const next: TextStyle = {};
	if (typeof style.size === 'number' && Number.isFinite(style.size)) {
		const size = clampSize(style.size);
		if (size !== ladders[kind].base) next.size = size;
	}
	if (style.weight && style.weight !== 'regular') next.weight = style.weight;
	if (style.align && style.align !== 'start') next.align = style.align;
	return Object.keys(next).length > 0 ? next : undefined;
}

/** One property's change between two style tags, defaults filled, as display words. */
export interface StyleChange {
	prop: 'size' | 'weight' | 'align';
	before: string;
	after: string;
}

/** Per-property changes between two (possibly absent) style tags: `16px`, `semibold`. */
export function styleDelta(kind: StyleUnitKind, before?: TextStyle, after?: TextStyle): StyleChange[] {
	const a = filledTextStyle(kind, before);
	const b = filledTextStyle(kind, after);
	const changes: StyleChange[] = [];
	if (a.size !== b.size) changes.push({ prop: 'size', before: `${a.size}px`, after: `${b.size}px` });
	for (const prop of ['weight', 'align'] as const) {
		if (a[prop] !== b[prop]) changes.push({ prop, before: a[prop], after: b[prop] });
	}
	return changes;
}

/** The changes as short phrases for notes and receipts: `size: 16px → 20px`. */
export function styleChangeSummary(
	kind: StyleUnitKind,
	before?: TextStyle,
	after?: TextStyle
): string[] {
	return styleDelta(kind, before, after).map(
		(change) => `${change.prop}: ${change.before} → ${change.after}`
	);
}

/** True when two style tags render identically on the kind (defaults compared filled). */
export function sameTextStyle(kind: StyleUnitKind, a?: TextStyle, b?: TextStyle): boolean {
	return styleDelta(kind, a, b).length === 0;
}
