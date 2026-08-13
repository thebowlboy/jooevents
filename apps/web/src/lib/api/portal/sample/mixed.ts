import type { PortalDataset } from './dataset';

const you = { participantId: 'par-noor', displayName: 'Noor Haddad' };
const coSpeaker = { participantId: 'par-ana', displayName: 'Ana Duarte' };

/**
 * Every status at once, around a co-presented talk. The shared submission is
 * the point: a co-speaker already answered the invitation on the group's
 * behalf, so the portal has to say who acted and that the others were told.
 */
const mixed: PortalDataset = {
	key: 'mixed',
	name: 'Mixed',
	description: 'Co-presented acceptance, one waitlist, one withdrawal.',

	participant: {
		id: 'par-noor',
		displayName: 'Noor Haddad',
		email: 'noor@twoplaces.dev'
	},
	event: {
		id: 'evt_aie-nyc-2026',
		name: 'AI Engineer NYC 2026',
		timezone: 'America/New_York',
		cfpClosesAt: '2026-06-30T23:59:00-04:00',
		closePolicy: 'soft'
	},

	submissions: [
		{
			id: 'sub-401',
			title: 'Running Agents in Two Places at Once',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'Two engineers, two regions, one agent fleet. What replication bought us, what it cost, and the failover we still would not automate.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A failover checklist and an honest account of the parts we keep manual.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Advanced' },
				{
					fieldId: 'fld-needs',
					label: 'Anything we should know',
					value: 'We present together; either of us can answer for the pair.'
				}
			],
			target: {
				kind: 'collecting_session',
				sessionId: 'ses-11',
				name: 'Panel: Durable Agent Infrastructure'
			},
			status: 'accepted',
			statusNotifiedAt: '2026-07-28T10:05:00-04:00',
			submittedAt: '2026-06-20T15:47:00-04:00',
			editableUntilClose: true,
			speakers: [you, coSpeaker],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-401-1',
					occurredAt: '2026-06-20T15:47:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk for Panel: Durable Agent Infrastructure.'
				},
				{
					id: 'tl-401-2',
					occurredAt: '2026-07-28T10:05:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers accepted this talk onto the panel and told you.'
				},
				{
					id: 'tl-401-3',
					occurredAt: '2026-07-28T10:06:00-04:00',
					actor: 'organizers',
					kind: 'engagement_invited',
					summary: 'Organizers invited you and Ana Duarte to the panel.'
				},
				{
					id: 'tl-401-4',
					occurredAt: '2026-07-29T08:12:00-04:00',
					actor: 'you',
					kind: 'engagement_responded',
					summary: 'Ana Duarte confirmed for both of you.'
				}
			]
		},
		{
			id: 'sub-402',
			title: 'The Cheapest Possible Eval Harness',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'What you can learn from two hundred saved traces and a spreadsheet before you buy anything.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A first-week eval setup that costs nothing and still catches regressions.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Beginner' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'waitlisted',
			statusNotifiedAt: '2026-07-28T10:05:00-04:00',
			submittedAt: '2026-07-02T09:31:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-402-1',
					occurredAt: '2026-07-02T09:31:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk after the call closed; it was accepted as late.'
				},
				{
					id: 'tl-402-2',
					occurredAt: '2026-07-28T10:05:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers put this talk on the waiting list and told you.'
				}
			]
		},
		{
			id: 'sub-403',
			title: 'Notebooks Are Not a Deployment Strategy',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value: 'A talk I pulled: the team it described reorganized and the story stopped being true.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'Withdrawn before review.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Intermediate' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'withdrawn',
			statusNotifiedAt: null,
			submittedAt: '2026-06-25T18:03:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-403-1',
					occurredAt: '2026-06-25T18:03:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk.'
				},
				{
					id: 'tl-403-2',
					occurredAt: '2026-07-06T12:22:00-04:00',
					actor: 'you',
					kind: 'withdrawn',
					summary: 'You withdrew this talk.'
				}
			]
		}
	],

	engagements: [
		{
			id: 'eng-401',
			sessionId: 'ses-11',
			sessionTitle: 'Panel: Durable Agent Infrastructure',
			submissionId: 'sub-401',
			status: 'confirmed',
			invitedAt: '2026-07-28T10:06:00-04:00',
			respondBy: '2026-08-18T23:59:00-04:00',
			confirmation: { by: 'co_speaker', at: '2026-07-29T08:12:00-04:00', displayName: 'Ana Duarte' },
			speakers: [you, coSpeaker]
		}
	],

	tasks: [
		{
			id: 'tsk-panel-brief',
			title: 'Read the panel brief',
			required: true,
			completion: { mode: 'acknowledge' },
			state: 'todo',
			dueAt: '2026-09-05T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-11'
		},
		{
			id: 'tsk-panel-bio',
			title: 'Speaker bio',
			required: true,
			completion: { mode: 'form_fill', formId: 'frm-speaker-bio' },
			state: 'complete',
			dueAt: '2026-09-05T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-11'
		}
	],

	files: [],

	resources: [
		{
			id: 'res-panel',
			title: 'Panel format and question list',
			kind: 'document',
			url: 'https://example.invalid/aie-nyc-2026/panels/durable-agent-infrastructure.pdf',
			detail: 'PDF · the moderator sends questions a week ahead.'
		}
	],

	profile: {
		fields: [
			{
				id: 'prf-name',
				label: 'Name',
				value: 'Noor Haddad',
				kind: 'text',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-email',
				label: 'Email',
				value: 'noor@twoplaces.dev',
				kind: 'email',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-session',
				label: 'Panel',
				value: 'Panel: Durable Agent Infrastructure',
				kind: 'text',
				access: { kind: 'locked', reason: 'organizer_managed', changeRequested: false }
			},
			{
				id: 'prf-headline',
				label: 'Headline',
				value: 'Reliability, Two Places',
				kind: 'text',
				access: { kind: 'editable' }
			},
			{
				id: 'prf-bio',
				label: 'Short bio',
				value:
					'Runs the fleet that runs the agents. Has strong opinions about failover drills and no opinion about which region is prettier.',
				kind: 'long_text',
				access: { kind: 'editable' }
			}
		]
	}
};

export default mixed;
