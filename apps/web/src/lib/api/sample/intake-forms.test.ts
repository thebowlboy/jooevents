import { describe, expect, test } from 'bun:test';
import { intakeFormsFixtureIds } from '../fixtures/intake-forms';
import { createIntakeFormsSamplePort } from './intake-forms';

describe('resettable canonical organizer Forms sample port', () => {
	test('applies direct lifecycle once and replays the same key', async () => {
		const port = createIntakeFormsSamplePort();
		const before = await port.readDetail(intakeFormsFixtureIds.openForm);
		if (before.kind !== 'success') throw new TypeError('Sample detail missing.');
		const input = { transition: 'close' as const, formId: before.data.form.id,
			expectedDefinitionVersion: before.data.form.version };
		const first = await port.lifecycle(input, 'sample-close');
		const replay = await port.lifecycle(input, 'sample-close');
		expect(replay).toEqual(first);
		expect(first).toMatchObject({ kind: 'success', data: { action: 'close' },
			receipt: { operationName: 'form.lifecycle.change' } });
		expect(await port.readDetail(before.data.form.id)).toMatchObject({
			kind: 'success', data: { form: { status: 'closed', version: before.data.form.version + 1 } }
		});
	});

	test('keeps publication inert until exact publish and resets the fixture', async () => {
		const port = createIntakeFormsSamplePort();
		const before = await port.readDetail(intakeFormsFixtureIds.draftForm);
		if (before.kind !== 'success') throw new TypeError('Sample draft Form missing.');
		const draft = await port.draftPublish({ action: 'publish_and_open', formId: before.data.form.id,
			expectedDefinitionVersion: before.data.form.version,
			expectedRegistryVersion: before.data.registryPin.version }, 'sample-publish-draft');
		if (draft.kind !== 'success') throw new TypeError('Sample publication review missing.');
		expect((await port.readDetail(before.data.form.id))).toMatchObject({ kind: 'success',
			data: { form: { status: 'draft', version: before.data.form.version } } });
		const selector = { draftId: draft.data.draftId, revisionId: draft.data.revision.id,
			revisionDigestSha256: draft.data.revision.digestSha256 };
		const published = await port.publish(selector, 'sample-publish');
		expect(published).toMatchObject({ kind: 'success', data: { action: 'publish_and_open' },
			receipt: { operationName: 'form.version.publish' } });
		expect(await port.publish(selector, 'sample-publish')).toEqual(published);
		expect(await port.readDetail(before.data.form.id)).toMatchObject({ kind: 'success',
			data: { form: { status: 'open', currentPublishedVersionId: expect.any(String) } } });
		port.reset();
		expect(await port.readDetail(before.data.form.id)).toMatchObject({ kind: 'success',
			data: { form: { status: 'draft', version: before.data.form.version } } });
	});
});
