import { defaultThemeRecipe, type ThemeRecipe } from '../../theme/theme-contract';
import type { EventTheme } from '../../api/types';

export type BrandPresetKey = 'warm' | 'harbor' | 'plum';

/** A named starting recipe plus the two swatches its chip shows. */
export interface BrandPreset {
	key: BrandPresetKey;
	name: string;
	recipe: ThemeRecipe;
}

/**
 * The product's documented theme presets, as full recipes. These carry the
 * same values the theme contract publishes for each preset; a chip press is a
 * whole-recipe replacement, never a partial tint.
 */
export const brandPresets: readonly BrandPreset[] = [
	{ key: 'warm', name: 'Warm', recipe: { ...defaultThemeRecipe, name: 'Warm' } },
	{
		key: 'harbor',
		name: 'Harbor',
		recipe: {
			name: 'Harbor',
			canvas: '#f4f8f8',
			surface: '#ffffff',
			text: '#2a2522',
			action: '#3d7377',
			radius: 6,
			controlHeight: 36
		}
	},
	{
		key: 'plum',
		name: 'Plum',
		recipe: {
			name: 'Plum',
			canvas: '#f8f6fb',
			surface: '#ffffff',
			text: '#2a2522',
			action: '#695b8e',
			radius: 6,
			controlHeight: 36
		}
	}
];

/**
 * Which preset a recipe currently is, judged by its visual values alone: the
 * layer name and the initials mark are identity, not styling, so renaming a
 * preset does not turn it custom. Null means no preset matches.
 */
export function matchPreset(recipe: ThemeRecipe): BrandPresetKey | null {
	const found = brandPresets.find(
		(preset) =>
			preset.recipe.canvas === recipe.canvas.toLowerCase() &&
			preset.recipe.surface === recipe.surface.toLowerCase() &&
			preset.recipe.text === recipe.text.toLowerCase() &&
			preset.recipe.action === recipe.action.toLowerCase() &&
			preset.recipe.radius === recipe.radius &&
			preset.recipe.controlHeight === recipe.controlHeight
	);
	return found?.key ?? null;
}

/** Whether two brands would render identically — the unsaved-changes test. */
export function themesEqual(a: EventTheme, b: EventTheme): boolean {
	return (
		a.name === b.name &&
		a.canvas.toLowerCase() === b.canvas.toLowerCase() &&
		a.surface.toLowerCase() === b.surface.toLowerCase() &&
		a.text.toLowerCase() === b.text.toLowerCase() &&
		a.action.toLowerCase() === b.action.toLowerCase() &&
		a.radius === b.radius &&
		a.controlHeight === b.controlHeight &&
		a.markText === b.markText
	);
}
