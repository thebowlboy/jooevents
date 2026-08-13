import type { PortalDataset } from './dataset';

const you = { participantId: 'par-idris', displayName: 'Idris Bello' };

/**
 * Three declines, one of which has already been appealed. The scenario exists
 * to exercise the appeal path honestly: available on one, spent on another,
 * and — once the per-person ceiling is reached — refused on the third.
 */
const declined: PortalDataset = {
	key: 'declined',
	name: 'Declined',
	description: 'Three declines, one appeal already spent, ceiling reachable.',

	participant: {
		id: 'par-idris',
		displayName: 'Idris Bello',
		email: 'idris@latencylab.dev'
	},
	event: {
		id: 'evt_aie-nyc-2026',
		name: 'AI Engineer NYC 2026',
		timezone: 'America/New_York',
		cfpClosesAt: '2026-06-30T23:59:00-04:00',
		closePolicy: 'hard'
	},

	submissions: [
		{
			id: 'sub-301',
			title: 'Cutting Agent Latency by Deleting Features',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'We halved p95 by removing three capabilities nobody used. The talk is about how we found them and how we got permission to delete them.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A method for proving a feature is dead, and the argument that worked internally.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Intermediate' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'declined',
			statusNotifiedAt: '2026-07-30T09:15:00-04:00',
			submittedAt: '2026-06-11T13:02:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'available' },
			timeline: [
				{
					id: 'tl-301-1',
					occurredAt: '2026-06-11T13:02:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk.'
				},
				{
					id: 'tl-301-2',
					occurredAt: '2026-07-30T09:15:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers declined this talk and told you.'
				}
			]
		},
		{
			id: 'sub-302',
			title: 'The Queue Is the Product',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'Every reliability story we shipped last year turned out to be a queueing story. A tour of four incidents and the one diagram that explained all of them.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A shared vocabulary for arguing about backpressure with your own team.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Beginner' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'declined',
			statusNotifiedAt: '2026-07-30T09:15:00-04:00',
			submittedAt: '2026-06-14T20:35:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: {
				kind: 'submitted',
				submittedAt: '2026-08-01T11:40:00-04:00',
				reason:
					'The talk was read as an intro session. It is a post-mortem of four production incidents; the beginner marker on the form was about the audience, not the material.'
			},
			timeline: [
				{
					id: 'tl-302-1',
					occurredAt: '2026-06-14T20:35:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk.'
				},
				{
					id: 'tl-302-2',
					occurredAt: '2026-07-30T09:15:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers declined this talk and told you.'
				},
				{
					id: 'tl-302-3',
					occurredAt: '2026-08-01T11:40:00-04:00',
					actor: 'you',
					kind: 'appeal_submitted',
					summary: 'You asked the organizers to look at this decision again.'
				}
			]
		},
		{
			id: 'sub-303',
			title: 'Retries Considered Harmful',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'A short, opinionated case that most retry policies are a way of not fixing the thing, with three replacements that worked.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'Three concrete alternatives to a blanket retry, and when each one fails.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Advanced' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: {
				kind: 'collecting_session',
				sessionId: 'ses-12',
				name: 'Lightning Talks: Eval Fails in Production'
			},
			status: 'declined',
			statusNotifiedAt: '2026-07-30T09:15:00-04:00',
			submittedAt: '2026-06-28T23:14:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'available' },
			timeline: [
				{
					id: 'tl-303-1',
					occurredAt: '2026-06-28T23:14:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk for Lightning Talks: Eval Fails in Production.'
				},
				{
					id: 'tl-303-2',
					occurredAt: '2026-07-30T09:15:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers declined this talk and told you.'
				}
			]
		}
	],

	engagements: [],
	tasks: [],
	files: [],
	resources: [
		{
			id: 'res-nextyear',
			title: 'How the program was chosen',
			kind: 'link',
			url: 'https://example.invalid/aie-nyc-2026/selection-notes',
			detail: 'What the reviewers were asked to weigh, published after decisions.'
		}
	],

	profile: {
		fields: [
			{
				id: 'prf-name',
				label: 'Name',
				value: 'Idris Bello',
				kind: 'text',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-email',
				label: 'Email',
				value: 'idris@latencylab.dev',
				kind: 'email',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-headline',
				label: 'Headline',
				value: 'Latency Lab',
				kind: 'text',
				access: { kind: 'editable' }
			},
			{
				id: 'prf-bio',
				label: 'Short bio',
				value:
					'Spends his working life on the difference between p50 and p99, and his weekends pretending not to.',
				kind: 'long_text',
				access: { kind: 'editable' }
			}
		]
	}
};

export default declined;
