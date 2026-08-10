import { describe, expect, test } from 'bun:test';
import {
  contrastText,
  defaultThemeRecipe,
  normalizeThemeRecipe,
  publicThemeTokens,
  serializeThemeCss,
  themeStyleProperties
} from './theme-contract';

describe('theme contract', () => {
  test('normalizes unsafe or out-of-range theme values', () => {
    expect(
      normalizeThemeRecipe({
        name: '   ',
        canvas: 'not-a-color',
        surface: '#ABCDEF',
        text: '#111111',
        action: '#222222',
        radius: 99,
        controlHeight: 12
      })
    ).toEqual({
      ...defaultThemeRecipe,
      surface: '#abcdef',
      text: '#111111',
      action: '#222222',
      radius: 20,
      controlHeight: 30
    });
  });

  test('chooses the higher-contrast action text', () => {
    expect(contrastText('#b05a4f')).toBe('#ffffff');
    expect(contrastText('#e8a598')).toBe('#2a2522');
  });

  test('emits only documented custom properties', () => {
    const properties = themeStyleProperties(defaultThemeRecipe);
    for (const token of Object.keys(properties)) {
      expect(publicThemeTokens.includes(token as (typeof publicThemeTokens)[number])).toBe(true);
    }
  });

  test('serializes into the final override layer', () => {
    const css = serializeThemeCss({ ...defaultThemeRecipe, name: 'Festival Blue' });
    expect(css).toContain('@layer app.overrides');
    expect(css).toContain(':root[data-theme="festival-blue"]');
    expect(css).toContain('--je-color-action: #b05a4f;');
  });
});
