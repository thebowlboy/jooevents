export type Density = 'compact' | 'default' | 'comfortable';
export type ThemePreset = 'warm' | 'harbor' | 'plum' | 'custom';

export interface ThemeRecipe {
  name: string;
  canvas: string;
  surface: string;
  text: string;
  action: string;
  radius: number;
  controlHeight: number;
}

export const defaultThemeRecipe: ThemeRecipe = {
  name: 'My event theme',
  canvas: '#faf8f5',
  surface: '#ffffff',
  text: '#2a2522',
  action: '#b05a4f',
  radius: 6,
  controlHeight: 36
};

export const publicThemeTokens = [
  '--je-color-canvas',
  '--je-color-page',
  '--je-color-surface',
  '--je-color-surface-raised',
  '--je-color-surface-sunken',
  '--je-color-surface-selected',
  '--je-color-text',
  '--je-color-text-muted',
  '--je-color-border',
  '--je-color-border-strong',
  '--je-color-action',
  '--je-color-action-hover',
  '--je-color-action-active',
  '--je-color-action-contrast',
  '--je-color-action-soft',
  '--je-color-action-soft-hover',
  '--je-color-focus',
  '--je-color-link',
  '--je-radius-control',
  '--je-radius-surface',
  '--je-control-height',
  '--je-font-body',
  '--je-font-display'
] as const;

const hexPattern = /^#[0-9a-f]{6}$/i;

export function normalizeThemeRecipe(input: ThemeRecipe): ThemeRecipe {
  return {
    name: input.name.trim().slice(0, 48) || defaultThemeRecipe.name,
    canvas: validHex(input.canvas, defaultThemeRecipe.canvas),
    surface: validHex(input.surface, defaultThemeRecipe.surface),
    text: validHex(input.text, defaultThemeRecipe.text),
    action: validHex(input.action, defaultThemeRecipe.action),
    radius: clamp(Math.round(input.radius), 2, 20),
    controlHeight: clamp(Math.round(input.controlHeight), 30, 48)
  };
}

export function contrastText(background: string): '#ffffff' | '#2a2522' | '#000000' {
  const white = contrastRatio(background, '#ffffff');
  const ink = contrastRatio(background, '#2a2522');
  const preferred = white >= ink ? '#ffffff' : '#2a2522';
  if (contrastRatio(background, preferred) >= 4.5) return preferred;
  return '#000000';
}

export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function themeStyleProperties(input: ThemeRecipe): Record<string, string> {
  const recipe = normalizeThemeRecipe(input);
  return {
    '--je-color-canvas': recipe.canvas,
    '--je-color-page': `color-mix(in srgb, ${recipe.canvas} 88%, ${recipe.text})`,
    '--je-color-surface': recipe.surface,
    '--je-color-surface-raised': `color-mix(in srgb, ${recipe.surface} 96%, ${recipe.canvas})`,
    '--je-color-surface-sunken': `color-mix(in srgb, ${recipe.canvas} 92%, ${recipe.text})`,
    '--je-color-surface-selected': `color-mix(in srgb, ${recipe.action} 9%, ${recipe.surface})`,
    '--je-color-text': recipe.text,
    '--je-color-text-muted': `color-mix(in srgb, ${recipe.text} 72%, ${recipe.surface})`,
    '--je-color-border': `color-mix(in srgb, ${recipe.text} 11%, transparent)`,
    '--je-color-border-strong': `color-mix(in srgb, ${recipe.text} 20%, transparent)`,
    '--je-color-action': recipe.action,
    '--je-color-action-hover': `color-mix(in srgb, ${recipe.action} 82%, #000000)`,
    '--je-color-action-active': `color-mix(in srgb, ${recipe.action} 68%, #000000)`,
    '--je-color-action-contrast': contrastText(recipe.action),
    '--je-color-action-soft': `color-mix(in srgb, ${recipe.action} 13%, ${recipe.surface})`,
    '--je-color-action-soft-hover': `color-mix(in srgb, ${recipe.action} 22%, ${recipe.surface})`,
    '--je-color-focus': `color-mix(in srgb, ${recipe.action} 58%, ${recipe.surface})`,
    '--je-color-link': `color-mix(in srgb, ${recipe.action} 72%, #000000)`,
    '--je-radius-control': `${recipe.radius}px`,
    '--je-radius-surface': `${Math.min(recipe.radius + 4, 24)}px`,
    '--je-control-height': `${recipe.controlHeight}px`
  };
}

export function serializeThemeCss(input: ThemeRecipe): string {
  const recipe = normalizeThemeRecipe(input);
  const properties = themeStyleProperties(recipe);
  const slug = recipe.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'custom';
  const lines = Object.entries(properties).map(([token, value]) => `    ${token}: ${value};`);

  return [
    '@layer app.overrides {',
    `  :root[data-theme="${slug}"] {`,
    ...lines,
    '  }',
    '}'
  ].join('\n');
}

function validHex(value: string, fallback: string): string {
  return hexPattern.test(value) ? value.toLowerCase() : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function relativeLuminance(hex: string): number {
  const safe = validHex(hex, '#000000');
  const channels = [1, 3, 5].map((start) => Number.parseInt(safe.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
