import {
	transientApplicationAnswerInputSchema,
	type ServedPublicFormDto,
	type ServedPublicFormFieldDto,
	type TransientApplicationAnswerInput
} from '@jooevents/contracts';
import type { PublicApplicationSessionSnapshot } from '../public-application-session';

/**
 * The answering surface's own logic, framework-free: what each served field
 * shows, which fields the served rules make visible or required right now,
 * how one control value becomes (or refuses to become) a contract-shaped
 * answer, and what the quiet autosave line says.
 *
 * The server stays the authority on what a submission may contain; everything
 * here only surfaces the served form's own declared constraints early, in
 * reviewed sentences, so the draft never carries an answer the contract would
 * refuse at the boundary.
 */

// ---------------------------------------------------------------------------
// Visibility and requiredness under the served rules

export interface PublicApplicationFieldState {
	readonly visible: boolean;
	readonly required: boolean;
}

function conditionHolds(
	condition: ServedPublicFormDto['rules'][number]['condition'],
	answersByField: ReadonlyMap<string, TransientApplicationAnswerInput>
): boolean {
	const answer = answersByField.get(condition.sourceFieldId);
	if (condition.kind === 'selected_any') {
		if (answer?.kind === 'select') return condition.choiceIds.includes(answer.choiceId);
		if (answer?.kind === 'multiselect') {
			return answer.choiceIds.some((choiceId) => condition.choiceIds.includes(choiceId));
		}
		return false;
	}
	// An untouched checkbox reads as unchecked.
	const checked = answer?.kind === 'checkbox' ? answer.checked : false;
	return checked === condition.value;
}

/**
 * Every field's effective visibility and requiredness given the current
 * answers, from the served initial flags plus the served rules applied in
 * position order. Hidden fields keep any answer they hold — the server owns
 * what a submission may contain — but they never gate a submit.
 */
export function publicApplicationFieldStates(
	form: ServedPublicFormDto,
	answers: readonly TransientApplicationAnswerInput[]
): ReadonlyMap<string, PublicApplicationFieldState> {
	const answersByField = new Map(answers.map((answer) => [answer.fieldId, answer]));
	const visible = new Set<string>();
	const required = new Set<string>();
	for (const field of form.fields) {
		if (field.initiallyVisible) visible.add(field.id);
		if (field.required) required.add(field.id);
	}
	for (const rule of form.rules) {
		if (!conditionHolds(rule.condition, answersByField)) continue;
		for (const target of rule.effect.targetFieldIds) {
			if (rule.effect.kind === 'show') visible.add(target);
			else if (rule.effect.kind === 'hide') visible.delete(target);
			else required.add(target);
		}
	}
	return new Map(
		form.fields.map((field) => [
			field.id,
			{ visible: visible.has(field.id), required: required.has(field.id) }
		])
	);
}

// ---------------------------------------------------------------------------
// Control value → contract-shaped answer

/** What a control holds: text-like values, a multiselect's choice ids, or a checkbox. */
export type PublicApplicationControlValue = string | readonly string[] | boolean;

export type PublicApplicationFieldInput =
	| { readonly kind: 'answer'; readonly answer: TransientApplicationAnswerInput }
	| { readonly kind: 'empty' }
	| { readonly kind: 'invalid'; readonly message: string };

const KIND_INVALID_MESSAGES: Record<ServedPublicFormFieldDto['kind'], string> = {
	text: 'This text can’t be saved as typed.',
	textarea: 'This text can’t be saved as typed.',
	email: 'Enter an email address like name@example.com.',
	url: 'Enter a full web address, starting with http:// or https://.',
	phone: 'Enter a phone number.',
	number: 'Enter a number.',
	date: 'Enter a date.',
	datetime: 'Enter a date and time.',
	select: 'Choose one of the listed options.',
	multiselect: 'Choose from the listed options.',
	checkbox: 'This can only be checked or unchecked.'
};

function normalizedText(value: string, multiline: boolean): string {
	const normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
	return multiline ? normalized : normalized.replace(/\n/gu, '');
}

function accepted(candidate: TransientApplicationAnswerInput, fallback: string): PublicApplicationFieldInput {
	const parsed = transientApplicationAnswerInputSchema.safeParse(candidate);
	if (!parsed.success) return { kind: 'invalid', message: fallback };
	return { kind: 'answer', answer: parsed.data };
}

