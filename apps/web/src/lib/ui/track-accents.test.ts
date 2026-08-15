import { describe, expect, test } from 'bun:test';
import {
	TRACK_ACCENT_COUNT,
	hasTrack,
	trackAccent,
	trackAccentClass,
	trackAccentPalette
} from './track-accents';

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
	const value = hex.replace('#', '');
	const channels = [0, 2, 4]
		.map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
		.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/**
 * Every ground a track chip is ever drawn on, across every shipped theme.
 * `surface` is white in all three presets; `page` and `sunken` are what
 * harbor and plum move, so the claim is checked against each of them rather
 * than against the default alone.
 */
const SURFACE = '#ffffff';
const GROUNDS = [
	['surface', SURFACE],
	['page (default)', '#f5f2ee'],
	['sunken (default)', '#f0ede8'],
	['page (harbor)', '#eaf1f1'],
	['canvas (harbor)', '#f4f8f8'],
	['page (plum)', '#f0edf5'],
	['canvas (plum)', '#f8f6fb']
] as const;

describe('track accents', () => {
	test('the palette is large enough for a real programme', () => {
		expect(trackAccentPalette).toHaveLength(TRACK_ACCENT_COUNT);
		expect(TRACK_ACCENT_COUNT).toBeGreaterThanOrEqual(8);
	});

	test('every accent ink clears AA on its own fill and on every themed ground', () => {
		const failures: string[] = [];
		for (const { name, soft, ink } of trackAccentPalette) {
			if (contrast(soft, ink) < 4.5) {
				failures.push(`${name} on its own fill: ${contrast(soft, ink).toFixed(2)}`);
			}
			for (const [ground, hex] of GROUNDS) {
				if (contrast(hex, ink) < 4.5) {
					failures.push(`${name} on ${ground}: ${contrast(hex, ink).toFixed(2)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	// Equal lightness is the design decision that keeps this differentiation
	// rather than decoration: no track may look more important than another.
	test('no fill is louder than its neighbours', () => {
		const weights = trackAccentPalette.map(({ soft }) => contrast(SURFACE, soft));
		expect(Math.max(...weights) - Math.min(...weights)).toBeLessThan(0.1);
	});

	test('accents and fills are distinct values', () => {
		expect(new Set(trackAccentPalette.map((entry) => entry.soft)).size).toBe(TRACK_ACCENT_COUNT);
		expect(new Set(trackAccentPalette.map((entry) => entry.ink)).size).toBe(TRACK_ACCENT_COUNT);
		expect(new Set(trackAccentPalette.map((entry) => entry.accent)).size).toBe(TRACK_ACCENT_COUNT);
	});

	test("a programme's own order walks the palette from the top", () => {
		const order = ['organizer-craft', 'agent-systems', 'platform-reliability'];
		expect(order.map((id) => trackAccent(id, order))).toEqual([1, 2, 3]);
	});

	test('the same track keeps its accent across surfaces without an order', () => {
		expect(trackAccent('agent-systems')).toBe(trackAccent('agent-systems'));
		expect(trackAccent('agent-systems')).toBeGreaterThanOrEqual(1);
		expect(trackAccent('agent-systems')).toBeLessThanOrEqual(TRACK_ACCENT_COUNT);
	});

	test('an id outside the given order still resolves rather than falling off', () => {
		const accent = trackAccent('unknown-track', ['a', 'b']);
		expect(accent).toBeGreaterThanOrEqual(1);
		expect(accent).toBeLessThanOrEqual(TRACK_ACCENT_COUNT);
	});

	test('accents past the palette wrap instead of vanishing', () => {
		const order = Array.from({ length: 20 }, (_, index) => `track-${index}`);
		const accents = order.map((id) => trackAccent(id, order));
		expect(new Set(accents).size).toBe(TRACK_ACCENT_COUNT);
		expect(accents[0]).toBe(accents[TRACK_ACCENT_COUNT]);
	});

	test('classes name the accent they paint', () => {
		expect(trackAccentClass(3)).toBe('ui-track ui-track--3');
	});

	// The blank pill began here: a page port minting '' for "no track", which
	// every downstream render then treated as a value.
	test('a missing track is not a track', () => {
		expect(hasTrack('')).toBe(false);
		expect(hasTrack('   ')).toBe(false);
		expect(hasTrack(null)).toBe(false);
		expect(hasTrack(undefined)).toBe(false);
		expect(hasTrack('Agent Systems')).toBe(true);
	});
});
