import { describe, expect, test } from 'bun:test';
import {
	SIZE_MAX,
	SIZE_MIN,
	allSizes,
	clampSize,
	compileTextStyle,
	filledTextStyle,
	normalizeTextStyle,
	sameTextStyle,
	sizeLadder,
	styleChangeSummary,
	type StyleUnitKind
} from './text-style';
import { resolveUnit, withTextStyle } from './inline-edit';
import type { MessageTemplate, SurfaceTemplate } from '../../api/types';

const kinds: StyleUnitKind[] = ['heading', 'paragraph', 'hero-title', 'hero-intro', 'note'];

describe('clampSize', () => {
	test('forces every number into the bounded integer range', () => {
		expect(clampSize(200)).toBe(SIZE_MAX);
		expect(clampSize(3)).toBe(SIZE_MIN);
		expect(clampSize(SIZE_MIN)).toBe(10);
		expect(clampSize(SIZE_MAX)).toBe(72);
		expect(clampSize(24)).toBe(24);
		// Integers only: fractional entry rounds rather than storing fractions.
		expect(clampSize(16.6)).toBe(17);
		expect(clampSize(16.4)).toBe(16);
		// A non-finite value cannot escape the range either.
		expect(clampSize(Number.NaN)).toBe(SIZE_MIN);
		expect(clampSize(Number.POSITIVE_INFINITY)).toBe(SIZE_MIN);
	});
});

describe('sizeLadder', () => {
	test('each kind pins its unstyled base and leads with recommended steps', () => {
		expect(sizeLadder('heading')).toEqual({ base: 24, recommended: [20, 24, 28, 32] });
		expect(sizeLadder('paragraph')).toEqual({ base: 16, recommended: [14, 16, 18, 20] });
		expect(sizeLadder('hero-title')).toEqual({ base: 28, recommended: [24, 28, 32, 36] });
		expect(sizeLadder('hero-intro')).toEqual({ base: 16, recommended: [14, 16, 18, 20] });
		expect(sizeLadder('note')).toEqual({ base: 14, recommended: [12, 14, 16, 18] });
	});

	test('every ladder is ascending, in bounds, and contains its own base', () => {
		for (const kind of kinds) {
			const { base, recommended } = sizeLadder(kind);
			expect(recommended).toContain(base);
			for (const px of recommended) {
				expect(px).toBeGreaterThanOrEqual(SIZE_MIN);
				expect(px).toBeLessThanOrEqual(SIZE_MAX);
				expect(Number.isInteger(px)).toBe(true);
			}
			for (let step = 1; step < recommended.length; step += 1) {
				expect(recommended[step]).toBeGreaterThan(recommended[step - 1]);
			}
		}
	});

	test('ladders are per unit kind: a heading’s recommendations are not a paragraph’s', () => {
		expect(sizeLadder('heading').recommended).not.toEqual(sizeLadder('paragraph').recommended);
	});
});

describe('allSizes', () => {
	test('spans the whole bounded range, ascending integers, dense then coarse', () => {
		const sizes = allSizes();
		expect(sizes[0]).toBe(SIZE_MIN);
		expect(sizes[sizes.length - 1]).toBe(SIZE_MAX);
		for (const px of sizes) expect(Number.isInteger(px)).toBe(true);
		for (let step = 1; step < sizes.length; step += 1) {
			expect(sizes[step]).toBeGreaterThan(sizes[step - 1]);
		}
		// Every-integer density through 40; 4px strides above it.
		expect(sizes).toContain(23);
		expect(sizes).toContain(40);
		expect(sizes).toContain(44);
		expect(sizes).not.toContain(45);
	});
});

describe('compileTextStyle', () => {
	test('a size number compiles to its literal px on any kind', () => {
		for (const kind of kinds) {
			expect(compileTextStyle(kind, { size: 20 })).toBe('font-size: 20px');
		}
	});

	test('sizes clamp on the way out — a stored tag cannot escape the range', () => {
		expect(compileTextStyle('heading', { size: 200 })).toBe(`font-size: ${SIZE_MAX}px`);
		expect(compileTextStyle('heading', { size: 2 })).toBe(`font-size: ${SIZE_MIN}px`);
	});

	test('weight and align compile literally, joined in declaration order', () => {
		expect(compileTextStyle('paragraph', { weight: 'semibold' })).toBe('font-weight: 600');
		expect(compileTextStyle('paragraph', { weight: 'regular' })).toBe('font-weight: 400');
		expect(compileTextStyle('paragraph', { align: 'center' })).toBe('text-align: center');
		expect(compileTextStyle('heading', { size: 28, weight: 'semibold', align: 'center' })).toBe(
			'font-size: 28px; font-weight: 600; text-align: center'
		);
	});

	test('no tag and an empty tag compile to no attribute at all', () => {
		expect(compileTextStyle('heading', undefined)).toBeUndefined();
		expect(compileTextStyle('heading', {})).toBeUndefined();
	});
});

