import type { MessageTemplate, RecipientRow } from '$lib/api/types';

/**
 * One recipient's exact artifact: their name resolves `speaker.name`, their own
 * resolved values override the declared samples, and an edited subject line
 * rides on top so a change above is reflected below.
 *
 * This is the load-bearing part of a send ceremony — what makes the preview
 * *this person's* copy rather than the template's sample copy. A template's
 * declared samples belong to whoever the template was written about, so
 * rendering them beside somebody else's name would show a confident lie.
 */
export function recipientTemplate(
	template: MessageTemplate,
	recipient: Pick<RecipientRow, 'name' | 'mergeValues'>,
	subjectOverride?: string
): MessageTemplate {
	const values: Record<string, string> = {
		'speaker.name': recipient.name,
		...(recipient.mergeValues ?? {})
	};
	return {
		...template,
		subject:
			subjectOverride === undefined || subjectOverride.trim() === ''
				? template.subject
				: subjectOverride,
		mergeFields: template.mergeFields.map((field) => ({
			...field,
			sample: values[field.key] ?? field.sample
		}))
	};
}
