import type { AnyTemplate, MessageTemplate, RegistryField, SurfaceTemplate, TextStyle } from '$lib/api/types';
import { isSurfaceTemplate } from '$lib/api/types';
import { declaredTokens } from './merge-fields';
import { normalizeTextStyle, type StyleUnitKind } from './text-style';

/**
 * Inline editing over template previews: the typed unit model behind
 * click-to-edit.
 *
 * A renderer in editable mode annotates each addressable unit with a stable
 * `data-edit` path (`blocks.2.text`, `blocks.1.merge.0`, `fields.fld-email`,
 * `submitLabel`); this module turns a pressed path back into a typed unit and
 * builds the next document for the edit that unit's mini-editor produced.
 * Builders never mutate — each returns a fresh copy for the commit path to
 * apply atomically.
 */

/** The display options a schedule listing block carries as data. */
export interface ScheduleKnobs {
	grouping: 'day' | 'track';
	density: 'cozy' | 'compact';
	showRoom: boolean;
	showTrack: boolean;
	showSpeakers: boolean;
}

/** The same, for a roster listing. */
export interface RosterKnobs {
	layout: 'grid' | 'list' | 'strip' | 'profile';
	grouping: 'none' | 'category';
	density: 'cozy' | 'compact';
	showHeadline: boolean;
	showSessions: boolean;
	showLinks: boolean;
}

/** One addressable unit of a template preview, resolved from its `data-edit` path. */
export type InlineUnit =
	| {
			type: 'text';
			path: string;
			/** What the unit is called in the editor and the revision note ("heading", "section title"). */
			noun: string;
			value: string;
			multiline: boolean;
			/** Present on units that carry style tags: names their px ladder. Absent units offer no style controls. */
			styleKind?: StyleUnitKind;
			/** The unit's current style tag, when it carries one. */
			style?: TextStyle;
			/**
			 * Present on units whose text renders declared merge tokens: the block's
			 * suggested keys for one-press insertion. Absent units (button labels,
			 * form-section prose) offer no variable insertion.
			 */
			suggestedVars?: string[];
	  }
	| { type: 'merge'; path: string; blockIndex: number; tokenIndex: number; key: string }
	| { type: 'knobs'; path: string; blockIndex: number; knobs: ScheduleKnobs }
	| { type: 'roster-knobs'; path: string; blockIndex: number; knobs: RosterKnobs }
	| { type: 'field'; path: string; fieldId: string };

/** What a mini-editor session produced when Done was pressed. */
export type InlineEditResult =
	| { type: 'text'; value: string; style?: TextStyle }
	| { type: 'merge'; swapKey: string; insertKey: string }
	| { type: 'knobs'; knobs: ScheduleKnobs }
	| { type: 'roster-knobs'; knobs: RosterKnobs }
	| { type: 'field'; patch: Partial<Pick<RegistryField, 'label' | 'help' | 'options' | 'required'>> };

function textUnit(
	path: string,
	noun: string,
	value: string,
	multiline: boolean,
	styleKind?: StyleUnitKind,
	style?: TextStyle,
	suggestedVars?: string[]
): InlineUnit {
	return {
		type: 'text',
		path,
		noun,
		value,
		multiline,
		...(styleKind ? { styleKind, ...(style ? { style } : {}) } : {}),
		...(suggestedVars ? { suggestedVars } : {})
	};
}

