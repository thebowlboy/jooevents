import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import { starterSurfaceTemplates } from './sample/templates';
import type { SurfaceBlock } from './types';
import flight from './sample/flight';
import opening from './sample/opening';
import crunch from './sample/crunch';
import quiet from './sample/quiet';
import fresh from './sample/fresh';
import { isSurfaceTemplate } from './types';
import type { ReviseProgress, SurfaceTemplate } from './types';

const seededScenarios = [flight, opening, crunch, quiet];

function scheduleListing(surface: SurfaceTemplate) {
	return surface.blocks.find((block) => block.type === 'schedule-days');
}

describe('starter surface set', () => {
	test('every fieldRef in every form-section resolves to the field pool', () => {
		for (const scenario of seededScenarios) {
			for (const surface of scenario.surfaces) {
				const pool = new Set((surface.fields ?? []).map((field) => field.id));
				for (const block of surface.blocks) {
					if (block.type !== 'form-section') continue;
					for (const ref of block.fieldRefs) expect(pool.has(ref)).toBe(true);
				}
			}
		}
	});

	test('the schedule surface seeds coherently in all four scenarios', () => {
		for (const scenario of seededScenarios) {
			const schedule = scenario.surfaces.find((surface) => surface.kind === 'schedule');
			expect(schedule).toBeDefined();
			expect(schedule!.revision).toBe(1);
			expect(schedule!.usedBy).toEqual(['Public schedule · standalone & embed']);

			const hero = schedule!.blocks.find((block) => block.type === 'hero');
			expect(hero?.title).toBe('AI Engineer NYC 2026 schedule');

			expect(scheduleListing(schedule!)).toMatchObject({
				grouping: 'day',
				showRoom: true,
				showTrack: true,
				showSpeakers: true,
				density: 'cozy'
			});

			const note = schedule!.blocks.find((block) => block.type === 'note');
			expect(note?.text).toContain('recorded');
		}
	});

	test('the application form serves the CFP with a select, a consent checkbox, and help texts', () => {
		const form = starterSurfaceTemplates('AI Engineer NYC 2026').find(
			(surface) => surface.kind === 'application-form'
		)!;
		expect(form.usedBy).toEqual(['CFP form · standalone & embed']);
		expect(form.fields!.length).toBeGreaterThanOrEqual(10);

		const select = form.fields!.find((field) => field.kind === 'select');
		expect(select?.options?.length).toBeGreaterThan(1);
		const consent = form.fields!.find((field) => field.kind === 'checkbox');
		expect(consent?.required).toBe(true);
		expect(form.fields!.some((field) => (field.help ?? '').length > 0)).toBe(true);

		const sections = form.blocks.filter((block) => block.type === 'form-section');
		expect(sections.map((section) => section.title)).toEqual(['About you', 'Your talk']);
	});

	test('fresh seeds no surfaces and keeps the area locked', () => {
		expect(fresh.surfaces).toEqual([]);
		expect(fresh.summary.lockedAreas).toContain('templates');
	});
});

describe('surfaces ride the same facade', () => {
	test('list returns both collections side by side', async () => {
		const { messages, surfaces } = await api.templates.list();
		expect(messages.length).toBe(6);
		expect(surfaces.map((surface) => surface.kind)).toEqual(['schedule', 'application-form']);
	});

	test('classify treats structural surface words as comprehensive', async () => {
		for (const instruction of [
			'Add a question about dietary needs',
			'add a section for workshops',
			'group by track'
		]) {
			expect((await api.templates.classify('srf-application-form', instruction)).scope).toBe(
				'comprehensive'
			);
		}
	});

	test('a wording-only touch on a surface stays quick', async () => {
		expect((await api.templates.classify('srf-schedule', 'Make the intro warmer')).scope).toBe(
			'quick'
		);
	});
});

