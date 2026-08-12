/**
 * What each record offers to a search, and in which match space.
 *
 * These mappings are shared by whoever filters and whoever highlights, so the
 * rows that come back and the marks drawn on them cannot disagree about what
 * matched. The generic machinery lives in `./search`; this module only decides,
 * per entity, which text is searchable and how much a hit in it counts.
 *
 * Track and format are deliberately absent. Both already have their own filter
 * control beside the field, and a control that narrows exactly is a better
 * answer than a word that happens to appear in a name.
 */

import type { SearchableField } from './search';
import type { Submission } from './types';

/**
 * A submission's searchable text.
 *
 * Identity is separated rather than merely deprioritised. Under blind review a
 * caller passes `body` fields only, and a speaker's name then matches nothing —
 * the result set cannot disclose who wrote a submission, because the name was
 * never in the corpus the query ran against.
 */
export function submissionFields(submission: Submission): SearchableField[] {
	const fields: SearchableField[] = [
		{ text: submission.title, space: 'body', weight: 'primary' },
		{ text: submission.abstract, space: 'body', weight: 'secondary' }
	];
	for (const speaker of submission.speakers) {
		fields.push({ text: speaker.name, space: 'identity', weight: 'primary' });
		fields.push({ text: speaker.email, space: 'identity', weight: 'secondary' });
	}
	return fields;
}

/**
 * What `submissionFields` covers, in words, for a surface that has to say so.
 *
 * It lives beside the mapping rather than in the feature that renders it,
 * because the two have to change together: a field added above and not named
 * here produces a search that quietly looks somewhere it never said it would.
 */
export const SUBMISSION_SEARCH_SCOPE = 'title, abstract, and speaker';

/**
 * Where each field sits in the row that renders it, so a caller can take the
 * ranges for the title without recounting the speakers ahead of it.
 */
export const SUBMISSION_FIELD_TITLE = 0;
export const SUBMISSION_FIELD_ABSTRACT = 1;

/** The field index carrying speaker `n`'s name. */
export function submissionSpeakerNameField(index: number): number {
	return 2 + index * 2;
}
