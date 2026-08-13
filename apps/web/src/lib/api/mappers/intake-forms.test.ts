import { describe, expect, test } from 'bun:test';
import {
	formDefinitionAuthorInputSchema,
	organizerFormCatalogSchema,
	organizerFormDetailSchema
} from '@jooevents/contracts';
import {
	intakeFormsFixtureIds,
	sampleOrganizerFormCatalogDto,
	sampleOrganizerFormDetailDtos
} from '../fixtures/intake-forms';
import {
	mapFormDefinitionToAuthorInput,
	mapOrganizerFormCatalog,
	mapOrganizerFormDetail
} from './intake-forms';

describe('organizer Forms mapper boundary', () => {
	test('keeps sample fixtures on the canonical read contracts', () => {
		expect(organizerFormCatalogSchema.safeParse(sampleOrganizerFormCatalogDto).success).toBe(true);
		for (const detail of Object.values(sampleOrganizerFormDetailDtos)) {
			expect(organizerFormDetailSchema.safeParse(detail).success).toBe(true);
		}
	});

	test('maps the version guard, status copy, counts, and target without leaking scope', () => {
		const mapped = mapOrganizerFormCatalog(sampleOrganizerFormCatalogDto);
		expect(mapped).toMatchObject({
			catalogVersion: 3,
			forms: [
				{
					id: intakeFormsFixtureIds.openForm,
					status: 'open',
					statusLabel: 'Open',
					target: { kind: 'general_pool', label: 'General pool' },
					submissionCount: 18
				},
				{
					id: intakeFormsFixtureIds.draftForm,
					statusLabel: 'Draft',
					target: {
						kind: 'category',
						categoryKind: 'track',
						categoryId: intakeFormsFixtureIds.track,
						label: 'Track target'
					}
				}
			]
		});
		expect(JSON.stringify(mapped)).not.toContain(intakeFormsFixtureIds.workspace);
		expect(JSON.stringify(mapped)).not.toContain(intakeFormsFixtureIds.user);
	});

	test('keeps shared fields joined while returning a valid metadata-only revision input', () => {
		const detail = sampleOrganizerFormDetailDtos[intakeFormsFixtureIds.openForm];
		if (!detail) throw new TypeError('Fixture detail missing.');
		const authorInput = mapFormDefinitionToAuthorInput(detail.head.definition);
		expect(formDefinitionAuthorInputSchema.safeParse(authorInput).success).toBe(true);
		expect(authorInput).toMatchObject({
			name: 'Main call for proposals',
			composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
			rules: []
		});
		expect(JSON.stringify(authorInput)).not.toContain(intakeFormsFixtureIds.emailField);

		const mapped = mapOrganizerFormDetail(detail);
		expect(mapped).toMatchObject({
			form: { id: intakeFormsFixtureIds.openForm, version: 2, status: 'open' },
			publishedVersion: { id: intakeFormsFixtureIds.publishedVersion, number: 1 }
		});
		expect(mapped.fields.slice(0, 2)).toMatchObject([
			{ field: { label: 'Session title' }, included: true },
			{ field: { label: 'Abstract' }, included: true }
		]);
	});
});
