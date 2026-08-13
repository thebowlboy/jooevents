import type {
	OrganizerSubmissionAnswerDto,
	OrganizerSubmissionContactDto,
	OrganizerSubmissionDetailDto,
	OrganizerSubmissionSummaryDto
} from '@jooevents/contracts';
import type {
	OrganizerSubmissionAnswerView,
	OrganizerSubmissionChoiceView,
	OrganizerSubmissionContactView,
	OrganizerSubmissionDetailView,
	OrganizerSubmissionSummaryView,
	OrganizerSubmissionTargetView
} from '../view-models/intake-submissions';

type HandledSummaryKey =
	| 'schemaVersion'
	| 'id'
	| 'formId'
	| 'formVersionId'
	| 'target'
	| 'title'
	| 'primaryParticipantName'
	| 'submittedAt';
const unhandledSummaryKeys: Record<
	Exclude<keyof OrganizerSubmissionSummaryDto, HandledSummaryKey>,
	never
> = {};
void unhandledSummaryKeys;

type HandledDetailKey =
	| 'schemaVersion'
	| 'submissionId'
	| 'formId'
	| 'formVersionId'
	| 'submittedAt'
	| 'participantCount'
	| 'answers'
	| 'affirmedConsentFieldIds';
const unhandledDetailKeys: Record<
	Exclude<keyof OrganizerSubmissionDetailDto, HandledDetailKey>,
	never
> = {};
void unhandledDetailKeys;

type HandledContactKey =
	| 'schemaVersion'
	| 'submissionId'
	| 'personId'
	| 'participantIdentityId'
	| 'sourceFieldId'
	| 'email';
const unhandledContactKeys: Record<
	Exclude<keyof OrganizerSubmissionContactDto, HandledContactKey>,
	never
> = {};
void unhandledContactKeys;

const monthNames = Object.freeze([
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const);

function submittedAtLabel(instant: string): string {
	const date = new Date(instant);
	const month = monthNames[date.getUTCMonth()];
	const hour = String(date.getUTCHours()).padStart(2, '0');
	const minute = String(date.getUTCMinutes()).padStart(2, '0');
	return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()} · ${hour}:${minute} UTC`;
}

function unreachable(value: never): never {
	throw new TypeError(`Unsupported organizer submission contract variant: ${JSON.stringify(value)}`);
}

function mapTarget(target: OrganizerSubmissionSummaryDto['target']): OrganizerSubmissionTargetView {
	switch (target.kind) {
		case 'general_pool':
			return Object.freeze({ kind: 'general_pool', label: 'General pool' });
		case 'category':
			return Object.freeze({
				kind: 'category',
				categoryKind: target.category.kind,
				categoryId: target.category.id,
				label: target.category.kind === 'track' ? 'Track target' : 'Format target'
			});
		case 'session':
			return Object.freeze({
				kind: 'session',
				sessionId: target.sessionId,
				label: 'Session target'
			});
		default:
			return unreachable(target);
	}
}

function mapChoice(choice: { readonly id: string; readonly label: string }): OrganizerSubmissionChoiceView {
	return Object.freeze({ id: choice.id, label: choice.label });
}

function mapAnswer(answer: OrganizerSubmissionAnswerDto): OrganizerSubmissionAnswerView {
	switch (answer.kind) {
		case 'text':
		case 'textarea':
		case 'url':
		case 'phone':
		case 'date':
		case 'datetime':
			return Object.freeze({
				type: answer.kind,
				fieldId: answer.fieldId,
				fieldLabel: answer.fieldLabel,
				value: answer.value
			});
		case 'number':
			return Object.freeze({
				type: 'number' as const,
				fieldId: answer.fieldId,
				fieldLabel: answer.fieldLabel,
				value: answer.value
			});
		case 'select':
			return Object.freeze({
				type: 'select',
				fieldId: answer.fieldId,
				fieldLabel: answer.fieldLabel,
				choice: mapChoice(answer.choice)
			});
		case 'multiselect':
			return Object.freeze({
				type: 'multiselect',
				fieldId: answer.fieldId,
				fieldLabel: answer.fieldLabel,
				choices: Object.freeze(answer.choices.map(mapChoice))
			});
		case 'checkbox':
			return Object.freeze({
				type: 'checkbox',
				fieldId: answer.fieldId,
				fieldLabel: answer.fieldLabel,
				checked: answer.checked
			});
		default:
			return unreachable(answer);
	}
}

export function mapOrganizerSubmissionSummary(
	summary: OrganizerSubmissionSummaryDto
): OrganizerSubmissionSummaryView {
	return Object.freeze({
		id: summary.id,
		formId: summary.formId,
		formVersionId: summary.formVersionId,
		target: mapTarget(summary.target),
		title: summary.title ?? 'Untitled submission',
		primaryParticipantName: summary.primaryParticipantName,
		submittedAt: summary.submittedAt,
		submittedAtLabel: submittedAtLabel(summary.submittedAt)
	});
}

export function mapOrganizerSubmissionDetail(
	detail: OrganizerSubmissionDetailDto
): OrganizerSubmissionDetailView {
	return Object.freeze({
		submissionId: detail.submissionId,
		formId: detail.formId,
		formVersionId: detail.formVersionId,
		submittedAt: detail.submittedAt,
		submittedAtLabel: submittedAtLabel(detail.submittedAt),
		participantCount: detail.participantCount,
		answers: Object.freeze(detail.answers.map(mapAnswer)),
		affirmedConsentFieldIds: Object.freeze([...detail.affirmedConsentFieldIds])
	});
}

export function mapOrganizerSubmissionContact(
	contact: OrganizerSubmissionContactDto
): OrganizerSubmissionContactView {
	return Object.freeze({ submissionId: contact.submissionId, email: contact.email });
}