/** Resolves a pressed `data-edit` path against the document on screen. Unknown paths resolve to null. */
export function resolveUnit(template: AnyTemplate, path: string): InlineUnit | null {
	if (path === 'submitLabel') {
		if (!isSurfaceTemplate(template)) return null;
		return textUnit(path, 'submit label', template.submitLabel ?? 'Submit application', false);
	}
	if (path.startsWith('fields.')) {
		return { type: 'field', path, fieldId: path.slice('fields.'.length) };
	}
	const parts = path.split('.');
	if (parts[0] !== 'blocks') return null;
	const blockIndex = Number(parts[1]);
	const block = template.blocks[blockIndex];
	if (!block) return null;
	if (parts.length === 2) {
		if (block.type === 'schedule-days') {
			const { grouping, density, showRoom, showTrack, showSpeakers } = block;
			return {
				type: 'knobs',
				path,
				blockIndex,
				knobs: { grouping, density, showRoom, showTrack, showSpeakers }
			};
		}
		if (block.type === 'roster-list') {
			const { layout, grouping, density, showHeadline, showSessions, showLinks } = block;
			return {
				type: 'roster-knobs',
				path,
				blockIndex,
				knobs: { layout, grouping, density, showHeadline, showSessions, showLinks }
			};
		}
		return null;
	}
	if (parts[2] === 'merge') {
		if (isSurfaceTemplate(template) || block.type !== 'paragraph') return null;
		const tokenIndex = Number(parts[3]);
		const token = declaredTokens(block.text, template.mergeFields)[tokenIndex];
		return token ? { type: 'merge', path, blockIndex, tokenIndex, key: token.key } : null;
	}
	if (parts[2] === 'rows') {
		if (block.type !== 'details') return null;
		const row = block.rows[Number(parts[3])];
		const prop = parts[4];
		if (!row || (prop !== 'label' && prop !== 'value')) return null;
		// A row's value renders merge tokens; its label is always literal words.
		if (prop === 'label') return textUnit(path, 'details label', row.label, false);
		return textUnit(path, 'details value', row.value, false, undefined, undefined, block.suggestedVars ?? []);
	}
	const prop = parts[2];
	switch (block.type) {
		case 'heading':
			return prop === 'text'
				? textUnit(path, 'heading', block.text, false, 'heading', block.style, block.suggestedVars ?? [])
				: null;
		case 'paragraph':
			return prop === 'text'
				? textUnit(path, 'paragraph', block.text, true, 'paragraph', block.style, block.suggestedVars ?? [])
				: null;
		case 'button':
			return prop === 'label' ? textUnit(path, 'button label', block.label, false) : null;
		case 'hero':
			if (prop === 'title') return textUnit(path, 'title', block.title, false, 'hero-title', block.titleStyle);
			if (prop === 'intro') return textUnit(path, 'intro', block.intro, true, 'hero-intro', block.introStyle);
			return null;
		case 'note':
			return prop === 'text' ? textUnit(path, 'note', block.text, true, 'note', block.style) : null;
		case 'form-section':
			if (prop === 'title') return textUnit(path, 'section title', block.title, false);
			if (prop === 'description') {
				return textUnit(path, 'section description', block.description ?? '', true);
			}
			return null;
		default:
			return null;
	}
}

/** The document with one text run replaced. Unknown paths return the copy unchanged. */
export function withTextValue(template: AnyTemplate, path: string, value: string): AnyTemplate {
	const next = structuredClone(template);
	if (path === 'submitLabel') {
		if (isSurfaceTemplate(next)) next.submitLabel = value;
		return next;
	}
	const parts = path.split('.');
	const block = next.blocks[Number(parts[1])];
	if (!block) return next;
	if (parts[2] === 'rows' && block.type === 'details') {
		const row = block.rows[Number(parts[3])];
		if (row && (parts[4] === 'label' || parts[4] === 'value')) row[parts[4]] = value;
		return next;
	}
	const prop = parts[2];
	if ((block.type === 'heading' || block.type === 'paragraph' || block.type === 'note') && prop === 'text') {
		block.text = value;
	} else if (block.type === 'button' && prop === 'label') {
		block.label = value;
	} else if ((block.type === 'hero' || block.type === 'form-section') && prop === 'title') {
		block.title = value;
	} else if (block.type === 'hero' && prop === 'intro') {
		block.intro = value;
	} else if (block.type === 'form-section' && prop === 'description') {
		block.description = value;
	}
	return next;
}

/**
 * The document with one text unit's style tag replaced. The tag is stored
 * normalized — default values dropped, an all-default tag cleared — so an
 * untouched unit never reads as styled. Paths that name no style-carrying
 * unit return the copy unchanged.
 */
export function withTextStyle(
	template: AnyTemplate,
	path: string,
	style: TextStyle | undefined
): AnyTemplate {
	const next = structuredClone(template);
	const parts = path.split('.');
	if (parts[0] !== 'blocks') return next;
	const block = next.blocks[Number(parts[1])];
	if (!block) return next;
	const prop = parts[2];
	// Normalization is per unit kind — the kind's base size is the size default.
	const normalized = (kind: StyleUnitKind) => (style ? normalizeTextStyle(kind, style) : undefined);
	if (
		(block.type === 'heading' || block.type === 'paragraph' || block.type === 'note') &&
		prop === 'text'
	) {
		const tag = normalized(block.type);
		if (tag) block.style = tag;
		else delete block.style;
	} else if (block.type === 'hero' && prop === 'title') {
		const tag = normalized('hero-title');
		if (tag) block.titleStyle = tag;
		else delete block.titleStyle;
	} else if (block.type === 'hero' && prop === 'intro') {
		const tag = normalized('hero-intro');
		if (tag) block.introStyle = tag;
		else delete block.introStyle;
	}
	return next;
}

