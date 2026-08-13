import { describe, expect, test } from 'bun:test';
import { structuredOutcomeSchema } from '@jooevents/contracts';
import { changesetOutcomeCopy, changesetTransportCopy, changesetUnavailableCopy } from './copy';

describe('changeset review copy', () => {
	test('maps outcomes through closed product copy without exposing codes or detail', () => {
		const outcome = structuredOutcomeSchema.parse({
			class: 'stale_revision',
			kind: 'changeset.lifecycle_refused',
			retryable: false,
			subjects: [],
			detail: { code: 'revision_changed', internal: 'do not render' },
			detailSchemaVersion: 1
		});
		const copy = changesetOutcomeCopy(outcome, '00000000-0000-4000-8000-000000000001');
		expect(copy).toMatchObject({ title: 'The draft changed', retryable: false });
		expect(JSON.stringify(copy)).not.toContain(outcome.kind);
		expect(JSON.stringify(copy)).not.toContain('revision_changed');
		expect(JSON.stringify(copy)).not.toContain('do not render');
	});

	test('uses one safe transport fallback and never displays unavailable reason codes', () => {
		expect(changesetTransportCopy({ code: 'http_503', retryable: true }).message)
			.not.toContain('503');
		expect(JSON.stringify(changesetUnavailableCopy('commit'))).not.toContain('operation_not_registered');
	});
});
