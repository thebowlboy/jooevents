import type { PortalDataset } from './dataset';

const you = { participantId: 'par-amara', displayName: 'Amara Okafor' };

/**
 * Baseline scenario: the CFP is still open and nothing has been decided. The
 * portal's whole job here is to say what was received and until when it can
 * still be corrected.
 */
const submitted: PortalDataset = {
	key: 'submitted',
	name: 'Waiting',
	description: 'CFP open, two submissions in, nothing decided yet.',

	participant: {
		id: 'par-amara',
		displayName: 'Amara Okafor',
		email: 'amara@contractual.io'
	},
	event: {
		id: 'evt_aie-nyc-2026',
		name: 'AI Engineer NYC 2026',
		timezone: 'America/New_York',
		cfpClosesAt: '2026-08-22T23:59:00-04:00',
		closePolicy: 'hard'
	},

	submissions: [
		{
			id: 'sub-201',
			title: 'Typed Tool Contracts Between Agents That Never Meet',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'How we made tool-calling agents coordinate through schema-first contracts, what broke, and the failure that forced us back to single-writer discipline.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value:
						'A migration order that survives partial rollout, and the three contract mistakes we had to undo in production.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Intermediate' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'submitted',
			statusNotifiedAt: null,
			submittedAt: '2026-07-08T09:20:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-201-1',
					occurredAt: '2026-07-08T09:20:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk.'
				},
				{
					id: 'tl-201-2',
					occurredAt: '2026-07-09T14:05:00-04:00',
					actor: 'you',
					kind: 'edited',
					summary: 'You corrected a typo in the abstract.'
				}
			]
		},
		{
			id: 'sub-202',
			title: 'What We Broke Migrating to Schema-First Tools',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'A short, specific post-mortem: the four incidents that came out of moving a tool surface to generated schemas, and what we would do differently.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A checklist for staging a schema migration behind a live agent surface.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Advanced' },
				{
					fieldId: 'fld-needs',
					label: 'Anything we should know',
					value: 'Happy to be scheduled opposite anything — this is a small-room talk.'
				}
			],
			target: {
				kind: 'collecting_session',
				sessionId: 'ses-11',
				name: 'Panel: Durable Agent Infrastructure'
			},
			status: 'in_review',
			statusNotifiedAt: '2026-07-21T10:00:00-04:00',
			submittedAt: '2026-07-19T22:41:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-202-1',
					occurredAt: '2026-07-19T22:41:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk for Panel: Durable Agent Infrastructure.'
				},
				{
					id: 'tl-202-2',
					occurredAt: '2026-07-21T10:00:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers told you this talk is being read.'
				}
			]
		}
	],

	engagements: [],
	tasks: [],
	files: [],
	resources: [
		{
			id: 'res-cfp',
			title: 'What we look for in a proposal',
			kind: 'link',
			url: 'https://example.invalid/aie-nyc-2026/cfp-guide',
			detail: 'Three pages, written by the program chairs.'
		}
	],

	profile: {
		fields: [
			{
				id: 'prf-name',
				label: 'Name',
				value: 'Amara Okafor',
				kind: 'text',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-email',
				label: 'Email',
				value: 'amara@contractual.io',
				kind: 'email',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-headline',
				label: 'Headline',
				value: 'Platform lead, Contractual',
				kind: 'text',
				access: { kind: 'editable' }
			},
			{
				id: 'prf-bio',
				label: 'Short bio',
				value:
					'Builds the tool layer several teams share. Spends most of her time on the boring half: versioning, deprecation, and telling people no.',
				kind: 'long_text',
				access: { kind: 'editable' }
			},
			{
				id: 'prf-site',
				label: 'Website',
				value: 'https://contractual.io/amara',
				kind: 'url',
				access: { kind: 'editable' }
			}
		]
	}
};

export default submitted;
