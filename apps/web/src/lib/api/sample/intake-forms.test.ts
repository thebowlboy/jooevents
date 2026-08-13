import { describe, expect, test } from 'bun:test';
import { intakeFormsFixtureIds } from '../fixtures/intake-forms';
import { createIntakeFormsSamplePort } from './intake-forms';

describe('resettable canonical organizer Forms sample port', () => {
	test('does not change effective state before propose and commit', async () => {
		const port = createIntakeFormsSamplePort();
		const before = await port.readDetail(intakeFormsFixtureIds.openForm);
		if (before.kind !== 'success') throw new TypeError('Sample detail missing.');
		const draft = await port.draftLifecycle({
			transition: 'close',
			formId: before.data.form.id,
			expectedDefinitionVersion: before.data.form.version
		}, 'sample-close-draft');
		if (draft.kind !== 'success') throw new TypeError('Sample draft failed.');
		expect((await port.readDetail(before.data.form.id))).toMatchObject({
			kind: 'success', data: { form: { status: 'open', version: 2 } }
		});

		const selector = {
			changesetId: draft.data.changesetId,
			revisionId: draft.data.revisionId,
			revisionDigest: draft.data.revisionDigest
		};
		const diff = await port.readDiff(selector);
		expect(diff).toMatchObject({ kind: 'success', data: { status: 'draft' } });
		const proposed = await port.propose({ ...selector, expectedHeadVersion: 1 }, 'sample-close-propose');
		expect(proposed).toMatchObject({ kind: 'success', data: { status: 'proposed', headVersion: 2 } });
		expect((await port.readDetail(before.data.form.id))).toMatchObject({
			kind: 'success', data: { form: { status: 'open', version: 2 } }
		});
		await port.commit({ ...selector, expectedHeadVersion: 2 }, 'sample-close-commit');
		expect((await port.readDetail(before.data.form.id))).toMatchObject({
			kind: 'success', data: { form: { status: 'closed', version: 3 } }
		});
		expect(await port.draftLifecycle({
			transition: 'close',
			formId: before.data.form.id,
			expectedDefinitionVersion: before.data.form.version
		}, 'sample-close-draft')).toEqual(draft);
	});

	test('replays an idempotency key and reset restores the fixture', async () => {
		const port = createIntakeFormsSamplePort();
		const listed = await port.list();
		if (listed.kind !== 'success') throw new TypeError('Sample catalog missing.');
		const definition = {
			kind: 'cfp' as const,
			name: 'Lightning talk proposals',
			target: { kind: 'general_pool' as const },
			availability: { kind: 'evergreen' as const },
			confirmation: 'Thanks — your lightning talk is in the review queue.',
			composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
			rules: []
		};
		const createInput = {
			expectedCatalogVersion: listed.data.catalogVersion,
			expectedRegistryVersion: listed.data.registryPin.version,
			definition
		};
		const first = await port.draftCreate(createInput, 'same-create');
		const replay = await port.draftCreate(createInput, 'same-create');
		expect(replay).toEqual(first);
		port.reset();
		expect(await port.list()).toMatchObject({ kind: 'success', data: { catalogVersion: 3 } });
	});
});
