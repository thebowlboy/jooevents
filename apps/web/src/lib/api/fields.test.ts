import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import { contextFields, sectionFieldIds } from './fields';
import { baselineFieldRegistry } from './sample/fields';
import { starterSurfaceTemplates } from './sample/templates';
import flight from './sample/flight';
import opening from './sample/opening';
import crunch from './sample/crunch';
import quiet from './sample/quiet';
import fresh from './sample/fresh';
import type { RegistryField, SurfaceTemplate } from './types';

const seededScenarios = [flight, opening, crunch, quiet];

function ids(fields: { id: string }[]): string[] {
	return fields.map((field) => field.id);
}

async function servedForm(): Promise<SurfaceTemplate> {
	return (await api.templates.get('srf-application-form')) as SurfaceTemplate;
}

function sectionRefs(form: SurfaceTemplate, title: string): string[] {
	const section = form.blocks.find(
		(block) => block.type === 'form-section' && block.title === title
	);
	return section && section.type === 'form-section' ? section.fieldRefs : [];
}

describe('baseline registry seeding', () => {
	test('every seeded scenario carries the same complete baseline; fresh carries none', () => {
		for (const scenario of seededScenarios) {
			expect(ids(scenario.fieldRegistry)).toEqual(ids(baselineFieldRegistry()));
		}
		expect(fresh.fieldRegistry).toEqual([]);
	});

	test('positions are the list order, and groups follow the ladder at seed time', () => {
		const baseline = baselineFieldRegistry();
		baseline.forEach((field, index) => expect(field.position).toBe(index));
		// Consent is seeded last; apply is lighter than the whole registry.
		expect(baseline.at(-1)?.group).toBe('consent');
		const applyCount = baseline.filter((field) => field.collectAt.includes('apply')).length;
		expect(applyCount).toBeLessThan(baseline.length);
	});

	test('only email is locked, and it is asked at apply', () => {
		const locked = baselineFieldRegistry().filter((field) => field.locked);
		expect(locked.map((field) => field.id)).toEqual(['fld-email']);
		expect(locked[0].kind).toBe('email');
		expect(locked[0].collectAt).toContain('apply');
	});

	test('the starter form template derives its pool and refs from the baseline registry', () => {
		const form = starterSurfaceTemplates('AI Engineer NYC 2026').find(
			(surface) => surface.kind === 'application-form'
		)!;
		const apply = contextFields(baselineFieldRegistry(), 'apply');
		expect(ids(form.fields!)).toEqual(ids(apply));
		// Onboard-only questions stay off the application.
		expect(ids(form.fields!)).not.toContain('fld-arrival');
		expect(ids(form.fields!)).not.toContain('fld-headshot');
	});
});

describe('sectionFieldIds', () => {
	test('consent renders at the end even when its position is not last', () => {
		const registry: RegistryField[] = [
			{
				id: 'agree',
				kind: 'checkbox',
				label: 'I agree',
				required: {},
				collectAt: ['apply'],
				group: 'consent',
				position: 0
			},
			{
				id: 'title',
				kind: 'text',
				label: 'Title',
				required: {},
				collectAt: ['apply'],
				group: 'talk',
				position: 1
			}
		];
		expect(sectionFieldIds(registry, ['talk', 'consent'], 'apply')).toEqual(['title', 'agree']);
	});

	test('a form-scoped field joins only its own form', () => {
		const registry: RegistryField[] = [
			{
				id: 'extra',
				kind: 'text',
				label: 'Panel angle',
				required: {},
				collectAt: ['apply'],
				group: 'talk',
				position: 0,
				formScope: 'form-panel'
			}
		];
		expect(sectionFieldIds(registry, ['talk'], 'apply')).toEqual([]);
		expect(sectionFieldIds(registry, ['talk'], 'apply', 'form-panel')).toEqual(['extra']);
	});
});

describe('api.fields.add goes through the advisor', () => {
	test('a new field is classified, spliced at the advised index, and the reason names the anchor', async () => {
		const before = await api.fields.list();
		const lastLogistics = [...before].reverse().find((field) => field.group === 'logistics')!;
		const expectedIndex = before.lastIndexOf(lastLogistics) + 1;

		const { field, placement } = await api.fields.add({
			kind: 'text',
			label: 'Visa letter needed?',
			collectAt: ['onboard']
		});
		expect(placement.group).toBe('logistics');
		expect(placement.index).toBe(expectedIndex);
		expect(placement.reason).toBe(
			`Placed with the other logistics questions, after “${lastLogistics.label}”.`
		);
		expect(field.group).toBe('logistics');

		const after = await api.fields.list();
		expect(after[expectedIndex].id).toBe(field.id);
		// Positions stay the list order, renumbered around the splice.
		after.forEach((entry, index) => expect(entry.position).toBe(index));
		expect(ids(after).filter((id) => id !== field.id)).toEqual(ids(before));

		expect(await api.fields.remove(field.id)).toEqual({ ok: true });
		expect(await api.fields.list()).toEqual(before);
	});

	test('requiredIn marks exactly the named contexts', async () => {
		const { field } = await api.fields.add({
			kind: 'checkbox',
			label: 'Permission to share my slides',
			collectAt: ['onboard'],
			requiredIn: ['onboard']
		});
		expect(field.required).toEqual({ onboard: true });
		expect(field.group).toBe('consent');
		await api.fields.remove(field.id);
	});
});