/**
 * One control's current value as the answer the ceremony may hold: an
 * acceptable answer, an honest emptiness, or a refusal with the reviewed
 * sentence for this field kind. The contract schema has the final word, so
 * an accepted answer is already normalized exactly as the server stores it.
 */
export function publicApplicationFieldInput(
	field: ServedPublicFormFieldDto,
	value: PublicApplicationControlValue
): PublicApplicationFieldInput {
	const invalid = (message?: string): PublicApplicationFieldInput => ({
		kind: 'invalid',
		message: message ?? KIND_INVALID_MESSAGES[field.kind]
	});
	switch (field.kind) {
		case 'text':
		case 'textarea': {
			if (typeof value !== 'string') return invalid();
			const normalized = normalizedText(value, field.kind === 'textarea');
			if (normalized.length === 0) return { kind: 'empty' };
			if (normalized.length > field.maximumLength) {
				return invalid(`Keep this to ${field.maximumLength.toLocaleString('en-US')} characters.`);
			}
			return accepted({ kind: field.kind, fieldId: field.id, value }, KIND_INVALID_MESSAGES[field.kind]);
		}
		case 'email':
		case 'url':
		case 'phone': {
			if (typeof value !== 'string') return invalid();
			if (normalizedText(value, false).length === 0) return { kind: 'empty' };
			return accepted({ kind: field.kind, fieldId: field.id, value }, KIND_INVALID_MESSAGES[field.kind]);
		}
		case 'number': {
			if (typeof value !== 'string') return invalid();
			const trimmed = value.trim();
			if (trimmed.length === 0) return { kind: 'empty' };
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed)) return invalid();
			if (field.integerOnly && !Number.isInteger(parsed)) return invalid('Enter a whole number.');
			if (field.minimum !== null && parsed < field.minimum) {
				return invalid(`Enter a number of at least ${field.minimum}.`);
			}
			if (field.maximum !== null && parsed > field.maximum) {
				return invalid(`Enter a number of at most ${field.maximum}.`);
			}
			const number = parsed === 0 ? 0 : parsed;
			return accepted({ kind: 'number', fieldId: field.id, value: number }, KIND_INVALID_MESSAGES.number);
		}
		case 'date': {
			if (typeof value !== 'string') return invalid();
			if (value.trim().length === 0) return { kind: 'empty' };
			return accepted({ kind: 'date', fieldId: field.id, value: value.trim() }, KIND_INVALID_MESSAGES.date);
		}
		case 'datetime': {
			if (typeof value !== 'string') return invalid();
			if (value.trim().length === 0) return { kind: 'empty' };
			const instant = new Date(value);
			if (Number.isNaN(instant.getTime())) return invalid();
			return accepted(
				{ kind: 'datetime', fieldId: field.id, value: instant.toISOString() },
				KIND_INVALID_MESSAGES.datetime
			);
		}
		case 'select': {
			if (typeof value !== 'string') return invalid();
			if (value.length === 0) return { kind: 'empty' };
			if (!field.options.some((option) => option.id === value)) return invalid();
			return accepted({ kind: 'select', fieldId: field.id, choiceId: value }, KIND_INVALID_MESSAGES.select);
		}
		case 'multiselect': {
			if (typeof value === 'string' || typeof value === 'boolean') return invalid();
			const choiceIds = [...new Set(value)];
			if (choiceIds.length === 0) return { kind: 'empty' };
			if (choiceIds.some((choiceId) => !field.options.some((option) => option.id === choiceId))) {
				return invalid();
			}
			if (choiceIds.length > field.maximumSelections) {
				return invalid(`Choose up to ${field.maximumSelections}.`);
			}
			return accepted(
				{ kind: 'multiselect', fieldId: field.id, choiceIds },
				KIND_INVALID_MESSAGES.multiselect
			);
		}
		case 'checkbox': {
			if (typeof value !== 'boolean') return invalid();
			return accepted({ kind: 'checkbox', fieldId: field.id, checked: value }, KIND_INVALID_MESSAGES.checkbox);
		}
	}
}