describe('normalize and compare', () => {
	test('defaults are dropped per kind; an all-default tag normalizes away', () => {
		expect(
			normalizeTextStyle('heading', { size: 24, weight: 'regular', align: 'start' })
		).toBeUndefined();
		expect(normalizeTextStyle('paragraph', { size: 20, weight: 'regular' })).toEqual({ size: 20 });
		// The same number is default on one kind and a real tag on another.
		expect(normalizeTextStyle('paragraph', { size: 16 })).toBeUndefined();
		expect(normalizeTextStyle('heading', { size: 16 })).toEqual({ size: 16 });
	});

	test('normalization clamps: an out-of-range size stores the bound', () => {
		expect(normalizeTextStyle('heading', { size: 200 })).toEqual({ size: SIZE_MAX });
		expect(normalizeTextStyle('heading', { size: 1 })).toEqual({ size: SIZE_MIN });
	});

	test('filled defaults take the kind base, so absent and explicit-base compare equal', () => {
		expect(filledTextStyle('heading', undefined)).toEqual({
			size: 24,
			weight: 'regular',
			align: 'start'
		});
		expect(filledTextStyle('note', undefined).size).toBe(14);
		expect(sameTextStyle('heading', undefined, { size: 24 })).toBe(true);
		expect(sameTextStyle('heading', undefined, { size: 28 })).toBe(false);
	});

	test('change summaries phrase sizes in px: size: 16px → 20px', () => {
		expect(styleChangeSummary('paragraph', undefined, { size: 20 })).toEqual([
			'size: 16px → 20px'
		]);
		expect(styleChangeSummary('heading', undefined, { size: 28 })).toEqual(['size: 24px → 28px']);
		expect(styleChangeSummary('paragraph', { size: 20 }, { size: 20, align: 'center' })).toEqual([
			'align: start → center'
		]);
	});
});

// ---------------------------------------------------------------------------
// The unit model carries style tags through resolve and rebuild.

function message(): MessageTemplate {
	return {
		id: 'tpl-x',
		key: 'x',
		name: 'X',
		purpose: 'p',
		subject: 'S',
		blocks: [
			{ type: 'heading', text: 'Hello' },
			{ type: 'paragraph', text: 'Body', style: { size: 18 } },
			{ type: 'button', label: 'Go', href: 'portal.tasks' }
		],
		mergeFields: [],
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

function surface(): SurfaceTemplate {
	return {
		id: 'srf-x',
		kind: 'schedule',
		name: 'X',
		purpose: 'p',
		blocks: [
			{ type: 'hero', title: 'T', intro: 'I' },
			{ type: 'note', text: 'N' }
		],
		revision: 1,
		revisions: [],
		usedBy: []
	};
}

describe('style tags in the inline unit model', () => {
	test('styleable units resolve with their ladder kind and current tag', () => {
		const doc = message();
		const heading = resolveUnit(doc, 'blocks.0.text');
		expect(heading).toMatchObject({ type: 'text', styleKind: 'heading' });
		const paragraph = resolveUnit(doc, 'blocks.1.text');
		expect(paragraph).toMatchObject({ type: 'text', styleKind: 'paragraph', style: { size: 18 } });
		// A button label carries no style tags: no controls, no compile kind.
		const button = resolveUnit(doc, 'blocks.2.label');
		expect(button).toMatchObject({ type: 'text' });
		expect((button as { styleKind?: string }).styleKind).toBeUndefined();

		const page = surface();
		expect(resolveUnit(page, 'blocks.0.title')).toMatchObject({ styleKind: 'hero-title' });
		expect(resolveUnit(page, 'blocks.0.intro')).toMatchObject({ styleKind: 'hero-intro' });
		expect(resolveUnit(page, 'blocks.1.text')).toMatchObject({ styleKind: 'note' });
	});

	test('withTextStyle stores a normalized tag and clears an all-default one', () => {
		const doc = message();
		const styled = withTextStyle(doc, 'blocks.0.text', {
			size: 32,
			weight: 'regular',
			align: 'center'
		}) as MessageTemplate;
		expect(styled.blocks[0]).toEqual({
			type: 'heading',
			text: 'Hello',
			style: { size: 32, align: 'center' }
		});
		// The copy is fresh; the original is untouched.
		expect(doc.blocks[0]).toEqual({ type: 'heading', text: 'Hello' });

		const cleared = withTextStyle(styled, 'blocks.0.text', {
			size: 24,
			weight: 'regular',
			align: 'start'
		}) as MessageTemplate;
		expect(cleared.blocks[0]).toEqual({ type: 'heading', text: 'Hello' });
	});

	test('withTextStyle addresses a hero’s title and intro tags separately', () => {
		const page = surface();
		const titled = withTextStyle(page, 'blocks.0.title', { size: 36 }) as SurfaceTemplate;
		expect(titled.blocks[0]).toEqual({ type: 'hero', title: 'T', intro: 'I', titleStyle: { size: 36 } });
		const introed = withTextStyle(titled, 'blocks.0.intro', { weight: 'semibold' }) as SurfaceTemplate;
		expect(introed.blocks[0]).toEqual({
			type: 'hero',
			title: 'T',
			intro: 'I',
			titleStyle: { size: 36 },
			introStyle: { weight: 'semibold' }
		});
	});
});