describe('revise, apply, revert on the schedule surface', () => {
	test(
		'revise("group by track") flips grouping in the draft only, until apply commits it',
		async () => {
			const before = structuredClone((await api.templates.get('srf-schedule')) as SurfaceTemplate);
			expect(scheduleListing(before)?.grouping).toBe('day');

			const progress: ReviseProgress[] = [];
			const { draft, note } = await api.templates.revise('srf-schedule', 'group by track', (p) =>
				progress.push({ ...p })
			);

			// The same streaming contract messages have: classify first, monotonic
			// tokens, done at the profile's total.
			expect(progress[0]).toEqual({ status: 'classifying', tokens: 0 });
			expect(progress.at(-1)).toEqual({ status: 'done', tokens: 900 });
			for (let i = 1; i < progress.length; i += 1) {
				expect(progress[i].tokens).toBeGreaterThanOrEqual(progress[i - 1].tokens);
			}

			expect(isSurfaceTemplate(draft)).toBe(true);
			const surfaceDraft = draft as SurfaceTemplate;
			expect(scheduleListing(surfaceDraft)?.grouping).toBe('track');
			expect(surfaceDraft.revision).toBe(before.revision + 1);
			expect(note).toBe('Regrouped the schedule by track.');

			// The stored surface has not moved at all.
			expect(await api.templates.get('srf-schedule')).toEqual(before);

			// Apply commits it; revert restores day grouping as a new revision on top.
			expect(await api.templates.applyRevision('srf-schedule', surfaceDraft)).toEqual({ ok: true });
			const stored = (await api.templates.get('srf-schedule')) as SurfaceTemplate;
			expect(scheduleListing(stored)?.grouping).toBe('track');

			expect(await api.templates.revertTo('srf-schedule', before.revision)).toEqual({ ok: true });
			const reverted = (await api.templates.get('srf-schedule')) as SurfaceTemplate;
			expect(scheduleListing(reverted)?.grouping).toBe('day');
			expect(reverted.revision).toBe(before.revision + 2);
			expect(reverted.revisions.at(-1)).toEqual({
				number: reverted.revision,
				at: 'Just now',
				by: 'you',
				note: `Reverted to revision ${before.revision}`
			});
		},
		20000
	);
});

/*
 * The form surface's revise vocabulary executes field work through the
 * registry seam: drafts carry a simulated projection, apply syncs the one
 * registry, and the locked email question refuses with its typed reason.
 */