describe('the locked email field', () => {
	test('cannot be deleted', async () => {
		const outcome = await api.fields.remove('fld-email');
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('cannot be removed from the application');
		expect(ids(await api.fields.list())).toContain('fld-email');
	});

	test('cannot leave the apply context', async () => {
		const outcome = await api.fields.update('fld-email', { collectAt: ['onboard', 'profile'] });
		expect(outcome.ok).toBe(false);
		const email = (await api.fields.list()).find((field) => field.id === 'fld-email')!;
		expect(email.collectAt).toContain('apply');
	});

	test('other edits to it still pass', async () => {
		const email = (await api.fields.list()).find((field) => field.id === 'fld-email')!;
		const originalHelp = email.help;
		expect(await api.fields.update('fld-email', { help: 'Where decisions go.' })).toEqual({
			ok: true
		});
		expect(await api.fields.update('fld-email', { help: originalHelp })).toEqual({ ok: true });
	});

	test('an unknown field refuses update and move, and remove is a quiet success', async () => {
		expect((await api.fields.update('fld-nope', { label: 'X' })).ok).toBe(false);
		expect((await api.fields.move('fld-nope', 0)).ok).toBe(false);
		expect(await api.fields.remove('fld-nope')).toEqual({ ok: true });
	});
});

describe('user-owned ordering', () => {
	test('move persists, and a later add anchors relative to the moved layout', async () => {
		const before = await api.fields.list();
		const emailIndex = ids(before).indexOf('fld-email');

		// The user drags their one contact question up next to the name.
		expect(await api.fields.move('fld-email', 1)).toEqual({ ok: true });
		const moved = await api.fields.list();
		expect(ids(moved)[1]).toBe('fld-email');
		moved.forEach((entry, index) => expect(entry.position).toBe(index));

		// A new contact field now anchors after the moved field — index 2, not
		// the ladder's canonical contact slot.
		const { field, placement } = await api.fields.add({
			kind: 'phone',
			label: 'Phone number',
			collectAt: ['apply']
		});
		expect(placement.group).toBe('contact');
		expect(placement.index).toBe(2);
		expect(placement.reason).toBe('Placed with the other contact questions, after “Email”.');
		expect(ids(await api.fields.list()).slice(1, 3)).toEqual(['fld-email', field.id]);

		// Put the layout back.
		await api.fields.remove(field.id);
		expect(await api.fields.move('fld-email', emailIndex)).toEqual({ ok: true });
		expect(await api.fields.list()).toEqual(before);
	});

	test('restore is the compensating write for remove', async () => {
		const before = await api.fields.list();
		const pronouns = before.find((field) => field.id === 'fld-pronouns')!;
		const index = before.indexOf(pronouns);
		const keep = structuredClone(pronouns);

		expect(await api.fields.remove('fld-pronouns')).toEqual({ ok: true });
		expect(ids(await api.fields.list())).not.toContain('fld-pronouns');

		await api.fields.restore(keep, index);
		expect(await api.fields.list()).toEqual(before);

		// Restoring again is a no-op, not a duplicate.
		await api.fields.restore(keep, index);
		expect(await api.fields.list()).toEqual(before);
	});
});

describe('the application form serves the registry projection', () => {
	test('the served pool is exactly the apply-context fields, in position order', async () => {
		const registry = await api.fields.list();
		const apply = registry.filter((field) => field.collectAt.includes('apply'));
		const form = await servedForm();

		expect(ids(form.fields!)).toEqual(ids(apply));
		// Requiredness resolves per apply context.
		const email = form.fields!.find((field) => field.id === 'fld-email')!;
		expect(email.required).toBe(true);
		const location = form.fields!.find((field) => field.id === 'fld-location')!;
		expect(location.required).toBe(false);

		// Every apply field is asked in exactly one section, consent last overall.
		const refs = [...sectionRefs(form, 'About you'), ...sectionRefs(form, 'Your talk')];
		expect(refs.sort()).toEqual(ids(apply).sort());
		expect(sectionRefs(form, 'Your talk').at(-1)).toBe('fld-consent');
	});

	test('a registry add appears on the next serve, in its group’s section, before consent', async () => {
		const { field } = await api.fields.add({
			kind: 'text',
			label: 'Dietary needs for the speaker dinner',
			collectAt: ['apply']
		});
		const form = await servedForm();
		const talkRefs = sectionRefs(form, 'Your talk');
		expect(talkRefs).toContain(field.id);
		expect(talkRefs.indexOf(field.id)).toBeLessThan(talkRefs.indexOf('fld-consent'));
		expect(ids(form.fields!)).toContain(field.id);

		await api.fields.remove(field.id);
		expect(ids((await servedForm()).fields!)).not.toContain(field.id);
	});

	test('an onboard-only add never reaches the application form', async () => {
		const { field, placement } = await api.fields.add({
			kind: 'datetime',
			label: 'Departure date',
			collectAt: ['onboard']
		});
		expect(placement.group).toBe('logistics');
		const form = await servedForm();
		expect(ids(form.fields!)).not.toContain(field.id);
		await api.fields.remove(field.id);
	});
});
