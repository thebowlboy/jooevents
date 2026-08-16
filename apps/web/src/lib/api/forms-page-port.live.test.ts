import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { intakeFormsFixtureIds } from './fixtures/intake-forms';
import { createLiveFormsPagePort } from './forms-page-port.live';
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
		templates: { async applicationFormSurfaceId() { return null; } },
		newIdempotencyKey: () => keys.shift() ?? `forms-live-test-${sequence += 1}` });
}

describe('live tuned Forms page adapter', () => {
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
			templates: { async applicationFormSurfaceId() { return null; } } })).toThrow('forms_page_live_source_required');
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
