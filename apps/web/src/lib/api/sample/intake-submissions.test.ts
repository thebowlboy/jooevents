import { describe, expect, test } from 'bun:test';
import opening from './opening';
import { createSampleIntakeSubmissionsPort } from './intake-submissions';

describe('sample organizer submissions adapter', () => {
	test('feeds the common safe list/detail port while keeping contact separate', async () => {
		const port = createSampleIntakeSubmissionsPort({
			dataset: opening,
			contactCapability: { kind: 'available' }
		});
		const common = port;
		const listed = await common.list();
		expect(listed.kind).toBe('success');
		if (listed.kind !== 'success') return;
		const first = listed.data[0];
		if (!first) throw new TypeError('sample submission expected');
		expect(first).toMatchObject({
			id: opening.submissions[0]?.id,
			title: opening.submissions[0]?.title,
			primaryParticipantName: opening.submissions[0]?.speakers[0]?.name,
			target: { kind: 'category', label: opening.tracks[0]?.name }
		});
		expect(JSON.stringify(listed.data)).not.toContain(opening.submissions[0]?.speakers[0]?.email);

		const detail = await common.readDetail(first.id);
		expect(detail).toMatchObject({
			kind: 'success',
			data: {
				submissionId: first.id,
				answers: [
					{ fieldLabel: 'Session title' },
					{ fieldLabel: 'Abstract' },
					{ fieldLabel: 'Track' },
					{ fieldLabel: 'Format' }
				]
			}
		});
		expect(JSON.stringify(detail)).not.toContain(opening.submissions[0]?.speakers[0]?.email);

		if (common.contact.kind !== 'available') throw new TypeError('contact capability expected');
		const contact = await common.contact.read(first.id);
		expect(contact).toEqual({
			kind: 'success',
			data: {
				submissionId: first.id,
				email: opening.submissions[0]?.speakers[0]?.email
			}
		});
	});

	test('retains no contact projection or contact method in the no-contact branch', async () => {
		const port = createSampleIntakeSubmissionsPort({
			dataset: opening,
			contactCapability: { kind: 'unavailable', reason: 'not_authorized' }
		});
		expect(port.contact).toEqual({ kind: 'unavailable', reason: 'not_authorized' });
		expect('read' in port.contact).toBe(false);

		const listed = await port.list();
		expect(JSON.stringify([port.source, port.contact, listed])).not.toContain(
			opening.submissions[0]?.speakers[0]?.email
		);
	});

	test('projects an isolated resettable scenario image instead of aliasing the dataset', async () => {
		const dataset = structuredClone(opening);
		const originalTitle = dataset.submissions[0]?.title;
		const port = createSampleIntakeSubmissionsPort({
			dataset,
			contactCapability: { kind: 'unavailable', reason: 'not_enabled' }
		});
		if (dataset.submissions[0]) dataset.submissions[0].title = 'Changed outside the adapter';

		const beforeReset = await port.list();
		expect(beforeReset.kind === 'success' && beforeReset.data[0]?.title).toBe(originalTitle);
		port.reset();
		const afterReset = await port.list();
		expect(afterReset.kind === 'success' && afterReset.data[0]?.title).toBe(originalTitle);
		expect(port.source).toMatchObject({
			kind: 'sample',
			label: 'Sample data',
			scenario: { key: opening.key, name: opening.name }
		});
	});
});
