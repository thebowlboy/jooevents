import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import { applyFormLens, contextFields } from './fields';
import { baselineFieldRegistry } from './sample/fields';
import type { FormSummary, SurfaceTemplate } from './types';

/**
 * Forms compose the one shared registry; the application surface renders
 * whichever form is in view. These tests cover the composition seam: derived
 * question counts, include/exclude, per-form requiredness, vocabulary-sourced
 * options with per-form exposure, and the display lens the surface preview
 * applies. Tests in this file share one in-memory workspace, in order.
 */

const applyBaselineCount = contextFields(baselineFieldRegistry(), 'apply').length;

async function servedForm(): Promise<SurfaceTemplate> {
	return (await api.templates.get('srf-application-form')) as SurfaceTemplate;
}

async function getForm(id: string): Promise<FormSummary> {
	const form = await api.forms.get(id);
	expect(form).not.toBeNull();
	return form!;
}

function poolIds(surface: SurfaceTemplate): string[] {
	return (surface.fields ?? []).map((field) => field.id);
}

describe('derived question counts', () => {
	test('a form without composition asks the full apply baseline', async () => {
		const cfp = await getForm('form-cfp');
		expect(cfp.fieldCount).toBe(applyBaselineCount);
		expect(cfp.composition.excludedFieldIds).toEqual([]);
	});

	test('exclusions subtract from the derived count — the card number is the checklist', async () => {
		const panel = await getForm('form-panel');
		expect(panel.fieldCount).toBe(applyBaselineCount - panel.composition.excludedFieldIds.length);
	});
});

describe('the configuration rows', () => {
	test('every apply question rows, excluded ones unticked, in registry order', async () => {
		const rows = (await api.forms.fields('form-panel'))!;
		const applyIds = contextFields(baselineFieldRegistry(), 'apply').map((field) => field.id);
		expect(rows.map((row) => row.field.id)).toEqual(applyIds);
		const track = rows.find((row) => row.field.id === 'fld-track')!;
		expect(track.included).toBe(false);
		const email = rows.find((row) => row.field.id === 'fld-email')!;
		expect(email.included).toBe(true);
		expect(email.field.locked).toBe(true);
	});

	test('a sourced choice field rows with the live vocabulary and its exposure', async () => {
		const rows = (await api.forms.fields('form-evergreen'))!;
		const track = rows.find((row) => row.field.id === 'fld-track')!;
		expect(track.exposureAll).toBe(false);
		expect(track.options!.map((option) => [option.id, option.exposed])).toEqual([
			['trk-web', true],
			['trk-ai', true],
			['trk-infra', false]
		]);
		const format = rows.find((row) => row.field.id === 'fld-format')!;
		expect(format.included).toBe(false);
		expect(format.exposureAll).toBe(true);
	});

	test('a requiredness override reads as overridden; the registry default does not', async () => {
		const rows = (await api.forms.fields('form-evergreen'))!;
		const abstract = rows.find((row) => row.field.id === 'fld-abstract')!;
		expect(abstract.required).toBe(false);
		expect(abstract.requiredOverridden).toBe(true);
		const title = rows.find((row) => row.field.id === 'fld-title')!;
		expect(title.required).toBe(true);
		expect(title.requiredOverridden).toBe(false);
	});
});

