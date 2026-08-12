import { describe, expect, test } from 'bun:test';
import { brandPresets, matchPreset, themesEqual } from './brand-presets';
import { defaultThemeRecipe } from '../../theme/theme-contract';
import type { EventTheme } from '../../api/types';

describe('brand presets', () => {
	test('the warm preset is the default recipe', () => {
		expect(brandPresets[0]).toMatchObject({ key: 'warm', recipe: { ...defaultThemeRecipe, name: 'Warm' } });
	});

	test('each preset recipe matches itself', () => {
		for (const preset of brandPresets) {
			expect(matchPreset(preset.recipe)).toBe(preset.key);
		}
	});

	test('matching ignores the layer name and letter case, not the visual values', () => {
		const harbor = brandPresets.find((preset) => preset.key === 'harbor')!;
		expect(matchPreset({ ...harbor.recipe, name: 'My event theme' })).toBe('harbor');
		expect(matchPreset({ ...harbor.recipe, action: harbor.recipe.action.toUpperCase() })).toBe(
			'harbor'
		);
		expect(matchPreset({ ...harbor.recipe, action: '#123456' })).toBeNull();
		expect(matchPreset({ ...harbor.recipe, radius: 12 })).toBeNull();
	});

	test('themesEqual compares the whole brand including the mark', () => {
		const brand: EventTheme = { ...defaultThemeRecipe, markText: 'AE' };
		expect(themesEqual(brand, { ...brand })).toBe(true);
		expect(themesEqual(brand, { ...brand, action: brand.action.toUpperCase() })).toBe(true);
		expect(themesEqual(brand, { ...brand, markText: 'AI' })).toBe(false);
		expect(themesEqual(brand, { ...brand, controlHeight: 40 })).toBe(false);
	});
});
