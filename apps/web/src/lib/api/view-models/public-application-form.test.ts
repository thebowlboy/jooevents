import { describe, expect, test } from 'bun:test';
import type { ServedPublicFormDto, ServedPublicFormFieldDto } from '@jooevents/contracts';
import {
	PUBLIC_APPLICATION_REQUIRED_CHECKBOX_MESSAGE,
	PUBLIC_APPLICATION_REQUIRED_MESSAGE,
	publicApplicationControlValue,
	publicApplicationFieldInput,
	publicApplicationFieldStates,
	publicApplicationSaveStatusView,
	publicApplicationSubmitBlockers
} from './public-application-form';

const id = (suffix: string): string => `019c2f33-0000-7000-8000-00000000${suffix}`;

const fieldIds = {
	title: id('00a1'),
	abstract: id('00a2'),
	email: id('00a3'),
	format: id('00a4'),
	topics: id('00a5'),
	remote: id('00a6'),
	travel: id('00a7'),
	attendees: id('00a8')
} as const;

const optionIds = {
	talk: id('00b1'),
	workshop: id('00b2'),
	ai: id('00b3'),
	craft: id('00b4')
} as const;

const base = {
	help: null,
	required: false,
	initiallyVisible: true,
	position: 0
} as const;

function field(
	overrides: { kind: ServedPublicFormFieldDto['kind']; id: string } & Record<string, unknown>
): ServedPublicFormFieldDto {
	return { ...base, label: 'Question', ...overrides } as ServedPublicFormFieldDto;
}

function servedForm(overrides: Partial<ServedPublicFormDto> = {}): ServedPublicFormDto {
	return {
		schemaVersion: 1,
		formId: id('00f0'),
		formVersionId: id('00f1'),
		formVersionNumber: 1,
		name: 'Call for proposals',
		confirmation: 'Thanks — it’s in.',
		target: { kind: 'general_pool' },
		availability: { kind: 'evergreen' },
		fields: [
			field({ kind: 'text', id: fieldIds.title, required: true, position: 0, maximumLength: 500 }),
			field({ kind: 'email', id: fieldIds.email, required: true, position: 1, maximumLength: 320 })
		],
		rules: [],
		...overrides
	} as ServedPublicFormDto;
}