describe('composing a form', () => {
	test('dropping and re-asking a shared question is composition, never deletion', async () => {
		const created = await api.forms.create({ name: 'Lightning talks', target: { kind: 'general' } });
		expect(created.fieldCount).toBe(applyBaselineCount);

		const drop = await api.forms.setIncluded(created.id, 'fld-location', false);
		expect(drop.ok).toBe(true);
		expect((await getForm(created.id)).fieldCount).toBe(applyBaselineCount - 1);
		// The registry field is untouched — other forms keep asking it.
		const registry = await api.fields.list();
		expect(registry.some((field) => field.id === 'fld-location')).toBe(true);
		expect((await getForm('form-cfp')).fieldCount).toBe(applyBaselineCount);

		const back = await api.forms.setIncluded(created.id, 'fld-location', true);
		expect(back.ok).toBe(true);
		expect((await getForm(created.id)).fieldCount).toBe(applyBaselineCount);
	});

	test('the locked email question refuses to leave any form, with the standing reason', async () => {
		const outcome = await api.forms.setIncluded('form-cfp', 'fld-email', false);
		expect(outcome).toEqual({
			ok: false,
			reason:
				'Email is how applicants are identified and reached — it cannot be removed from the application'
		});
		expect((await getForm('form-cfp')).composition.excludedFieldIds).toEqual([]);
	});

	test('requiredness overrides pin per form and clear back to the shared default', async () => {
		await api.forms.setRequired('form-cfp', 'fld-headline', false);
		let rows = (await api.forms.fields('form-cfp'))!;
		let headline = rows.find((row) => row.field.id === 'fld-headline')!;
		expect(headline.required).toBe(false);
		expect(headline.requiredOverridden).toBe(true);
		// The registry default is untouched.
		const registry = await api.fields.list();
		expect(registry.find((field) => field.id === 'fld-headline')!.required.apply).toBe(true);

		await api.forms.setRequired('form-cfp', 'fld-headline', null);
		rows = (await api.forms.fields('form-cfp'))!;
		headline = rows.find((row) => row.field.id === 'fld-headline')!;
		expect(headline.required).toBe(true);
		expect(headline.requiredOverridden).toBe(false);
	});

	test('an empty option subset is refused — hiding the question is the intent that shape means', async () => {
		const outcome = await api.forms.setExposure('form-cfp', 'fld-track', []);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('at least one option');
	});

	test('setComposition applies a batch under the same invariants as the granular setters', async () => {
		const created = await api.forms.create({ name: 'Batch test', target: { kind: 'general' } });

		const refused = await api.forms.setComposition(created.id, {
			excludedFieldIds: ['fld-email'],
			requiredOverrides: {},
			optionExposure: {}
		});
		expect(refused.ok).toBe(false);

		const emptySubset = await api.forms.setComposition(created.id, {
			excludedFieldIds: [],
			requiredOverrides: {},
			optionExposure: { 'fld-track': [] }
		});
		expect(emptySubset.ok).toBe(false);

		const applied = await api.forms.setComposition(created.id, {
			excludedFieldIds: ['fld-notes', 'fld-x'],
			requiredOverrides: { 'fld-headline': false },
			optionExposure: { 'fld-track': ['trk-web'] }
		});
		expect(applied.ok).toBe(true);
		const after = await getForm(created.id);
		expect(after.fieldCount).toBe(applyBaselineCount - 2);
		expect(after.composition.requiredOverrides).toEqual({ 'fld-headline': false });
		expect(after.composition.optionExposure).toEqual({ 'fld-track': ['trk-web'] });
	});

	test('reset returns the standard application; restoreComposition compensates it', async () => {
		const before = await getForm('form-evergreen');
		expect(before.composition.excludedFieldIds.length).toBeGreaterThan(0);

		await api.forms.reset('form-evergreen');
		const cleared = await getForm('form-evergreen');
		expect(cleared.fieldCount).toBe(applyBaselineCount);
		expect(cleared.composition).toEqual({
			excludedFieldIds: [],
			requiredOverrides: {},
			optionExposure: {}
		});

		await api.forms.restoreComposition('form-evergreen', before.composition);
		const restored = await getForm('form-evergreen');
		expect(restored.composition).toEqual(before.composition);
		expect(restored.fieldCount).toBe(before.fieldCount);
	});
});

