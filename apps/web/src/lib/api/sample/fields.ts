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
			/* Owner call 2026-08-12: not asked on the application — it matters at
			 * onboarding and on the profile, where badges and speaker pages need
			 * it, and the apply funnel stays lighter without it. */
			collectAt: ['onboard', 'profile'],
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
			id: 'fld-website',
			kind: 'url',
			label: 'Website',
			help: 'Your personal or company site.',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'presence',
			position: 6
		},
		{
			id: 'fld-linkedin',
			kind: 'url',
			label: 'LinkedIn',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'presence',
			position: 7
		},
		{
			id: 'fld-x',
			kind: 'url',
			label: 'X account',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'presence',
			position: 8
		},
		{
			id: 'fld-github',
			kind: 'url',
			label: 'GitHub',
			required: {},
			collectAt: ['apply', 'onboard', 'profile'],
			group: 'presence',
			position: 9
		},
		{
			id: 'fld-title',
			kind: 'text',
			label: 'Talk title',
			help: 'A working title is fine — you can refine it later.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'talk',
			position: 10
		},
		{
			id: 'fld-abstract',
			kind: 'textarea',
			label: 'Abstract',
			help: 'What you’ll cover and who it’s for, in a few sentences.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'talk',
			position: 11
		},
		{
			id: 'fld-format',
			kind: 'select',
			label: 'Format',
			help: 'Pick the closest fit — length can be adjusted together later.',
			required: { apply: true },
			collectAt: ['apply'],
			/* Options are the event's format vocabulary, served live — never a
			 * typed-in copy that drifts when Settings changes. */
			optionSource: 'formats',
			group: 'talk',
			position: 12
		},
		{
			id: 'fld-track',
			kind: 'select',
			label: 'Track',
			help: 'Your best guess is enough; the program team may move it.',
			required: { apply: true },
			collectAt: ['apply'],
			optionSource: 'tracks',
			group: 'talk',
			position: 13
		},
		{
			id: 'fld-notes',
			kind: 'textarea',
			label: 'Anything else?',
			help: 'Co-speakers, constraints, AV needs — anything the team should know.',
			required: {},
			collectAt: ['apply'],
			group: 'talk',
			position: 14
		},
		{
			id: 'fld-arrival',
			kind: 'datetime',
			label: 'Arrival date',
			help: 'When you land, so we can plan pickups and the speaker dinner.',
			required: { onboard: true },
			collectAt: ['onboard'],
			group: 'logistics',
			position: 15
		},
		{
			id: 'fld-dietary',
			kind: 'text',
			label: 'Dietary needs',
			help: 'Allergies and preferences for the speaker dinner and green room.',
			required: {},
			collectAt: ['onboard'],
			group: 'logistics',
			position: 16
		},
		{
			id: 'fld-headshot',
			kind: 'file',
			label: 'Headshot',
			help: 'A recent photo for the program page. Square works best.',
			required: { onboard: true },
			collectAt: ['onboard', 'profile'],
			group: 'materials',
			position: 17
		},
		{
			id: 'fld-consent',
			kind: 'checkbox',
			label: 'I agree to the code of conduct and to my session being recorded if accepted',
			help: 'Recordings are published after the event.',
			required: { apply: true },
			collectAt: ['apply'],
			group: 'consent',
			position: 18
		}
	];
}