describe('field input mapping', () => {
	test('an accepted text answer arrives contract-normalized', () => {
		const input = publicApplicationFieldInput(
			field({ kind: 'text', id: fieldIds.title, maximumLength: 500 }),
			'  A talk about intent \n'
		);
		expect(input).toEqual({
			kind: 'answer',
			answer: { kind: 'text', fieldId: fieldIds.title, value: 'A talk about intent' }
		});
	});

	test('whitespace-only text is emptiness, not an answer', () => {
		const input = publicApplicationFieldInput(
			field({ kind: 'text', id: fieldIds.title, maximumLength: 500 }),
			'   '
		);
		expect(input).toEqual({ kind: 'empty' });
	});

	test('overlong text refuses with the length sentence', () => {
		const input = publicApplicationFieldInput(
			field({ kind: 'text', id: fieldIds.title, maximumLength: 500 }),
			'x'.repeat(501)
		);
		expect(input).toEqual({ kind: 'invalid', message: 'Keep this to 500 characters.' });
	});

	test('a malformed email refuses with the email sentence', () => {
		const input = publicApplicationFieldInput(
			field({ kind: 'email', id: fieldIds.email, maximumLength: 320 }),
			'not-an-address'
		);
		expect(input).toEqual({
			kind: 'invalid',
			message: 'Enter an email address like name@example.com.'
		});
		expect(
			publicApplicationFieldInput(
				field({ kind: 'email', id: fieldIds.email, maximumLength: 320 }),
				'ada@example.org'
			)
		).toMatchObject({ kind: 'answer' });
	});

	test('numbers honor the served integer and bounds constraints', () => {
		const attendees = field({
			kind: 'number',
			id: fieldIds.attendees,
			minimum: 1,
			maximum: 500,
			integerOnly: true
		});
		expect(publicApplicationFieldInput(attendees, '2.5')).toEqual({
			kind: 'invalid',
			message: 'Enter a whole number.'
		});
		expect(publicApplicationFieldInput(attendees, '0')).toEqual({
			kind: 'invalid',
			message: 'Enter a number of at least 1.'
		});
		expect(publicApplicationFieldInput(attendees, '501')).toEqual({
			kind: 'invalid',
			message: 'Enter a number of at most 500.'
		});
		expect(publicApplicationFieldInput(attendees, '42')).toEqual({
			kind: 'answer',
			answer: { kind: 'number', fieldId: fieldIds.attendees, value: 42 }
		});
	});

	test('a select answer carries the option identity, not its label', () => {
		const format = field({
			kind: 'select',
			id: fieldIds.format,
			options: [
				{ id: optionIds.talk, label: 'Talk', position: 0 },
				{ id: optionIds.workshop, label: 'Workshop', position: 1 }
			]
		});
		expect(publicApplicationFieldInput(format, optionIds.talk)).toEqual({
			kind: 'answer',
			answer: { kind: 'select', fieldId: fieldIds.format, choiceId: optionIds.talk }
		});
		expect(publicApplicationFieldInput(format, 'Talk')).toEqual({
			kind: 'invalid',
			message: 'Choose one of the listed options.'
		});
	});

	test('a multiselect refuses past its served selection cap', () => {
		const topics = field({
			kind: 'multiselect',
			id: fieldIds.topics,
			maximumSelections: 1,
			options: [
				{ id: optionIds.ai, label: 'AI', position: 0 },
				{ id: optionIds.craft, label: 'Craft', position: 1 }
			]
		});
		expect(publicApplicationFieldInput(topics, [optionIds.ai, optionIds.craft])).toEqual({
			kind: 'invalid',
			message: 'Choose up to 1.'
		});
		expect(publicApplicationFieldInput(topics, [optionIds.ai])).toEqual({
			kind: 'answer',
			answer: { kind: 'multiselect', fieldId: fieldIds.topics, choiceIds: [optionIds.ai] }
		});
		expect(publicApplicationFieldInput(topics, [])).toEqual({ kind: 'empty' });
	});

	test('a datetime control value becomes a stored instant and round-trips back', () => {
		const travel = field({ kind: 'datetime', id: fieldIds.travel });
		const input = publicApplicationFieldInput(travel, '2027-05-04T09:30');
		if (input.kind !== 'answer' || input.answer.kind !== 'datetime') {
			throw new Error('expected a datetime answer');
		}
		expect(input.answer.value.endsWith('Z')).toBe(true);
		expect(publicApplicationControlValue(travel, input.answer)).toBe('2027-05-04T09:30');
	});

	test('an unchecked checkbox is still an explicit answer', () => {
		const remote = field({ kind: 'checkbox', id: fieldIds.remote });
		expect(publicApplicationFieldInput(remote, false)).toEqual({
			kind: 'answer',
			answer: { kind: 'checkbox', fieldId: fieldIds.remote, checked: false }
		});
	});
});

describe('visibility and requiredness under served rules', () => {
	const workshopForm = (): ServedPublicFormDto =>
		servedForm({
			fields: [
				field({
					kind: 'select',
					id: fieldIds.format,
					position: 0,
					options: [
						{ id: optionIds.talk, label: 'Talk', position: 0 },
						{ id: optionIds.workshop, label: 'Workshop', position: 1 }
					]
				}),
				field({ kind: 'text', id: fieldIds.title, position: 1, maximumLength: 500 }),
				field({
					kind: 'textarea',
					id: fieldIds.abstract,
					position: 2,
					initiallyVisible: false,
					maximumLength: 10_000
				}),
				field({ kind: 'checkbox', id: fieldIds.remote, position: 3 })
			],
			rules: [
				{
					id: id('00c1'),
					position: 0,
					condition: { kind: 'selected_any', sourceFieldId: fieldIds.format, choiceIds: [optionIds.workshop] },
					effect: { kind: 'show', targetFieldIds: [fieldIds.abstract] }
				},
				{
					id: id('00c2'),
					position: 1,
					condition: { kind: 'checked_is', sourceFieldId: fieldIds.remote, value: true },
					effect: { kind: 'require', targetFieldIds: [fieldIds.title] }
				}
			]
		} as Partial<ServedPublicFormDto>);

	test('a rule-hidden field appears only once its condition holds', () => {
		const form = workshopForm();
		const before = publicApplicationFieldStates(form, []);
		expect(before.get(fieldIds.abstract)).toEqual({ visible: false, required: false });
		const after = publicApplicationFieldStates(form, [
			{ kind: 'select', fieldId: fieldIds.format, choiceId: optionIds.workshop }
		]);
		expect(after.get(fieldIds.abstract)).toEqual({ visible: true, required: false });
	});

	test('a require rule binds a visible field into the submit gate', () => {
		const form = workshopForm();
		const answers = [{ kind: 'checkbox', fieldId: fieldIds.remote, checked: true } as const];
		expect(publicApplicationFieldStates(form, answers).get(fieldIds.title)).toEqual({
			visible: true,
			required: true
		});
		expect(publicApplicationSubmitBlockers(form, answers)).toEqual([
			{ fieldId: fieldIds.title, message: PUBLIC_APPLICATION_REQUIRED_MESSAGE }
		]);
	});
});

