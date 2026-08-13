import type { WorkspaceDataset } from './dataset';
import { closesInDays, daysAgo, hoursAgo } from './dataset';
import { defaultEventTheme, starterSurfaceTemplates, starterTemplates } from './templates';
import { baselineFieldRegistry } from './fields';

/**
 * Early scenario: the CFP opened three days ago. Small honest numbers, no
 * review plan, nothing decided, and one keynote invited by hand.
 */
const opening: WorkspaceDataset = {
	key: 'opening',
	name: 'Just opened',
	description: 'Day 3 of the CFP. Nine submissions, no review plan, nothing decided yet.',

	summary: {
		event: {
			id: 'evt_aie-london-2027',
			name: 'AI Engineer London 2027',
			dates: 'Mar 3–4, 2027',
			location: 'London',
			timezone: 'Europe/London',
			phase: 'CFP open · day 3 of 28',
			today: 'Monday, August 10'
		},
		lockedAreas: [],
		navCounts: {
			submissions: '9',
			speakers: '2',
			reviewers: '2',
			messages: '1'
		},
		stats: [
			{ label: 'Submissions', value: '9', sub: 'First 3 days of the CFP' },
			{ label: 'Review round', value: 'Not open', sub: 'One reviewer ready · no deadline yet', tone: 'attention' },
			{ label: 'Speakers', value: '2', sub: 'Both invitations outstanding' },
			{ label: 'CFP closes', value: '25 days', sub: 'Sep 4, 23:59 GMT' }
		],
		attention: [
			{
				id: 'no-review-plan',
				severity: 'soon',
				area: 'review',
				title: 'No review round yet',
				detail: 'Submissions are arriving with nowhere to score them. Opening the round hands each one to the reviewers whose scope covers it.',
				action: 'Open the review round'
			},
			{
				id: 'callbacks-unverified',
				severity: 'fyi',
				area: 'messages',
				title: 'Email delivery callbacks not verified',
				detail: 'Mail still sends, but delivery and bounce counts stay blank until the callback URL is verified.',
				action: 'Open email setup'
			}
		],
		pipeline: [
			/* Day 3: volume with no denominator and no plan anywhere means no
			   meters in this scenario. Collect still answers to the CFP clock. */
			{
				key: 'collect',
				label: 'Collect',
				headline: '9',
				sub: 'CFP open · closes in 25 days',
				state: 'ok',
				paceTone: 'on',
				deadlineLabel: 'closes in 25 days',
				deadlineIso: '2026-09-04T23:59:00-04:00'
			},
			{ key: 'triage', label: 'Triage', headline: '9', sub: 'inbox · nothing set aside yet', state: 'ok' },
			/* No review plan: absence of measurement is not 0%, so neither a
			   meter nor a pace claim exists here. */
			{ key: 'review', label: 'Review', headline: '—', sub: 'round not open yet', state: 'attention' },
			{ key: 'decide', label: 'Decide', headline: '0', sub: 'decisions start after review', state: 'ok' },
			{ key: 'speakers', label: 'Speakers', headline: '2', sub: 'invited · no replies yet', state: 'ok' },
			{ key: 'schedule', label: 'Schedule', headline: '0/1', sub: 'placed · keynote is the only session', state: 'ok' },
			{ key: 'comms', label: 'Comms', headline: '1', sub: 'sent · delivery reporting unverified', state: 'ok' }
		],
		deadlines: [
			{ label: 'CFP closes', absolute: 'Sep 4, 23:59 GMT', relative: 'in 25 days', tone: 'ok' },
			{ label: 'Doors open', absolute: 'Mar 3, 08:30 GMT', relative: 'in 205 days', tone: 'ok' }
		],
		activity: [
			{
				id: 'act-1',
				actor: 'person',
				name: 'Elif Aydın',
				text: 'submitted “Designing Agent Interfaces People Can Actually Trust”',
				time: '35 min ago'
			},
			{
				id: 'act-2',
				actor: 'agent',
				name: 'Screen run #1',
				text: 'checked 9 submissions for spam and off-topic pitches — nothing set aside',
				time: '2 h ago'
			},
			{ id: 'act-3', actor: 'you', name: 'You', text: 'invited Ravi Chandran to open the summit', time: 'yesterday' },
			{
				id: 'act-4',
				actor: 'you',
				name: 'You',
				text: 'sent the CFP announcement to 412 past speakers and subscribers',
				time: '3 days ago'
			},
			{ id: 'act-5', actor: 'you', name: 'You', text: 'opened the call for proposals', time: '3 days ago' }
		],
		trays: [
			{ kind: 'late', label: 'Late submissions', count: 0, href: '/app/submissions?tray=late' },
			{ kind: 'discarded', label: 'Discarded, recoverable', count: 0, href: '/app/submissions?tray=discarded' },
			{ kind: 'unresolved-import', label: 'Unresolved import items', count: 0 },
			{ kind: 'bounced', label: 'Bounced recipients', count: 0, href: '/app/messages' }
		]
	},

	tracks: [
		{ id: 'trk-web', name: 'Agents & Tools', accent: 'sea' },
		{ id: 'trk-ai', name: 'Evals & Reliability', accent: 'lavender' },
		{ id: 'trk-infra', name: 'Models & Infrastructure', accent: 'neutral' }
	],
	formats: [
		{ id: 'fmt-talk', name: 'Talk', defaultDurationMin: 30 },
		{ id: 'fmt-workshop', name: 'Workshop', defaultDurationMin: 90 },
		{ id: 'fmt-panel', name: 'Panel', defaultDurationMin: 45 }
	],

	submissions: [
		{
			id: 'sub-201',
			title: 'Serving 100k-Token Contexts Without Melting the App',
			abstract:
				'What we measured when an agent loaded a 100,000-token working context, the latency cliffs we found, and the three rendering changes that survived production.',
			speakers: [{ name: 'Ines Moreau', email: 'ines@gridworks.fr' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: daysAgo(3),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-202',
			title: 'What Our Agent Incident Reviews Kept Getting Wrong',
			abstract:
				'Two years of agent postmortems, re-read in one sitting: the recurring autonomy failures, the trace fields we added, and what got measurably better afterwards.',
			speakers: [{ name: 'Oskar Lind', email: 'oskar@steadystate.se' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(68),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-203',
			title: 'Prompt Contracts: Versioning What You Ask the Model',
			abstract:
				'Treating prompts as a versioned interface between product and model: change review, replay against recorded traffic, and the rollback that saved a launch.',
			speakers: [{ name: 'Priya Nair', email: 'priya.nair@reviewlab.ai' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(55),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.92',
					family: 'quality',
					score: 0.92,
					rationale: 'Concrete versioning practice with replay evidence, matching the Evals & Reliability track brief.',
					source: 'Screen run #1'
				}
			],
			reviewCount: 0
		},
		{
			id: 'sub-204',
			title: 'Hands-on: Tracing an Agent Run in Anger',
			abstract:
				'A 90-minute lab tracing a deliberately unreliable agent across model, tool, and retrieval calls until the real failure becomes obvious.',
			speakers: [{ name: 'Tomás Rivera', email: 'tomas@queueless.dev' }],
			trackId: 'trk-infra',
			formatId: 'fmt-workshop',
			submittedAt: hoursAgo(49),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'equipment',
					label: 'Needs AV check',
					family: 'integrity',
					rationale: 'Lab asks for attendee laptops, a wired network, and a second screen for the profiler.',
					source: 'Form answers'
				}
			],
			reviewCount: 0
		},
		{
			id: 'sub-205',
			title: 'The Prompt Scaffold That Survived Three Model Upgrades',
			abstract:
				'Which instructions stayed stable across three model upgrades, which examples caused regressions, and how replay evals told us what to keep.',
			speakers: [{ name: 'Nora Visser', email: 'nora@tokenslab.nl' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(44),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-206',
			title: 'Evaluating Agents Without a Golden Dataset',
			abstract:
				'How we built usable evaluations before we had labels: adversarial pairs, human spot checks on a sampling budget, and the metrics we retired.',
			speakers: [{ name: 'Hana Sato', email: 'hana@streamcraft.jp' }],
			trackId: 'trk-ai',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(33),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-207',
			title: 'Boring Agent Deploys: Our Path to 40 Releases a Day',
			abstract:
				'The unglamorous work behind frequent agent releases — eval gates, model-profile rollouts, and the alerts we deleted to stop the noise.',
			speakers: [{ name: 'Ingrid Halvorsen', email: 'ingrid@nordicscale.no' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(28),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-208',
			title: 'Designing Agent Interfaces People Can Actually Trust',
			abstract:
				'Findings from 4,000 reviewed agent actions: what made people hesitate, which evidence earned trust, and the confirmations we removed entirely.',
			speakers: [{ name: 'Elif Aydın', email: 'elif@a11ycraft.eu' }],
			trackId: 'trk-web',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(1),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [],
			reviewCount: 0
		},
		{
			id: 'sub-209',
			title: 'Provisioning Secure Agent Sandboxes in 90 Seconds',
			abstract:
				'A walk through isolation, image caching, and capability grants that took secure agent sandbox startup from a coffee break to a sentence.',
			speakers: [{ name: 'Mikkel Sørensen', email: 'mikkel@boxfresh.dk' }],
			trackId: 'trk-infra',
			formatId: 'fmt-talk',
			submittedAt: hoursAgo(5),
			source: 'cfp',
			tray: 'inbox',
			decision: 'undecided',
			notified: false,
			signals: [
				{
					key: 'relevance',
					label: 'On-topic 0.81',
					family: 'quality',
					score: 0.81,
					rationale: 'Solid tooling story; overlaps the platform sub-theme rather than the infrastructure brief.',
					source: 'Screen run #1'
				}
			],
			reviewCount: 0
		}
	],
	submissionTrayTotals: { inbox: 9, 'set-aside': 0, late: 0, discarded: 0 },
	previousVisit: daysAgo(2),

	reviewPlans: [],
	/* Reviewers lined up ahead of the plan: both invitations are recorded and
	   neither has been consumed, so nobody has arrived and nothing is
	   assigned. Priya's invite carried an initial scope; Jonas defaults to
	   reviewing everything. */
	reviewers: [
		/* Jonas accepted straight away — one generalist ready, so the round can
		   open the moment the chair presses the button. */
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', status: 'active', scope: [] },
		{
			id: 'mem-4',
			name: 'Priya Nair',
			email: 'priya.nair@reviewlab.ai',
			status: 'invited',
			scope: [{ kind: 'track', id: 'trk-ai' }]
		}
	],
	myQueue: [],
	/* No review has been committed yet, so no track has a population to rank
	   inside. An empty seam states that; invented numbers would not. */
	reviewDistributions: {},

	speakers: [
		{
			id: 'spk-1',
			name: 'Ravi Chandran',
			email: 'ravi@keynote.example',
			state: 'invited',
			sessions: [{ id: 'ses-1', title: 'Opening Keynote: AI Engineering Beyond the Demo' }],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Invited by hand on Aug 9. Speaker tasks are created once the invitation is accepted.'
		},
		{
			id: 'spk-2',
			name: 'Nadia Farrow',
			email: 'nadia@farrowlabs.uk',
			state: 'invited',
			sessions: [],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			note: 'Asked to close day two. No session exists until she accepts.'
		}
	],

	taskDefs: [],
	assignments: [],

	schedule: {
		days: [
			{ key: 'day-1', label: 'Wed Mar 3' },
			{ key: 'day-2', label: 'Thu Mar 4' }
		],
		rooms: [
			{ id: 'room-main', name: 'Main Stage', capacity: 1000 },
			{ id: 'room-2a', name: 'Breakout Stage A', capacity: 240 },
			{ id: 'room-lab', name: 'Evals Lab', capacity: 80 }
		],
		dayStart: '09:00',
		slotMinutes: 30,
		slotsPerDay: 16,
		sessions: [
			{
				id: 'ses-1',
				title: 'Opening Keynote: AI Engineering Beyond the Demo',
				speakers: [{ name: 'Ravi Chandran', email: 'ravi@keynote.example' }],
				trackId: 'trk-web',
				formatId: 'fmt-talk',
				durationMin: 60,
				state: 'programmed'
			}
		],
		placements: [],
		breaks: [],
		published: false
	},

	communications: [
		{
			id: 'msg-1',
			subject: 'The AI Engineer London 2027 call for proposals is open',
			audience: 'Past speakers and newsletter',
			audienceCount: 412,
			state: 'sent',
			purpose: 'CFP announcement',
			cause: 'The call for proposals opened on Aug 7 — announced to past speakers and the newsletter',
			causeHref: '/app/forms',
			actor: 'you',
			sentAt: 'Aug 7, 09:00',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: []
		},
		/* A draft here is what makes the `action_required` delivery-report state
		   reachable at all: the note explaining what a missing report costs lives
		   in the send review, and a scenario with that readiness and no draft
		   would keep it unreviewable — which is exactly how the old blocked-render
		   count went unseen. Note the sent message above reports 0 delivered and
		   0 bounced: not knowing is precisely the consequence. */
		{
			id: 'msg-2',
			subject: 'Invitation to speak at AI Engineer London 2027',
			audience: 'Invited speakers',
			audienceCount: 2,
			state: 'draft',
			purpose: 'Speaker invitation',
			cause: '2 speakers were shortlisted for direct invitations before the CFP fills the program',
			causeHref: '/app/speakers',
			actor: 'you',
			templateId: 'tpl-speaker-invitation',
			deliveredCount: 0,
			bouncedCount: 0,
			bounces: [],
			review: {
				templateLabel: 'speaker-invite @ revision 1',
				audienceLabel: 'Invited, not yet contacted (current snapshot)',
				binding: 'current_snapshot',
				recipients: [
					{ name: 'Ravi Chandran', email: 'ravi@keynote.example', state: 'included', mergeSample: 'Invitation — “Opening Keynote: AI Engineering Beyond the Demo”' },
					{ name: 'Nadia Farrow', email: 'nadia@farrowlabs.uk', state: 'included', mergeSample: 'Invitation — closing slot, day two' }
				],
				sender: 'AI Engineer <program@aie-demo.example>',
				replyModel: 'Replies go to the organizer inbox',
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			}
		}
	],
	/* Ravi is a past speaker, so the CFP announcement reached him; his
	   invitation is still a draft, so nothing else has. Nadia has been sent
	   nothing at all — her tail states that explicitly. */
	threads: {
		'spk-1': [
			{
				id: 'thr-1-1',
				messageId: 'msg-1',
				at: 'Aug 7, 09:00',
				purpose: 'CFP announcement',
				subject: 'The AI Engineer London 2027 call for proposals is open',
				outcome: 'delivered',
				actor: 'you'
			}
		]
	},
	readiness: { provider: 'Resend', outbound: 'ready', callbacks: 'action_required', inbound: 'not_applicable' },

	templates: starterTemplates(),
	surfaces: starterSurfaceTemplates('AI Engineer London 2027'),
	fieldRegistry: baselineFieldRegistry(),
	theme: defaultEventTheme('AI Engineer London 2027'),

	forms: [
		{
			id: 'form-cfp',
			name: 'Call for Proposals',
			target: { kind: 'general' },
			status: 'open',
			closesAt: closesInDays(25),
			version: 1,
			submissionCount: 9
		}
	],

	settings: {
		name: 'AI Engineer London 2027',
		dates: 'Mar 3–4, 2027',
		startDate: '2027-03-03',
		endDate: '2027-03-04',
		location: 'London',
		timezone: 'Europe/London',
		venueNote: 'London venue — Main Stage, Breakout Stage A, Evals Lab. Contract signed, load-in times unconfirmed.'
	},
	members: [
		{ id: 'mem-1', name: 'Jere K.', email: 'jere@aie-demo.example', role: 'Workspace Admin', status: 'active' },
		{ id: 'mem-2', name: 'Linnea Koski', email: 'linnea@aie-demo.example', role: 'Speaker Manager', status: 'invited' },
		// The reviewer invitations: one member reservation each, consumed on
		// first sign-in — the reviewers roster holds the same two ids.
		{ id: 'mem-3', name: 'Jonas Weber', email: 'jonas.weber@metricsense.de', role: 'Speaker Reviewer', status: 'invited' },
		{ id: 'mem-4', name: 'Priya Nair', email: 'priya.nair@reviewlab.ai', role: 'Speaker Reviewer', status: 'invited' }
	]
};

export default opening;
