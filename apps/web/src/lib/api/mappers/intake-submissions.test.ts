import { describe, expect, test } from 'bun:test';
import {
	organizerSubmissionContactSchema,
	organizerSubmissionDetailSchema,
	organizerSubmissionSummarySchema
} from '@jooevents/contracts';
import {
	mapOrganizerSubmissionContact,
	mapOrganizerSubmissionDetail,
	mapOrganizerSubmissionSummary
} from './intake-submissions';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

describe('organizer submission canonical-to-view mapping', () => {
	test('maps the safe summary without inventing contact or workflow state', () => {
		const summary = organizerSubmissionSummarySchema.parse({
			schemaVersion: 1,
			id: id(1),
			formId: id(2),
			formVersionId: id(3),
			target: { kind: 'category', category: { kind: 'track', id: id(4) } },
			title: 'Systems that stay understandable',
			primaryParticipantName: 'Ada Mensah',
			submittedAt: '2026-08-12T10:15:00.000Z'
		});

		const view = mapOrganizerSubmissionSummary(summary);
		expect(view).toEqual({
			id: id(1),
			formId: id(2),
			formVersionId: id(3),
			target: {
				kind: 'category',
				categoryKind: 'track',
				categoryId: id(4),
				label: 'Track target'
			},
			title: 'Systems that stay understandable',
			primaryParticipantName: 'Ada Mensah',
			submittedAt: '2026-08-12T10:15:00.000Z',
			submittedAtLabel: 'Aug 12, 2026 · 10:15 UTC'
		});
		expect('email' in view).toBe(false);
		expect('decision' in view).toBe(false);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.target)).toBe(true);
	});

	test('keeps a fixed session target without inventing a session title', () => {
		const summary = organizerSubmissionSummarySchema.parse({
			schemaVersion: 1,
			id: id(5),
			formId: id(6),
			formVersionId: id(7),
			target: { kind: 'session', sessionId: id(8) },
			title: null,
			primaryParticipantName: null,
			submittedAt: '2026-08-12T10:15:00.000Z'
		});

		expect(mapOrganizerSubmissionSummary(summary)).toMatchObject({
			target: { kind: 'session', sessionId: id(8), label: 'Session target' },
			title: 'Untitled submission'
		});
	});

	test('keeps historical field and choice labels from the pinned form version', () => {
		const detail = organizerSubmissionDetailSchema.parse({
			schemaVersion: 1,
			submissionId: id(10),
			formId: id(11),
			formVersionId: id(12),
			submittedAt: '2026-08-12T10:00:00.000Z',
			participantCount: 1,
			answers: [
				{
					kind: 'text',
					fieldId: id(20),
					fieldLabel: 'Original session title',
					value: 'A useful proposal'
				},
				{
					kind: 'select',
					fieldId: id(21),
					fieldLabel: 'Original format question',
					choice: { id: id(30), label: 'Original workshop label' }
				},
				{
					kind: 'multiselect',
					fieldId: id(22),
					fieldLabel: 'Original topic question',
					choices: [
						{ id: id(31), label: 'Operations' },
						{ id: id(32), label: 'Reliability' }
					]
				},
				{
					kind: 'checkbox',
					fieldId: id(23),
					fieldLabel: 'Original consent wording',
					checked: true
				}
			],
			affirmedConsentFieldIds: [id(23)]
		});

		const view = mapOrganizerSubmissionDetail(detail);
		expect(view.answers).toEqual([
			{
				type: 'text',
				fieldId: id(20),
				fieldLabel: 'Original session title',
				value: 'A useful proposal'
			},
			{
				type: 'select',
				fieldId: id(21),
				fieldLabel: 'Original format question',
				choice: { id: id(30), label: 'Original workshop label' }
			},
			{
				type: 'multiselect',
				fieldId: id(22),
				fieldLabel: 'Original topic question',
				choices: [
					{ id: id(31), label: 'Operations' },
					{ id: id(32), label: 'Reliability' }
				]
			},
			{
				type: 'checkbox',
				fieldId: id(23),
				fieldLabel: 'Original consent wording',
				checked: true
			}
		]);
		expect(JSON.stringify(view)).not.toContain('email');
		expect(JSON.stringify(view)).not.toContain('payloadRef');
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.answers)).toBe(true);
		expect(Object.isFrozen(view.answers[2])).toBe(true);
		expect(view.answers[2]?.type === 'multiselect' && Object.isFrozen(view.answers[2].choices)).toBe(true);
	});

	test('projects contact separately and drops internal identity references', () => {
		const contact = organizerSubmissionContactSchema.parse({
			schemaVersion: 1,
			submissionId: id(40),
			personId: id(41),
			participantIdentityId: id(42),
			sourceFieldId: id(43),
			email: 'speaker@example.com'
		});

		const view = mapOrganizerSubmissionContact(contact);
		expect(view).toEqual({ submissionId: id(40), email: 'speaker@example.com' });
		expect('personId' in view).toBe(false);
		expect('participantIdentityId' in view).toBe(false);
		expect('sourceFieldId' in view).toBe(false);
		expect(Object.isFrozen(view)).toBe(true);
	});
});