/** A held answer, as the value its field's control displays. */
export function publicApplicationControlValue(
	field: ServedPublicFormFieldDto,
	answer: TransientApplicationAnswerInput | undefined
): PublicApplicationControlValue {
	switch (field.kind) {
		case 'checkbox':
			return answer?.kind === 'checkbox' ? answer.checked : false;
		case 'multiselect':
			return answer?.kind === 'multiselect' ? answer.choiceIds : [];
		case 'select':
			return answer?.kind === 'select' ? answer.choiceId : '';
		case 'number':
			return answer?.kind === 'number' ? String(answer.value) : '';
		case 'datetime': {
			if (answer?.kind !== 'datetime') return '';
			// The stored instant, in the visitor's own clock, in the exact
			// `datetime-local` value shape.
			const at = new Date(answer.value);
			const pad = (part: number): string => String(part).padStart(2, '0');
			return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
		}
		default:
			return answer !== undefined && 'value' in answer && typeof answer.value === 'string'
				? answer.value
				: '';
	}
}

// ---------------------------------------------------------------------------
// Submit gating

export const PUBLIC_APPLICATION_REQUIRED_MESSAGE = 'This question needs an answer.';
export const PUBLIC_APPLICATION_REQUIRED_CHECKBOX_MESSAGE =
	'This needs to be checked before you submit.';

export interface PublicApplicationSubmitBlocker {
	readonly fieldId: string;
	readonly message: string;
}

/**
 * The visible, effectively-required fields the draft does not yet satisfy.
 * A required checkbox is satisfied only checked — an explicit no is an
 * answer, not an affirmation.
 */
export function publicApplicationSubmitBlockers(
	form: ServedPublicFormDto,
	answers: readonly TransientApplicationAnswerInput[]
): PublicApplicationSubmitBlocker[] {
	const states = publicApplicationFieldStates(form, answers);
	const answersByField = new Map(answers.map((answer) => [answer.fieldId, answer]));
	const blockers: PublicApplicationSubmitBlocker[] = [];
	for (const field of form.fields) {
		const state = states.get(field.id);
		if (!state?.visible || !state.required) continue;
		const answer = answersByField.get(field.id);
		const satisfied =
			field.kind === 'checkbox'
				? answer?.kind === 'checkbox' && answer.checked
				: field.kind === 'multiselect'
					? answer?.kind === 'multiselect' && answer.choiceIds.length > 0
					: answer !== undefined;
		if (!satisfied) {
			blockers.push({
				fieldId: field.id,
				message:
					field.kind === 'checkbox'
						? PUBLIC_APPLICATION_REQUIRED_CHECKBOX_MESSAGE
						: PUBLIC_APPLICATION_REQUIRED_MESSAGE
			});
		}
	}
	return blockers;
}

// ---------------------------------------------------------------------------
// The quiet autosave line

export type PublicApplicationSaveStatusView =
	| { readonly kind: 'quiet'; readonly label: string }
	| { readonly kind: 'saving'; readonly label: string }
	| { readonly kind: 'saved'; readonly label: string }
	| { readonly kind: 'offline'; readonly label: string };

/**
 * One line, always the truth: before any edit it states that answers save as
 * you go, while unsaved work exists it says saving, a settled draft says
 * saved, and a transport failure says the work is not saved yet — never
 * "saved" on hope. Terminal phases return null; those surfaces speak for
 * themselves.
 */
export function publicApplicationSaveStatusView(
	snapshot: Pick<PublicApplicationSessionSnapshot, 'phase' | 'dirty' | 'answers' | 'transport'>
): PublicApplicationSaveStatusView | null {
	if (snapshot.phase === 'submitted' || snapshot.phase === 'stopped') return null;
	if (snapshot.phase === 'idle' || snapshot.phase === 'starting') {
		return { kind: 'quiet', label: 'Answers save as you go.' };
	}
	if (snapshot.transport !== null) {
		return { kind: 'offline', label: 'Not saved yet — check your connection.' };
	}
	if (snapshot.phase === 'saving' || snapshot.dirty) return { kind: 'saving', label: 'Saving…' };
	if (snapshot.answers.length > 0) return { kind: 'saved', label: 'Saved' };
	return { kind: 'quiet', label: 'Answers save as you go.' };
}
