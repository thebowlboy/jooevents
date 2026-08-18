/**
 * The kinds a hand-made message template can start from.
 *
 * A registry rather than a branch: a kind is one entry here — a label, the
 * sentence that helps someone choose it, and the scaffold it mints — so adding
 * "reminder" or "update" later is data, not surgery in the composer and the
 * store both.
 *
 * The scaffolds speak the starters' voice: a short heading, a paragraph that
 * opens by name, a second that carries the detail, one symbolic button, and the
 * divider every starter closes on. Their copy is written to be replaced — it
 * says what belongs in each place rather than pretending to be finished prose —
 * and it never mentions the editor, because unreplaced placeholder text is text
 * that can still be sent.
 */

import type { MergeFieldDef, TemplateBlock } from './types';

export interface TemplateKindDef {
	id: string;
	/** The card's title. */
	label: string;
	/** The card's one line: what you get if you pick it. */
	description: string;
	/** Prose for the template's own `purpose`, in the starters' register. */
	purpose: string;
	subject: string;
	blocks: TemplateBlock[];
	mergeFields: MergeFieldDef[];
}

/**
 * The tokens a hand-made template may use: the event and the person, the four
 * the starters share. Submission and task tokens are deliberately absent — they
 * belong to the flows that own those records, and a token with nothing behind
 * it renders as its own braces.
 */
function standardMergeFields(): MergeFieldDef[] {
	return [
		{ key: 'speaker.name', label: 'Speaker name', sample: 'Maya Lindqvist' },
		{ key: 'event.name', label: 'Event name', sample: 'AI Engineer NYC 2026' },
		{ key: 'event.dates', label: 'Event dates', sample: 'Oct 12–14, 2026' },
		{ key: 'event.location', label: 'Event location', sample: 'New York City' }
	];
}

export const templateKinds: TemplateKindDef[] = [
	{
		id: 'announcement',
		label: 'Announcement',
		description:
			'A clean content email in your event’s look — headline, message, optional button.',
		purpose: 'Announcements and general updates.',
		subject: 'News from {{event.name}}',
		blocks: [
			{ type: 'heading', text: 'Your headline goes here', suggestedVars: ['event.name'] },
			{
				type: 'paragraph',
				text: '{{speaker.name}}, open with the one thing that changed and why it matters to them. Two sentences is usually enough — the detail can follow underneath.',
				suggestedVars: ['speaker.name', 'event.name']
			},
			{
				type: 'paragraph',
				text: 'Put the detail here: dates, what to do next, anything they need before the day. Delete this paragraph if the headline already said it.',
				suggestedVars: ['event.dates', 'event.location']
			},
			{ type: 'button', label: 'Read more', href: 'event.schedule' },
			{ type: 'divider' }
		],
		mergeFields: standardMergeFields()
	},
	{
		id: 'blank',
		label: 'Blank',
		description: 'A bare start — a headline and one paragraph to replace, and nothing else.',
		purpose: 'A one-off message written from scratch.',
		subject: '',
		/**
		 * Not empty. A message with no blocks has no body, and a composition that
		 * can only offer a subject is a dead end — there is nothing to edit and
		 * nothing for a send ceremony to show. The bare start is still a
		 * document: the least one that can be written into.
		 *
		 * The composer's own blank start seeds an anonymous one-off from exactly
		 * this scaffold, so the shortest path to a message and the shortest
		 * library template begin as the same thing.
		 */
		blocks: [
			{ type: 'heading', text: 'Your headline goes here', suggestedVars: ['event.name'] },
			{
				type: 'paragraph',
				text: 'Write the message here. Say the one thing that changed and what it means for them.',
				suggestedVars: ['speaker.name', 'event.name']
			}
		],
		mergeFields: standardMergeFields()
	}
];

/** The kind by id, or undefined — a caller decides what an unknown kind means. */
export function templateKind(id: string): TemplateKindDef | undefined {
	return templateKinds.find((kind) => kind.id === id);
}