/**
 * The document with one paragraph's addressed merge token swapped to
 * `swapKey`, another token inserted right after it, or both. Empty keys leave
 * that half of the edit out; the addressed token missing leaves the copy
 * unchanged.
 */
export function withMergeEdit(
	template: MessageTemplate,
	blockIndex: number,
	tokenIndex: number,
	edit: { swapKey?: string; insertKey?: string }
): MessageTemplate {
	const next = structuredClone(template);
	const block = next.blocks[blockIndex];
	if (!block || block.type !== 'paragraph') return next;
	const token = declaredTokens(block.text, next.mergeFields)[tokenIndex];
	if (!token) return next;
	let text = block.text;
	// Insert first: it splices after the token's end, so the swap's span below
	// is still the span that was measured.
	if (edit.insertKey) text = `${text.slice(0, token.end)} {{${edit.insertKey}}}${text.slice(token.end)}`;
	if (edit.swapKey && edit.swapKey !== token.key) {
		text = `${text.slice(0, token.start)}{{${edit.swapKey}}}${text.slice(token.end)}`;
	}
	block.text = text;
	return next;
}

/** The document with one schedule listing's display options replaced. */
export function withScheduleKnobs(
	template: SurfaceTemplate,
	blockIndex: number,
	knobs: ScheduleKnobs
): SurfaceTemplate {
	const next = structuredClone(template);
	const block = next.blocks[blockIndex];
	if (block?.type === 'schedule-days') Object.assign(block, knobs);
	return next;
}

/** The document with one roster listing's display options replaced. */
export function withRosterKnobs(
	template: SurfaceTemplate,
	blockIndex: number,
	knobs: RosterKnobs
): SurfaceTemplate {
	const next = structuredClone(template);
	const block = next.blocks[blockIndex];
	if (block?.type === 'roster-list') Object.assign(block, knobs);
	return next;
}

/** Short visible words for a unit's accessible name: `Edit: {excerpt}`. */
export function excerpt(text: string, max = 48): string {
	const words = text.replace(/\s+/g, ' ').trim();
	return words.length <= max ? words : `${words.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The attribute bundle a renderer spreads onto an addressable unit: the shared
 * affordance class beside the unit's own, the stable `data-edit` path, and a
 * focusable button role named `Edit: {excerpt}`. Inert mode returns only the
 * unit's own class, so a preview outside the editor renders exactly as before.
 */
export function unitAttributes(
	editable: boolean,
	baseClass: string,
	path: string,
	name: string,
	cue: 'text' | 'block' = 'text'
): Record<string, string | number> {
	if (!editable) return baseClass ? { class: baseClass } : {};
	const affordance = cue === 'text' ? 'ui-editable ui-editable--text' : 'ui-editable';
	return {
		class: baseClass ? `${baseClass} ${affordance}` : affordance,
		'data-edit': path,
		role: 'button',
		tabindex: 0,
		'aria-label': `Edit: ${name}`
	};
}

export interface EditableUnitsOptions {
	enabled: boolean;
	onPress: (path: string, unit: HTMLElement) => void;
}

/**
 * Delegated press handling for annotated units: one listener pair on the
 * preview container maps a click or an Enter/Space press on any `[data-edit]`
 * element to the host's editor, so renderers stay pure annotation. The nearest
 * annotated ancestor wins, which is what lets a merge chip inside an editable
 * paragraph open its own editor.
 */
export function editableUnits(node: HTMLElement, options: EditableUnitsOptions) {
	let current = options;

	function press(event: Event) {
		if (!current.enabled) return;
		const target =
			event.target instanceof Element ? event.target.closest<HTMLElement>('[data-edit]') : null;
		if (!target || !node.contains(target)) return;
		event.preventDefault();
		const path = target.getAttribute('data-edit');
		if (path) current.onPress(path, target);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		press(event);
	}

	node.addEventListener('click', press);
	node.addEventListener('keydown', onKeydown);
	return {
		update(next: EditableUnitsOptions) {
			current = next;
		},
		destroy() {
			node.removeEventListener('click', press);
			node.removeEventListener('keydown', onKeydown);
		}
	};
}
