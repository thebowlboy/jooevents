import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { intakeFormsFixtureIds } from './fixtures/intake-forms';
import {
	applicationSurfacePublication,
	createLiveFormsPagePort
} from './forms-page-port.live';
import { applicationSurfacePublicationServes } from './forms-page-port';
import type { ReleaseOverviewDto } from '@jooevents/contracts';
import { createIntakeFormsSamplePort } from './sample/intake-forms';
import type { WorkspaceFieldsApi } from './field-registry-workspace-adapter';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { OrganizerFormsPort } from './view-models/intake-forms';

function liveForms(overrides: Partial<OrganizerFormsPort> = {}): OrganizerFormsPort {
	const sample = createIntakeFormsSamplePort();
	return Object.freeze({ ...sample, source: Object.freeze({ kind: 'live' as const }), ...overrides });
}
const vocabulary = Object.freeze({
	async tracks() { return [{ kind: 'track' as const, id: intakeFormsFixtureIds.track,
		name: 'Platform engineering', accent: 'lavender' as const, status: 'active' as const, version: 1,
		usage: { currentReferences: 2, historicalPins: 1 }, deleteAvailability: { kind: 'unavailable' as const,
			currentReferences: 2, historicalPins: 1 } }]; },
	async formats() { return []; }
}) satisfies Pick<ProgramVocabularySettingsPort, 'tracks' | 'formats'>;
const fields = Object.freeze({ async list() { return []; }, async add() { throw new TypeError('not used'); },
	async update() { return { ok: true } as const; }, async remove() { return { ok: true } as const; },
	async move() { return { ok: true } as const; }, async restore() {} }) satisfies WorkspaceFieldsApi;
function port(forms: OrganizerFormsPort = liveForms(), keys: string[] = []) {
	let sequence = 0;
	return createLiveFormsPagePort({ forms, fields, vocabulary,
			templates: { async applicationFormSurfaceId() { return null; },
			async applicationSurfacePublication() { return null; } },
		newIdempotencyKey: () => keys.shift() ?? `forms-live-test-${sequence += 1}` });
}

