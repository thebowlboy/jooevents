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
	async tracks() {
		return [{
			kind: 'track' as const,
			id: intakeFormsFixtureIds.track,
			name: 'Platform engineering',
			accent: 'lavender' as const,
			status: 'active' as const,
			version: 1,
			usage: { currentReferences: 2, historicalPins: 1 },
			deleteAvailability: {
				kind: 'unavailable' as const,
				currentReferences: 2,
				historicalPins: 1
			}
		}];
	},
	async formats() {
		return [];
	}
}) satisfies Pick<ProgramVocabularySettingsPort, 'tracks' | 'formats'>;

const fields = Object.freeze({
	async list() { return []; },
	async add() { throw new TypeError('not used'); },
	async update() { return { ok: true } as const; },
	async remove() { return { ok: true } as const; },
	async move() { return { ok: true } as const; },
	async restore() {}
}) satisfies WorkspaceFieldsApi;

function port(forms: OrganizerFormsPort = liveForms()) {
	let sequence = 0;
	return createLiveFormsPagePort({
		forms,
		fields,
		vocabulary,
		newIdempotencyKey: () => `forms-live-test-${sequence += 1}`
	});
}

describe('live tuned Forms page adapter', () => {
	test('projects catalog, joined Registry rows, vocabulary, and truthful capability absence', async () => {
		const adapter = port();
		const [forms, rows, tracks, formats, sessions, surfaceId] = await Promise.all([
			adapter.forms.list(),
			adapter.forms.fields(intakeFormsFixtureIds.openForm),
			adapter.vocab.tracks(),
			adapter.vocab.formats(),
			adapter.schedule.sessions(),
			adapter.templates.applicationFormSurfaceId()
		]);

		expect(forms[0]).toMatchObject({
			id: intakeFormsFixtureIds.openForm,
			target: { kind: 'general' },
			status: 'open',
			composition: { excludedFieldIds: [] }
		});
		expect(rows?.find((row) => row.field.id === intakeFormsFixtureIds.emailField))
			.toMatchObject({ field: { kind: 'email', locked: true }, included: true });
		expect(tracks).toMatchObject([{ id: intakeFormsFixtureIds.track, name: 'Platform engineering' }]);
		expect(formats).toEqual([]);
		expect(sessions).toEqual([]);
		expect(surfaceId).toBeNull();
	});

	test('commits create, composition, closing, and lifecycle as exact three-stage workflows', async () => {
		const adapter = port();
		const created = await adapter.forms.create({
			name: 'Platform lightning talks',
			target: { kind: 'category', category: 'track', id: intakeFormsFixtureIds.track },
			closesAt: '2026-10-20'
		});
		expect(created).toMatchObject({
			name: 'Platform lightning talks',
			target: { kind: 'category', category: 'track', id: intakeFormsFixtureIds.track },
			closesAt: '2026-10-20',
			status: 'draft'
		});

		const composition = {
			excludedFieldIds: [intakeFormsFixtureIds.abstractField],
			requiredOverrides: { [intakeFormsFixtureIds.trackField]: true },
			optionExposure: { [intakeFormsFixtureIds.trackField]: [intakeFormsFixtureIds.track] }
		};
		expect(await adapter.forms.setComposition(created.id, composition)).toEqual({ ok: true });
		expect(await adapter.forms.get(created.id)).toMatchObject({
			composition,
			fieldCount: 5
		});

		expect(await adapter.forms.setClosing(created.id, '2026-10-27')).toEqual({ ok: true });
		expect(await adapter.forms.get(created.id)).toMatchObject({ closesAt: '2026-10-27' });
		expect(await adapter.forms.setStatus(created.id, 'open')).toEqual({ ok: true });
		expect(await adapter.forms.get(created.id)).toMatchObject({ status: 'open' });
		expect(await adapter.forms.setStatus(created.id, 'closed')).toEqual({ ok: true });
		expect(await adapter.forms.get(created.id)).toMatchObject({ status: 'closed' });
	});

	test('fails closed when proposal bytes do not match the drafted safe diff', async () => {
		const base = liveForms();
		let commitCalls = 0;
		const mismatched = liveForms({
			...base,
			async propose(input, key, options) {
				const result = await base.propose(input, key, options);
				if (result.kind !== 'success') return result;
				return {
					...result,
					data: {
						...result.data,
						operations: result.data.operations.map((operation) => ({
							...operation,
							safeDiff: operation.safeDiff.action === 'closing'
								? {
										...operation.safeDiff,
										deadline: {
											...operation.safeDiff.deadline,
											action: 'update' as const
										}
									}
								: operation.safeDiff
						}))
					}
				};
			},
			async commit(input, key, options) {
				commitCalls += 1;
				return base.commit(input, key, options);
			}
		});
		const outcome = await port(mismatched).forms.setClosing(
			intakeFormsFixtureIds.openForm,
			'2026-11-01'
		);
		expect(outcome).toEqual({
			ok: false,
			reason: 'The proposed Form change did not match its reviewed draft.'
		});
		expect(commitCalls).toBe(0);
	});

	test('requires a live canonical source and contains no sample or raw transport dependency', () => {
		expect(() => createLiveFormsPagePort({
			forms: createIntakeFormsSamplePort(), fields, vocabulary
		})).toThrow('forms_page_live_source_required');
		const source = readFileSync(import.meta.path.replace(/\.test\.ts$/u, '.ts'), 'utf8');
		expect(source).not.toMatch(/(?:from|import\s*\()[^\n]*\/sample(?:\/|['"])/u);
		expect(source).not.toContain('requestJson');
		expect(source).not.toMatch(/\bfetch\s*\(/u);
	});
});
