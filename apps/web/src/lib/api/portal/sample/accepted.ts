import type { PortalDataset } from './dataset';

const you = { participantId: 'par-maya', displayName: 'Maya Lindqvist' };

/**
 * After acceptance: one invitation still waiting for an answer, and the
 * checklist that follows it — including an upload the organizers have received
 * but not yet checked, and one deadline that has already passed.
 */
const accepted: PortalDataset = {
	key: 'accepted',
	name: 'Accepted',
	description: 'Talk accepted, invitation unanswered, checklist running.',

	participant: {
		id: 'par-maya',
		displayName: 'Maya Lindqvist',
		email: 'maya@nordicweb.dev'
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
			id: 'sub-101',
			title: 'Context Caching Without Tears',
			formVersion: 3,
			answers: [
				{
					fieldId: 'fld-abstract',
					label: 'Abstract',
					value:
						'A field guide to prompt and prefix caching: production hit-rate traces, the invalidation mistakes that cost us, and the harness we use to test changes.'
				},
				{
					fieldId: 'fld-takeaways',
					label: 'What the audience will take away',
					value: 'A test harness shape you can copy, and the two invalidation bugs everyone hits.'
				},
				{ fieldId: 'fld-level', label: 'Audience level', value: 'Intermediate' },
				{ fieldId: 'fld-needs', label: 'Anything we should know', value: '' }
			],
			target: { kind: 'new_session' },
			status: 'accepted',
			statusNotifiedAt: '2026-07-27T16:30:00-04:00',
			submittedAt: '2026-06-02T11:12:00-04:00',
			editableUntilClose: true,
			speakers: [you],
			speakerAuthority: 'any_participant_acts',
			appeal: { kind: 'unavailable' },
			timeline: [
				{
					id: 'tl-101-1',
					occurredAt: '2026-06-02T11:12:00-04:00',
					actor: 'you',
					kind: 'submitted',
					summary: 'You submitted this talk.'
				},
				{
					id: 'tl-101-2',
					occurredAt: '2026-07-27T16:30:00-04:00',
					actor: 'organizers',
					kind: 'status_communicated',
					summary: 'Organizers accepted this talk and told you.'
				},
				{
					id: 'tl-101-3',
					occurredAt: '2026-07-27T16:31:00-04:00',
					actor: 'organizers',
					kind: 'engagement_invited',
					summary: 'Organizers invited you to speak at Context Caching Without Tears.'
				}
			]
		}
	],

	engagements: [
		{
			id: 'eng-101',
			sessionId: 'ses-2',
			sessionTitle: 'Context Caching Without Tears',
			submissionId: 'sub-101',
			status: 'invited',
			invitedAt: '2026-07-27T16:31:00-04:00',
			respondBy: '2026-08-20T23:59:00-04:00',
			confirmation: null,
			speakers: [you]
		}
	],

	tasks: [
		{
			id: 'tsk-bio',
			title: 'Speaker bio',
			required: true,
			completion: { mode: 'form_fill', formId: 'frm-speaker-bio' },
			state: 'complete',
			dueAt: '2026-09-11T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-2'
		},
		{
			id: 'tsk-headshot',
			title: 'Headshot upload',
			required: true,
			completion: {
				mode: 'upload',
				acceptedTypes: ['image/jpeg', 'image/png'],
				receivedFileId: 'fil-headshot-2'
			},
			state: 'received_pending_check',
			dueAt: '2026-09-11T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-2'
		},
		{
			id: 'tsk-av',
			title: 'AV requirements',
			required: true,
			completion: { mode: 'form_fill', formId: 'frm-av' },
			state: 'todo',
			dueAt: '2026-08-08T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-2'
		},
		{
			id: 'tsk-travel',
			title: 'Confirm your travel details',
			required: true,
			completion: { mode: 'acknowledge' },
			state: 'todo',
			dueAt: '2026-09-18T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-2'
		},
		{
			id: 'tsk-hotel',
			title: 'Book your speaker hotel room',
			required: false,
			completion: { mode: 'external', url: 'https://example.invalid/aie-nyc-2026/hotel' },
			state: 'todo',
			dueAt: '2026-09-01T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'soft',
			sessionId: 'ses-2'
		},
		{
			id: 'tsk-slides',
			title: 'Slides draft',
			required: false,
			completion: { mode: 'upload', acceptedTypes: ['application/pdf'], receivedFileId: null },
			state: 'todo',
			dueAt: '2026-10-01T23:59:00-04:00',
			timezone: 'America/New_York',
			closePolicy: 'hard',
			sessionId: 'ses-2'
		}
	],

	files: [
		{
			id: 'fil-headshot-1',
			name: 'maya-lindqvist-headshot.jpg',
			sizeBytes: 1_840_233,
			version: 1,
			uploadedAt: '2026-08-01T08:44:00-04:00',
			taskId: 'tsk-headshot'
		},
		{
			id: 'fil-headshot-2',
			name: 'maya-lindqvist-headshot.jpg',
			sizeBytes: 2_210_910,
			version: 2,
			uploadedAt: '2026-08-06T19:02:00-04:00',
			taskId: 'tsk-headshot'
		}
	],

	resources: [
		{
			id: 'res-handbook',
			title: 'Speaker handbook',
			kind: 'document',
			url: 'https://example.invalid/aie-nyc-2026/speaker-handbook.pdf',
			detail: 'PDF · everything from load-in to recording rights.'
		},
		{
			id: 'res-stage',
			title: 'Main Stage AV setup',
			kind: 'link',
			url: 'https://example.invalid/aie-nyc-2026/av/main-stage',
			detail: 'Connectors, resolutions, and what the confidence monitor shows.'
		}
	],

	profile: {
		fields: [
			{
				id: 'prf-name',
				label: 'Name',
				value: 'Maya Lindqvist',
				kind: 'text',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-email',
				label: 'Email',
				value: 'maya@nordicweb.dev',
				kind: 'email',
				access: { kind: 'locked', reason: 'verified_identity', changeRequested: false }
			},
			{
				id: 'prf-title',
				label: 'Talk title',
				value: 'Context Caching Without Tears',
				kind: 'text',
				access: { kind: 'locked', reason: 'locked_after_acceptance', changeRequested: false }
			},
			{
				id: 'prf-headline',
				label: 'Headline',
				value: 'Infrastructure, Nordic Web',
				kind: 'text',
				access: { kind: 'editable' }
			},
			{
				id: 'prf-bio',
				label: 'Short bio',
				value:
					'Works on caching and the parts of inference nobody volunteers for. Lives in Malmö, tests in production only on purpose.',
				kind: 'long_text',
				access: { kind: 'editable' }
			}
		]
	}
};

export default accepted;