describe('live tuned Forms page adapter', () => {
	test('maps the active apply release to its one pinned form', () => {
		const formId = intakeFormsFixtureIds.openForm;
		const formVersionId = crypto.randomUUID();
		const overview = {
			activeSurfaceReleases: [{
				kind: 'apply',
				formRef: { formId, formVersionId }
			}]
		} as ReleaseOverviewDto;
		expect(applicationSurfacePublication(overview)).toEqual({
			kind: 'pinned', formId, formVersionId
		});
		const publication = applicationSurfacePublication(overview);
		expect(applicationSurfacePublicationServes(publication, {
			id: formId,
			currentPublishedVersionId: formVersionId
		})).toBe(true);
		expect(applicationSurfacePublicationServes(publication, {
			id: formId,
			currentPublishedVersionId: crypto.randomUUID()
		})).toBe(false);
		expect(applicationSurfacePublication({
			activeSurfaceReleases: []
		} as unknown as ReleaseOverviewDto)).toEqual({ kind: 'none' });
	});

	test('opening a form shares one detail snapshot between summary and fields', async () => {
		let details = 0;
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const sample = liveForms();
		const forms = {
			...sample,
			async readDetail(formId: string) {
				details += 1;
				started.resolve();
				await gate.promise;
				return sample.readDetail(formId);
			}
		};
		const adapter = port(forms);
		const summary = adapter.forms.get(intakeFormsFixtureIds.openForm);
		await started.promise;
		const rows = adapter.forms.fields(intakeFormsFixtureIds.openForm);
		expect(details).toBe(1);
		gate.resolve();
		expect((await summary)?.id).toBe(intakeFormsFixtureIds.openForm);
		expect((await rows)?.length).toBeGreaterThan(0);
		await adapter.forms.get(intakeFormsFixtureIds.openForm);
		expect(details).toBe(2);
	});

	test('two forms do not share an editor snapshot', async () => {
		const requested: string[] = [];
		const sample = liveForms();
		const forms = {
			...sample,
			async readDetail(formId: string) {
				requested.push(formId);
				return sample.readDetail(formId);
			}
		};
		const adapter = port(forms);
		await Promise.all([
			adapter.forms.get(intakeFormsFixtureIds.openForm),
			adapter.forms.get(intakeFormsFixtureIds.draftForm)
		]);
		expect(new Set(requested)).toEqual(new Set([
			intakeFormsFixtureIds.draftForm,
			intakeFormsFixtureIds.openForm
		]));
	});

	test('a missing form answers null for summary and fields from one detail read', async () => {
		let details = 0;
		const sample = liveForms();
		const missing = crypto.randomUUID();
		const forms = {
			...sample,
			async readDetail(formId: string) {
				details += 1;
				return sample.readDetail(formId);
			}
		};
		const adapter = port(forms);
		const [summary, rows] = await Promise.all([
			adapter.forms.get(missing),
			adapter.forms.fields(missing)
		]);
		expect(details).toBe(1);
		expect(summary).toBeNull();
		expect(rows).toBeNull();
	});

	test('projects catalog, joined rows, vocabulary, and capability absence', async () => {
		const adapter = port();
		const [forms, rows, tracks, formats, sessions] = await Promise.all([adapter.forms.list(),
			adapter.forms.fields(intakeFormsFixtureIds.openForm), adapter.vocab.tracks(),
			adapter.vocab.formats(), adapter.schedule.sessions()]);
		expect(forms[0]).toMatchObject({ id: intakeFormsFixtureIds.openForm, status: 'open' });
		expect(rows?.find((row) => row.field.id === intakeFormsFixtureIds.emailField))
			.toMatchObject({ field: { kind: 'email', locked: true }, included: true });
		expect(tracks).toMatchObject([{ id: intakeFormsFixtureIds.track }]);
		expect(formats).toEqual([]);
		expect(sessions).toEqual([]);
	});

	test('maps an unavailable application template lookup to capability absence', async () => {
		const adapter = createLiveFormsPagePort({
			forms: liveForms(), fields, vocabulary,
			templates: {
				async applicationFormSurfaceId() { throw new Error('template read failed'); },
				async applicationSurfacePublication() { throw new Error('release read failed'); }
			}
		});
		expect(await adapter.templates.applicationFormSurfaceId()).toBeNull();
		expect(await adapter.templates.applicationSurfacePublication()).toBeNull();
	});

	test('uses direct create, composition, closing, close, and reopen behavior', async () => {
		const adapter = port();
		const created = await adapter.forms.create({ name: 'Platform lightning talks',
			target: { kind: 'category', category: 'track', id: intakeFormsFixtureIds.track }, closesAt: '2026-10-20' });
		expect(created).toMatchObject({ name: 'Platform lightning talks', status: 'draft' });
		const composition = { excludedFieldIds: [intakeFormsFixtureIds.abstractField],
			requiredOverrides: {}, optionExposure: {} };
		expect(await adapter.forms.setComposition(created.id, composition)).toEqual({ ok: true });
		expect(await adapter.forms.setClosing(created.id, '2026-10-27')).toEqual({ ok: true });
		const prepared = await adapter.forms.preparePublish(created.id);
		if (!prepared.ok) throw new TypeError('publication_review_expected');
		expect(await adapter.forms.publish(prepared.review)).toEqual({ ok: true });
		expect(await adapter.forms.setStatus(created.id, 'closed')).toEqual({ ok: true });
		expect(await adapter.forms.setStatus(created.id, 'open')).toEqual({ ok: true });
	});

	test('round-trips bounded conditional rules through one guarded Form revision', async () => {
		const adapter = port();
		const formId = intakeFormsFixtureIds.openForm;
		const before = await adapter.forms.get(formId);
		const rules = [{
			key: 'rule-track-abstract',
			condition: {
				kind: 'selected_any' as const,
				sourceFieldId: intakeFormsFixtureIds.trackField,
				choiceIds: [intakeFormsFixtureIds.track]
			},
			effect: {
				kind: 'require' as const,
				targetFieldIds: [intakeFormsFixtureIds.abstractField]
			}
		}];
		expect(await adapter.forms.setRules(formId, rules)).toEqual({ ok: true });
		expect(await adapter.forms.rules(formId)).toEqual(rules);
		expect((await adapter.forms.get(formId))?.version).toBe((before?.version ?? 0) + 1);
		expect(await adapter.forms.setRules(formId, [])).toEqual({ ok: true });
		expect(await adapter.forms.rules(formId)).toEqual([]);
	});

	test('rule writes return a mutation outcome instead of throwing through the page', async () => {
		const adapter = port(liveForms({
			async revise() { throw new TypeError('rule_write_failed'); }
		}));
		expect(await adapter.forms.setRules(intakeFormsFixtureIds.openForm, [])).toEqual({
			ok: false,
			reason: 'This form change could not be applied.'
		});
	});

	test('keeps publication inert until a second press with a distinct stable key', async () => {
		const base = liveForms();
		const calls: { stage: string; key: string }[] = [];
		const wrapped: OrganizerFormsPort = Object.freeze({ ...base, source: Object.freeze({ kind: 'live' as const }),
			async draftPublish(input: Parameters<OrganizerFormsPort['draftPublish']>[0],
				key: string, options?: Parameters<OrganizerFormsPort['draftPublish']>[2]) { calls.push({ stage: 'draft', key });
				return base.draftPublish(input, key, options); },
			async publish(input: Parameters<OrganizerFormsPort['publish']>[0],
				key: string, options?: Parameters<OrganizerFormsPort['publish']>[2]) { calls.push({ stage: 'publish', key });
				return base.publish(input, key, options); } });
		const adapter = port(wrapped, ['draft-key', 'publish-key']);
		const prepared = await adapter.forms.preparePublish(intakeFormsFixtureIds.draftForm);
		if (!prepared.ok) throw new TypeError('publication_review_expected');
		expect(await adapter.forms.get(intakeFormsFixtureIds.draftForm)).toMatchObject({ status: 'draft' });
		expect(prepared.review).toMatchObject({ action: 'publish_and_open', resultingStatus: 'open',
			surfaceSuccessorCount: 0 });
		expect(await adapter.forms.publish(prepared.review)).toEqual({ ok: true });
		expect(calls).toEqual([{ stage: 'draft', key: 'draft-key' }, { stage: 'publish', key: 'publish-key' }]);
	});

	test('requires live source and has no predecessor or raw transport dependency', () => {
		expect(() => createLiveFormsPagePort({ forms: createIntakeFormsSamplePort(), fields, vocabulary,
			templates: { async applicationFormSurfaceId() { return null; },
				async applicationSurfacePublication() { return null; } } })).toThrow('forms_page_live_source_required');
		const source = readFileSync(import.meta.path.replace(/\.test\.ts$/u, '.ts'), 'utf8');
		expect(source).not.toMatch(/(?:from|import\s*\()[^\n]*\/sample(?:\/|['"])/u);
		expect(source).not.toMatch(/readDiff|\.propose\(|\.commit\(|changesetId|restoreComposition/u);
		const page = readFileSync(new URL('../features/forms/FormsPage.svelte', import.meta.url), 'utf8');
		expect(page).toContain('title="Review publication"');
		expect(page).toContain('>Publish and open</Button>');
		expect(page).toContain('>Cancel</Button>');
		expect(page).toContain('Edit the current questions and apply another change');
		expect(page).toContain('Edit the current close date and apply another change');
		expect(page).not.toContain('restoreComposition');
	});
});
