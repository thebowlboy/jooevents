/**
 * Dev-only typeface candidates for the font switcher.
 *
 * Readability in this product is decided at 11–14px inside dense operator
 * tables, not at display sizes, so the body list is weighted toward humanist
 * faces with tall x-heights and open apertures. Atkinson Hyperlegible is
 * included as the legibility benchmark rather than as a likely shipping choice.
 *
 * Loaders are literal dynamic imports so Vite can statically analyse them; the
 * whole module is imported only under `import.meta.env.DEV`, so none of these
 * packages reach a production bundle.
 */

export interface FaceOption {
	key: string;
	name: string;
	/** The CSS stack applied to the token. */
	stack: string;
	/** One line on what this face does for readability. */
	note: string;
	/** Absent for faces already loaded by the app shell. */
	load?: () => Promise<unknown>;
}

const SANS_FALLBACK = `system-ui, -apple-system, sans-serif`;
const SERIF_FALLBACK = `ui-serif, Georgia, serif`;

export const bodyFaces: FaceOption[] = [
	{
		key: 'inter',
		name: 'Inter',
		stack: `'Inter Variable', Inter, ${SANS_FALLBACK}`,
		note: 'Current. Tall x-height, tightly fitted; built for UI at small sizes.'
	},
	{
		key: 'open-sans',
		name: 'Open Sans',
		stack: `'Open Sans Variable', 'Open Sans', ${SANS_FALLBACK}`,
		note: 'The previous face. Humanist, open apertures, narrower counters at 11px.',
		load: () => import('@fontsource-variable/open-sans')
	},
	{
		key: 'source-sans-3',
		name: 'Source Sans 3',
		stack: `'Source Sans 3 Variable', ${SANS_FALLBACK}`,
		note: 'Humanist with generous counters. Strong at small sizes, warm in tone.',
		load: () => import('@fontsource-variable/source-sans-3')
	},
	{
		key: 'ibm-plex-sans',
		name: 'IBM Plex Sans',
		stack: `'IBM Plex Sans Variable', ${SANS_FALLBACK}`,
		note: 'Distinct letterforms and clear 1/l/I. Built for data-dense screens.',
		load: () => import('@fontsource-variable/ibm-plex-sans')
	},
	{
		key: 'public-sans',
		name: 'Public Sans',
		stack: `'Public Sans Variable', ${SANS_FALLBACK}`,
		note: 'Neutral, legibility-tuned for government forms. Very even colour.',
		load: () => import('@fontsource-variable/public-sans')
	},
	{
		key: 'atkinson',
		name: 'Atkinson Hyperlegible',
		stack: `'Atkinson Hyperlegible', ${SANS_FALLBACK}`,
		note: 'Engineered for low vision: maximally differentiated characters. The benchmark.',
		load: () =>
			Promise.all([
				import('@fontsource/atkinson-hyperlegible/400.css'),
				import('@fontsource/atkinson-hyperlegible/700.css')
			])
	},
	{
		key: 'figtree',
		name: 'Figtree',
		stack: `'Figtree Variable', ${SANS_FALLBACK}`,
		note: 'Geometric-humanist, friendly. Rounder shapes, less distinct at small sizes.',
		load: () => import('@fontsource-variable/figtree')
	},
	{
		key: 'nunito-sans',
		name: 'Nunito Sans',
		stack: `'Nunito Sans Variable', ${SANS_FALLBACK}`,
		note: 'Soft terminals, wide aperture. Warmest of the set; slightly lower contrast.',
		load: () => import('@fontsource-variable/nunito-sans')
	}
];

export const displayFaces: FaceOption[] = [
	{
		key: 'merriweather',
		name: 'Merriweather',
		stack: `'Merriweather', ${SERIF_FALLBACK}`,
		note: 'Current. Large x-height, sturdy slabs — heavy at big display sizes.'
	},
	{
		key: 'source-serif-4',
		name: 'Source Serif 4',
		stack: `'Source Serif 4 Variable', ${SERIF_FALLBACK}`,
		note: 'Transitional, pairs cleanly with Source Sans. Lighter colour than Merriweather.',
		load: () => import('@fontsource-variable/source-serif-4')
	},
	{
		key: 'newsreader',
		name: 'Newsreader',
		stack: `'Newsreader Variable', ${SERIF_FALLBACK}`,
		note: 'Editorial, high contrast. Reads as considered rather than institutional.',
		load: () => import('@fontsource-variable/newsreader')
	},
	{
		key: 'lora',
		name: 'Lora',
		stack: `'Lora Variable', ${SERIF_FALLBACK}`,
		note: 'Brushed contrast, moderate. Warm without Merriweather’s weight.',
		load: () => import('@fontsource-variable/lora')
	},
	{
		key: 'bitter',
		name: 'Bitter',
		stack: `'Bitter Variable', ${SERIF_FALLBACK}`,
		note: 'Contemporary slab. Closest in spirit to the current choice, but lighter.',
		load: () => import('@fontsource-variable/bitter')
	},
	{
		key: 'fraunces',
		name: 'Fraunces',
		stack: `'Fraunces Variable', ${SERIF_FALLBACK}`,
		note: 'Characterful old-style with optical sizing. The most opinionated option.',
		load: () => import('@fontsource-variable/fraunces')
	},
	{
		key: 'match-body',
		name: 'Match body (no serif)',
		stack: 'var(--je-font-body)',
		note: 'Drops the serif entirely — tests whether the display face earns its place.'
	}
];

/** Root size drives the whole rem-based scale, so it is the other real lever. */
export const rootSizes = [15, 16, 17] as const;