describe('assistant field operations on the application form', () => {
	const FORM = 'srf-application-form';

	function talkSection(surface: SurfaceTemplate) {
		return surface.blocks.find(
			(block): block is Extract<SurfaceBlock, { type: 'form-section' }> =>
				block.type === 'form-section' && block.title === 'Your talk'
		);
	}

	test(
		'"add a travel question" drafts a logistics-placed field; apply registers it with the advisor placement',
		async () => {
			const before = structuredClone((await api.templates.get(FORM)) as SurfaceTemplate);
			expect(before.fields!.some((field) => field.label === 'Travel plans')).toBe(false);

			const { draft, note } = await api.templates.revise(FORM, 'Add a travel question');
			const revised = draft as SurfaceTemplate;
			const minted = revised.fields!.find((field) => field.label === 'Travel plans');
			expect(minted).toBeDefined();
			expect(note).toContain('“Travel plans”');
			expect(note).toContain('logistics');

			// The draft previews the served projection: the question sits in the
			// talk section after the last talk question and before consent.
			const refs = talkSection(revised)!.fieldRefs;
			expect(refs.indexOf(minted!.id)).toBeGreaterThan(refs.indexOf('fld-notes'));
			expect(refs.indexOf(minted!.id)).toBeLessThan(refs.indexOf('fld-consent'));

			// Draft-only: the registry has not moved.
			expect((await api.fields.list()).some((field) => field.label === 'Travel plans')).toBe(false);

			// Apply syncs the registry through the placement advisor.
			expect(await api.templates.applyRevision(FORM, revised)).toEqual({ ok: true });
			const registry = await api.fields.list();
			const entry = registry.find((field) => field.label === 'Travel plans');
			expect(entry).toBeDefined();
			expect(entry!.group).toBe('logistics');
			expect(entry!.collectAt).toEqual(['apply']);
			const labels = registry.map((field) => field.label);
			expect(labels.indexOf('Travel plans')).toBe(labels.indexOf('Dietary needs') + 1);
			// The served form asks it on the next read.
			const served = (await api.templates.get(FORM)) as SurfaceTemplate;
			expect(served.fields!.some((field) => field.id === entry!.id)).toBe(true);

			// Cleanup: compensate the add and restore the template revision.
			expect(await api.fields.remove(entry!.id)).toEqual({ ok: true });
			expect(await api.templates.revertTo(FORM, before.revision)).toEqual({ ok: true });
		},
		20000
	);

	test(
		'"ask about dietary" asks the existing registry question at apply instead of duplicating it',
		async () => {
			const before = (await api.templates.get(FORM)) as SurfaceTemplate;
			expect(before.fields!.some((field) => field.id === 'fld-dietary')).toBe(false);

			const { draft, note } = await api.templates.revise(FORM, 'Ask about dietary needs');
			const revised = draft as SurfaceTemplate;
			expect(revised.fields!.some((field) => field.id === 'fld-dietary')).toBe(true);
			expect(note).toContain('“Dietary needs”');

			// Draft-only until apply; then the context joins the one registry.
			let dietary = (await api.fields.list()).find((field) => field.id === 'fld-dietary')!;
			expect(dietary.collectAt).toEqual(['onboard']);
			expect(await api.templates.applyRevision(FORM, revised)).toEqual({ ok: true });
			dietary = (await api.fields.list()).find((field) => field.id === 'fld-dietary')!;
			expect(dietary.collectAt).toContain('apply');

			// Cleanup.
			expect(await api.fields.update('fld-dietary', { collectAt: ['onboard'] })).toEqual({ ok: true });
			expect(await api.templates.revertTo(FORM, before.revision)).toEqual({ ok: true });
		},
		20000
	);

	test(
		'"make headline optional" flips required in the draft, and apply writes it to the registry',
		async () => {
			const before = (await api.templates.get(FORM)) as SurfaceTemplate;
			expect(before.fields!.find((field) => field.id === 'fld-headline')!.required).toBe(true);

			const { draft, note } = await api.templates.revise(FORM, 'Make headline optional');
			const revised = draft as SurfaceTemplate;
			expect(revised.fields!.find((field) => field.id === 'fld-headline')!.required).toBe(false);
			// A requiredness flip moves no block.
			expect(revised.blocks).toEqual(before.blocks);
			expect(note).toContain('optional');

			expect(
				(await api.fields.list()).find((field) => field.id === 'fld-headline')!.required.apply
			).toBe(true);
			expect(await api.templates.applyRevision(FORM, revised)).toEqual({ ok: true });
			expect(
				Boolean(
					(await api.fields.list()).find((field) => field.id === 'fld-headline')!.required.apply
				)
			).toBe(false);

			// Cleanup.
			expect(
				await api.fields.update('fld-headline', { required: { apply: true } })
			).toEqual({ ok: true });
			expect(await api.templates.revertTo(FORM, before.revision)).toEqual({ ok: true });
		},
		20000
	);

	test(
		'removing the locked email question refuses with the typed reason and drafts nothing',
		async () => {
			const before = structuredClone((await api.templates.get(FORM)) as SurfaceTemplate);
			await expect(api.templates.revise(FORM, 'Remove the email question')).rejects.toThrow(
				'cannot be removed from the application'
			);
			// Nothing moved: the stored surface and the registry are unchanged.
			expect(await api.templates.get(FORM)).toEqual(before);
			const email = (await api.fields.list()).find((field) => field.id === 'fld-email')!;
			expect(email.collectAt).toContain('apply');
		},
		20000
	);
});