describe('the surface preview lens', () => {
	test('the served pool carries group, source, and choice metadata the lens needs', async () => {
		const served = await servedForm();
		const track = served.fields!.find((field) => field.id === 'fld-track')!;
		expect(track.optionSource).toBe('tracks');
		expect(track.options).toEqual([
			'Agents & Tools',
			'Evals & Reliability',
			'Models & Infrastructure'
		]);
		expect(track.optionChoices!.map((choice) => choice.id)).toEqual([
			'trk-web',
			'trk-ai',
			'trk-infra'
		]);
		expect(track.group).toBe('talk');
	});

	test('a form lens drops excluded questions from the pool and every section', async () => {
		const served = await servedForm();
		const panel = await getForm('form-panel');
		const lensed = applyFormLens(served, panel);
		expect(poolIds(lensed)).not.toContain('fld-track');
		expect(poolIds(lensed)).toContain('fld-email');
		for (const block of lensed.blocks) {
			if (block.type !== 'form-section') continue;
			for (const ref of block.fieldRefs) expect(poolIds(lensed)).toContain(ref);
			expect(block.fieldRefs).not.toContain('fld-track');
		}
	});

	test('a form lens applies requiredness overrides and option exposure', async () => {
		const served = await servedForm();
		const evergreen = await getForm('form-evergreen');
		const lensed = applyFormLens(served, evergreen);
		expect(lensed.fields!.find((field) => field.id === 'fld-abstract')!.required).toBe(false);
		expect(lensed.fields!.find((field) => field.id === 'fld-track')!.options).toEqual([
			'Agents & Tools',
			'Evals & Reliability'
		]);
	});

	test('a question scoped to one form appears only under that form’s lens, in its group’s section', async () => {
		const panelBefore = await getForm('form-panel');
		const { field } = await api.fields.add({
			kind: 'text',
			label: 'Your angle on reliability',
			collectAt: ['apply'],
			formScope: 'form-panel'
		});

		const served = await servedForm();
		const panelLens = applyFormLens(served, await getForm('form-panel'));
		const cfpLens = applyFormLens(served, await getForm('form-cfp'));
		expect(poolIds(panelLens)).toContain(field.id);
		expect(poolIds(cfpLens)).not.toContain(field.id);
		const refs = panelLens.blocks.flatMap((block) =>
			block.type === 'form-section' ? block.fieldRefs : []
		);
		expect(refs).toContain(field.id);
		// The scoped question counts for its form only.
		expect((await getForm('form-panel')).fieldCount).toBe(panelBefore.fieldCount + 1);

		await api.fields.remove(field.id);
	});

	test('under the live default a new track is offered on the next serve; a pinned subset keeps it out', async () => {
		const added = await api.vocab.addTrack('Hallway track');
		const served = await servedForm();
		const cfpLens = applyFormLens(served, await getForm('form-cfp'));
		expect(cfpLens.fields!.find((field) => field.id === 'fld-track')!.options).toContain(
			'Hallway track'
		);
		const evergreenLens = applyFormLens(served, await getForm('form-evergreen'));
		expect(evergreenLens.fields!.find((field) => field.id === 'fld-track')!.options).not.toContain(
			'Hallway track'
		);
		await api.vocab.removeTrack(added.id);
	});
});

describe('intake: targets, closing, lifecycle', () => {
	test('a created form carries its typed target and optional close date', async () => {
		const dated = await api.forms.create({
			name: 'Panelists wanted',
			target: { kind: 'session', sessionId: 'ses-11' },
			closesAt: '2027-01-15'
		});
		expect(dated.target).toEqual({ kind: 'session', sessionId: 'ses-11' });
		expect(dated.closesAt).toBe('2027-01-15');
		expect(dated.status).toBe('draft');

		const undated = await api.forms.create({
			name: 'Rolling door',
			target: { kind: 'category', category: 'track', id: 'trk-ai' }
		});
		// No close date means no close date — never a default one.
		expect(undated.closesAt).toBeUndefined();
	});

	test('setClosing sets, moves, and removes the close date', async () => {
		const created = await api.forms.create({ name: 'Closing test', target: { kind: 'general' } });

		const set = await api.forms.setClosing(created.id, '2027-03-01');
		expect(set.ok).toBe(true);
		expect((await getForm(created.id)).closesAt).toBe('2027-03-01');

		const cleared = await api.forms.setClosing(created.id, null);
		expect(cleared.ok).toBe(true);
		expect((await getForm(created.id)).closesAt).toBeUndefined();

		const missing = await api.forms.setClosing('form-nope', '2027-03-01');
		expect(missing.ok).toBe(false);
	});

	test('setStatus walks the lifecycle: draft opens, open closes, closed reopens', async () => {
		const created = await api.forms.create({ name: 'Lifecycle test', target: { kind: 'general' } });
		expect(created.status).toBe('draft');

		expect((await api.forms.setStatus(created.id, 'open')).ok).toBe(true);
		expect((await getForm(created.id)).status).toBe('open');

		expect((await api.forms.setStatus(created.id, 'closed')).ok).toBe(true);
		expect((await getForm(created.id)).status).toBe('closed');

		expect((await api.forms.setStatus(created.id, 'open')).ok).toBe(true);
		expect((await getForm(created.id)).status).toBe('open');

		const missing = await api.forms.setStatus('form-nope', 'open');
		expect(missing.ok).toBe(false);
	});
});