describe('submit gating', () => {
	test('required visible fields without acceptable answers block, hidden ones do not', () => {
		const form = servedForm({
			fields: [
				field({ kind: 'text', id: fieldIds.title, required: true, position: 0, maximumLength: 500 }),
				field({
					kind: 'textarea',
					id: fieldIds.abstract,
					required: true,
					initiallyVisible: false,
					position: 1,
					maximumLength: 10_000
				}),
				field({ kind: 'checkbox', id: fieldIds.remote, required: true, position: 2 })
			]
		} as Partial<ServedPublicFormDto>);
		expect(publicApplicationSubmitBlockers(form, [])).toEqual([
			{ fieldId: fieldIds.title, message: PUBLIC_APPLICATION_REQUIRED_MESSAGE },
			{ fieldId: fieldIds.remote, message: PUBLIC_APPLICATION_REQUIRED_CHECKBOX_MESSAGE }
		]);
	});

	test('a required checkbox is satisfied only checked', () => {
		const form = servedForm({
			fields: [field({ kind: 'checkbox', id: fieldIds.remote, required: true, position: 0 })]
		} as Partial<ServedPublicFormDto>);
		expect(
			publicApplicationSubmitBlockers(form, [
				{ kind: 'checkbox', fieldId: fieldIds.remote, checked: false }
			])
		).toHaveLength(1);
		expect(
			publicApplicationSubmitBlockers(form, [
				{ kind: 'checkbox', fieldId: fieldIds.remote, checked: true }
			])
		).toEqual([]);
	});
});

describe('the quiet autosave line', () => {
	test('states map to saved, saving, offline, and the quiet default', () => {
		expect(
			publicApplicationSaveStatusView({ phase: 'ready', dirty: false, answers: [], transport: null })
		).toEqual({ kind: 'quiet', label: 'Answers save as you go.' });
		expect(
			publicApplicationSaveStatusView({
				phase: 'ready',
				dirty: true,
				answers: [{ kind: 'checkbox', fieldId: fieldIds.remote, checked: true }],
				transport: null
			})
		).toEqual({ kind: 'saving', label: 'Saving…' });
		expect(
			publicApplicationSaveStatusView({
				phase: 'saving',
				dirty: true,
				answers: [],
				transport: null
			})
		).toEqual({ kind: 'saving', label: 'Saving…' });
		expect(
			publicApplicationSaveStatusView({
				phase: 'ready',
				dirty: false,
				answers: [{ kind: 'checkbox', fieldId: fieldIds.remote, checked: true }],
				transport: null
			})
		).toEqual({ kind: 'saved', label: 'Saved' });
		expect(
			publicApplicationSaveStatusView({
				phase: 'ready',
				dirty: true,
				answers: [],
				transport: { code: 'network_unavailable', retryable: true }
			})
		).toEqual({ kind: 'offline', label: 'Not saved yet — check your connection.' });
		expect(
			publicApplicationSaveStatusView({ phase: 'stopped', dirty: false, answers: [], transport: null })
		).toBeNull();
		expect(
			publicApplicationSaveStatusView({ phase: 'submitted', dirty: false, answers: [], transport: null })
		).toBeNull();
	});
});
