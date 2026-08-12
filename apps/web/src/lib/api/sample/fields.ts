import type { RegistryField } from '../types';

/**
 * The person-and-talk field registry every event starts with: complete enough
 * that most events never open the field editor. Apply asks the deliberately
 * lighter set; onboarding adds the heavier logistics and materials questions
 * once a speaker is confirmed. A factory so each dataset seeds its own copy
 * and scenario-local edits never bleed across scenarios.
 *
 * Positions run 0..n in ladder-group order at seed time; after that the order
 * is user-owned.
 */
export function baselineFieldRegistry(): RegistryField[] {
	return [
		{
			id: 'fld-name',
			kind: 'text',
			label: 'Your name',
			required: { apply: true, onboard: true },
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'identity',
			position: 0
		},
		{
			id: 'fld-pronouns',
			kind: 'select',
			label: 'Pronouns',
			help: 'Optional — shown on your speaker page and badge if you share them.',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			options: ['She/her', 'He/him', 'They/them', 'Prefer to self-describe', 'Prefer not to say'],
			group: 'identity',
			position: 1
		},
		{
			id: 'fld-headline',
			kind: 'text',
			label: 'Headline',
			help: 'One line about you — role and company, or however you introduce yourself.',
			required: { apply: true },
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'identity',
			position: 2
		},
		{
			id: 'fld-location',
			kind: 'text',
			label: 'Where you’re based',
			help: 'City and country are enough. It helps us plan the program and travel.',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'identity',
			position: 3
		},
		{
			id: 'fld-email',
			kind: 'email',
			label: 'Email',
			help: 'Where your decision and any reminders go. We never share it.',
			required: { apply: true, onboard: true },
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'contact',
			position: 4,
			/* The application's one structural key: answers and decisions travel by
			 * this address, so it can never leave the apply context or be deleted. */
			locked: true
		},
		{
			id: 'fld-link',
			kind: 'url',
			label: 'A link to your work',
			help: 'A past talk, a repository, or your site — anything that shows how you present.',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'presence',
			position: 5
		},
		{
			id: 'fld-title',
			kind: 'text',
			label: 'Talk title',
			help: 'A working title is fine — you can refine it later.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'talk',
			position: 6
		},
		{
			id: 'fld-abstract',
			kind: 'textarea',
			label: 'Abstract',
			help: 'What you’ll cover and who it’s for, in a few sentences.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'talk',
			position: 7
		},
		{
			id: 'fld-format',
			kind: 'select',
			label: 'Format',
			help: 'Pick the closest fit — length can be adjusted together later.',
			required: { apply: true },
			collectAt: ['apply'],
			options: ['Talk · 30 min', 'Workshop · 90 min', 'Panel · 45 min'],
			group: 'talk',
			position: 8
		},
		{
			id: 'fld-track',
			kind: 'select',
			label: 'Track',
			help: 'Your best guess is enough; the program team may move it.',
			required: { apply: true },
			collectAt: ['apply'],
			options: ['Agents & Tools', 'Evals & Reliability', 'Models & Infrastructure'],
			group: 'talk',
			position: 9
		},
		{
			id: 'fld-notes',
			kind: 'textarea',
			label: 'Anything else?',
			help: 'Co-speakers, constraints, AV needs — anything the team should know.',
			required: {},
			collectAt: ['apply'],
			group: 'talk',
			position: 10
		},
		{
			id: 'fld-arrival',
			kind: 'datetime',
			label: 'Arrival date',
			help: 'When you land, so we can plan pickups and the speaker dinner.',
			required: { onboard: true },
			collectAt: ['onboard'],
			group: 'logistics',
			position: 11
		},
		{
			id: 'fld-dietary',
			kind: 'text',
			label: 'Dietary needs',
			help: 'Allergies and preferences for the speaker dinner and green room.',
			required: {},
			collectAt: ['onboard'],
			group: 'logistics',
			position: 12
		},
		{
			id: 'fld-headshot',
			kind: 'file',
			label: 'Headshot',
			help: 'A recent photo for the program page. Square works best.',
			required: { onboard: true },
			collectAt: ['onboard', 'profile'],
			group: 'materials',
			position: 13
		},
		{
			id: 'fld-consent',
			kind: 'checkbox',
			label: 'I agree to the code of conduct and to my session being recorded if accepted',
			help: 'Recordings are published after the event.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'consent',
			position: 14
		}
	];
}
